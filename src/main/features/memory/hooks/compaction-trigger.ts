import {
	estimateTokens,
	sessionEntryToContextMessages,
	type ExtensionAPI,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { resolveCompactAfterTokens, type Config } from "../config.js";
import {
	compactionRangeStartIndex,
	observedTokensSinceLastCompaction,
	rawTokensSinceLastCompaction,
	type Entry,
} from "../session-ledger/index.js";
import type { Runtime } from "../runtime.js";

export type CompactionProgressContext = {
	contextTokens?: number | null;
	contextWindow?: number;
};

/**
 * In `"ratio"` mode the threshold is `floor(contextWindow * ratio)`, i.e. a
 * fraction of the session model's real context window. Measure progress on the
 * same provider-reported context basis as the UI meter whenever both window and
 * post-compaction context usage are known; fall back to ledger estimates in
 * `"calibrated"` mode or right after a compaction before usage is reported.
 */
export function usesContextRatioProgress(
	config: Pick<Config, "compactAfterTokensMode">,
	context?: CompactionProgressContext,
): context is { contextTokens: number; contextWindow: number } {
	return config.compactAfterTokensMode === "ratio"
		&& typeof context?.contextWindow === "number"
		&& Number.isFinite(context.contextWindow)
		&& context.contextWindow > 0
		&& typeof context?.contextTokens === "number"
		&& Number.isFinite(context.contextTokens)
		&& context.contextTokens > 0;
}

/**
 * Tokens counted toward the proactive threshold:
 * - `"ratio"` mode with live context usage: real session context tokens.
 * - Otherwise (`"calibrated"` mode or unknown context usage): observed source
 *   tokens when Pi's automatic compaction backstop is enabled, or raw source
 *   tokens when Pi's automatic compaction is disabled.
 */
export function compactionProgress(runtime: Runtime, entries: Entry[], context?: CompactionProgressContext): number {
	if (usesContextRatioProgress(runtime.config, context)) {
		return context.contextTokens;
	}
	return runtime.config.piAutoCompactionEnabled === false
		? rawTokensSinceLastCompaction(entries)
		: observedTokensSinceLastCompaction(entries);
}

export function progressLabel(runtime: Runtime, context?: CompactionProgressContext): "context" | "observed" | "estimated" {
	if (usesContextRatioProgress(runtime.config, context)) return "context";
	return runtime.config.piAutoCompactionEnabled === false ? "estimated" : "observed";
}

const CUT_POINT_ROLES = new Set(["user", "assistant", "bashExecution", "custom", "branchSummary", "compactionSummary"]);

function safeEntryMessages(entry: Entry): ReturnType<typeof sessionEntryToContextMessages> {
	try {
		return sessionEntryToContextMessages(entry as unknown as SessionEntry);
	} catch {
		return [];
	}
}

/**
 * Mirrors Pi's `prepareCompaction` cut preflight so ratio-mode proactive
 * compaction does not invoke `ctx.compact()` when system prompts / tool schemas
 * push context usage past the ratio while message history is still inside
 * `keepRecentTokens` (which would make `AgentSession.compact()` throw
 * `"Nothing to compact (session too small)"`).
 */
export function hasCompactableEntries(entries: Entry[], keepRecentTokens: number): boolean {
	if (entries.length === 0 || entries[entries.length - 1]?.type === "compaction") return false;
	const startIndex = compactionRangeStartIndex(entries);
	const cutPoints: number[] = [];
	const projectedMessages: Array<ReturnType<typeof sessionEntryToContextMessages>> = [];
	for (let i = startIndex; i < entries.length; i++) {
		const entry = entries[i];
		const messages = entry.type === "compaction" ? [] : safeEntryMessages(entry);
		projectedMessages.push(messages);
		if (entry.type !== "compaction" && messages.some((m) => CUT_POINT_ROLES.has(m.role))) {
			cutPoints.push(i - startIndex);
		}
	}
	if (cutPoints.length === 0) return false;
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0];
	for (let i = projectedMessages.length - 1; i >= 0; i--) {
		const messageTokens = projectedMessages[i].reduce((sum, message) => sum + estimateTokens(message), 0);
		if (messageTokens === 0) continue;
		accumulatedTokens += messageTokens;
		if (accumulatedTokens >= keepRecentTokens) {
			cutIndex = cutPoints.find((candidate) => candidate >= i) ?? cutPoints[cutPoints.length - 1];
			break;
		}
	}
	return projectedMessages
		.slice(0, cutIndex)
		.some((messages) => messages.some((m) => m.role !== "system"));
}

function realContextTokens(ctx: { getContextUsage?: () => { tokens?: number | null } | undefined }): number | undefined {
	const tokens = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage()?.tokens : undefined;
	return typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0 ? tokens : undefined;
}

type CompactionTriggerCtx = Parameters<Parameters<ExtensionAPI["on"]>[1]>[1];

export function registerCompactionTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	// Pi emits agent_settled only after retries, automatic compaction, and queued
	// continuation have finished, so retry policy stays owned by Pi.
	pi.on("agent_settled", (_event, ctx) => maybeTriggerCompaction(runtime, ctx));
	pi.on("session_compact_failed", (event) => {
		if (runtime.compactInFlight && event.reason === "manual") runtime.proactiveCompactionAborted = event.aborted;
	});
}

/**
 * Trigger proactive compaction when the configured threshold is reached and Pi
 * is idle. Also called after any background consolidation run finishes while
 * idle, so compaction waits for in-flight observer coverage instead of racing
 * or missing the newly recorded observations.
 */
export function maybeTriggerCompaction(runtime: Runtime, ctx: CompactionTriggerCtx): void {
	runtime.ensureConfig(ctx.cwd);
	if (runtime.config.passive) return;
	if (runtime.compactInFlight) return;
	if (runtime.consolidationInFlight) return;
	if (typeof ctx.isIdle === "function" && !ctx.isIdle()) return;

	const entries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
	if (!entries || entries.length === 0 || entries[entries.length - 1]?.type === "compaction") return;
	if (runtime.lastFailedCompactionLeafId !== undefined && entries[entries.length - 1]?.id === runtime.lastFailedCompactionLeafId) return;

	const progressCtx: CompactionProgressContext = {
		contextTokens: realContextTokens(ctx),
		contextWindow: ctx.model?.contextWindow,
	};
	const progress = compactionProgress(runtime, entries, progressCtx);
	const threshold = resolveCompactAfterTokens(runtime.config, ctx.model?.contextWindow);
	if (progress < threshold) return;
	if (usesContextRatioProgress(runtime.config, progressCtx) && !hasCompactableEntries(entries, runtime.config.piKeepRecentTokens)) {
		return;
	}

	// Shutdown clears the session notifier before deferred work may touch a stale ctx.
	const notifications = runtime.notifications;
	const showNotifications = runtime.config.showCompactionNotifications;
	const label = progressLabel(runtime, progressCtx);
	const unit = label === "context" ? "context tokens" : `${label} source tokens`;

	if (showNotifications) notifications?.notify(
		`Observational memory: compaction threshold reached (~${progress.toLocaleString()} ${unit}); triggering compaction`,
		"info",
	);

	const branchRevision = runtime.branchRevision;
	runtime.compactInFlight = true;
	runtime.proactiveCompactionAborted = false;
	setTimeout(() => {
		if (runtime.notifications !== notifications || runtime.branchRevision !== branchRevision) {
			runtime.compactInFlight = false;
			return;
		}
		try {
			if (runtime.consolidationInFlight) {
				runtime.compactInFlight = false;
				return;
			}
			if (!ctx.isIdle()) {
				runtime.compactInFlight = false;
				if (showNotifications) notifications?.notify(
					"Observational memory: compaction deferred — agent became busy before compaction",
					"info",
				);
				return;
			}
			const currentEntries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
			if (!currentEntries || currentEntries.length === 0 || currentEntries[currentEntries.length - 1]?.type === "compaction") {
				runtime.compactInFlight = false;
				return;
			}
			const currentProgressCtx: CompactionProgressContext = {
				contextTokens: realContextTokens(ctx),
				contextWindow: ctx.model?.contextWindow,
			};
			const currentThreshold = resolveCompactAfterTokens(runtime.config, ctx.model?.contextWindow);
			const currentProgress = compactionProgress(runtime, currentEntries, currentProgressCtx);
			if (currentProgress < currentThreshold) {
				runtime.compactInFlight = false;
				if (showNotifications) notifications?.notify(
					"Observational memory: compaction skipped — another compaction already ran before deferred compaction",
					"info",
				);
				return;
			}
			if (usesContextRatioProgress(runtime.config, currentProgressCtx) && !hasCompactableEntries(currentEntries, runtime.config.piKeepRecentTokens)) {
				runtime.compactInFlight = false;
				return;
			}
			const leafIdAtStart = currentEntries[currentEntries.length - 1]?.id;
			runtime.proactiveCompactionRunning = true;
			ctx.compact({
				onComplete: () => {
					runtime.proactiveCompactionRunning = false;
					runtime.compactInFlight = false;
					runtime.lastFailedCompactionLeafId = undefined;
					if (runtime.notifications === notifications && showNotifications) notifications?.notify("Observational memory: compaction complete", "info");
				},
				onError: (error: { message: string }) => {
					runtime.proactiveCompactionRunning = false;
					runtime.compactInFlight = false;
					if (runtime.proactiveCompactionAborted) return;
					runtime.lastFailedCompactionLeafId = leafIdAtStart;
					if (runtime.notifications === notifications) notifications?.notify(`Observational memory: ${error.message}`, "error");
				},
			});
		} catch (error) {
			runtime.proactiveCompactionRunning = false;
			runtime.compactInFlight = false;
			const msg = error instanceof Error ? error.message : String(error);
			if (runtime.notifications === notifications) notifications?.notify(`Observational memory: compact threw: ${msg}`, "error");
		}
	}, 0);
}
