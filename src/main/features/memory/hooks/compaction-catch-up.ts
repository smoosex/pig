import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { ObserverStreamError, runObserver } from "../agents/observer/agent.js";
import { resolveObserverChunkMaxTokens, resolveWorkerMemoryMaxTokens } from "../config.js";
import { debugLog } from "../debug-log.js";
import type { ResolveResult, Runtime } from "../runtime.js";
import { serializeSourceAddressedBranchEntries } from "../serialize.js";
import { workerHeadersFor, workerThinkingLevel } from "./worker-options.js";
import {
	OM_OBSERVATIONS_RECORDED,
	boundWorkerMemory,
	buildObservationsRecordedData,
	fullProjection,
	isSourceEntry,
	latestCoverageIndex,
	observationToSummaryLine,
	reflectionToSummaryLine,
	type Entry,
	type UnobservedSourceSpan,
} from "../session-ledger/index.js";

export type CatchUpResult = {
	/** Observer chunks that recorded observations. */
	chunksRecorded: number;
	/** Why catch-up stopped before covering the whole gap, if it did. */
	stoppedBecause?: "max_chunks" | "empty" | "error" | "model_unavailable" | "aborted";
};

export type CatchUpArgs = {
	pi: ExtensionAPI;
	runtime: Runtime;
	ctx: ExtensionContext;
	entries: Entry[];
	gap: UnobservedSourceSpan;
	maxChunks: number;
	signal?: AbortSignal;
};

/**
 * Observe the unobserved source entries before Pi's proposed cut, one observer
 * chunk at a time, appending coverage as it goes. Runs inside
 * `session_before_compact`, where Pi waits for the hook and no session request
 * is in flight, so the memory model call does not compete with the session.
 * Each recorded chunk advances the observation frontier; the caller re-resolves
 * the cut afterwards. A chunk that yields no observations, fails, or hits the
 * chunk cap stops the catch-up and the remaining gap is handled as before
 * (retained or delegated). Nothing is ever appended for a failed chunk.
 */
export async function catchUpObserver(args: CatchUpArgs): Promise<CatchUpResult> {
	const { pi, runtime, ctx, entries, gap, maxChunks, signal } = args;
	const result: CatchUpResult = { chunksRecorded: 0 };
	if (maxChunks <= 0) return result;

	if (signal?.aborted) return { ...result, stoppedBecause: "aborted" };
	let resolved: ResolveResult;
	try {
		resolved = await runtime.resolveModel({
			model: ctx.model,
			modelRegistry: ctx.modelRegistry,
			signal,
		});
	} catch (error) {
		// Cancellation is a hook outcome; unexpected auth/registry failures propagate.
		if (signal?.aborted) return { ...result, stoppedBecause: "aborted" };
		throw new Error("Observational memory: catch-up model resolution failed", { cause: error });
	}
	if (signal?.aborted) return { ...result, stoppedBecause: "aborted" };
	if (!resolved.ok) {
		debugLog("compaction.catch_up.model_unavailable");
		return { ...result, stoppedBecause: "model_unavailable" };
	}

	let worker = workerHeadersFor(ctx, resolved);
	const branchChanged = () => {
		const current = ctx.sessionManager.getBranch() as Entry[];
		return !entries.every((entry, index) => current[index]?.id === entry.id);
	};
	// Start at the global observation frontier, not at the gap (which begins
	// at the retained-range start). A coverage marker claims everything before
	// it, so starting later would mark unread source between the frontier and
	// the range start as observed and the background observer would never
	// revisit it.
	const frontierIndex = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	let remaining = entries.slice(frontierIndex + 1, gap.lastIndex + 1).filter(isSourceEntry);
	let branch = entries;

	for (let chunkIndex = 0; chunkIndex < maxChunks && remaining.length > 0; chunkIndex++) {
		if (signal?.aborted || branchChanged()) return { ...result, stoppedBecause: "aborted" };

		const maxChunkTokens = resolveObserverChunkMaxTokens(runtime.config, (worker.model as { contextWindow?: number }).contextWindow);
		const { text: chunk, sourceEntryIds, estimatedTokens } = serializeSourceAddressedBranchEntries(remaining, { maxTokens: maxChunkTokens });
		const coversUpToId = sourceEntryIds.at(-1);
		if (!chunk.trim() || !coversUpToId) break;

		const fullMemory = fullProjection(branch);
		if (runtime.config.showWorkerNotifications) {
			runtime.notify(
				`Observational memory: observing ${sourceEntryIds.length} unobserved source entr${sourceEntryIds.length === 1 ? "y" : "ies"} (~${estimatedTokens.toLocaleString()} tokens) before compacting`,
				"info",
			);
		}
		debugLog("compaction.catch_up.chunk", { chunkIndex, sourceEntryCount: sourceEntryIds.length, estimatedTokens, coversUpToId });

		const observe = () => {
			const memory = boundWorkerMemory(fullMemory.reflections, fullMemory.observations,
				resolveWorkerMemoryMaxTokens(runtime.config, (worker.model as { contextWindow?: number }).contextWindow));
			return runObserver({
				model: worker.model as Parameters<typeof runObserver>[0]['model'],
				apiKey: worker.apiKey,
				headers: worker.headers,
				env: worker.env,
				priorReflections: memory.reflections.map(reflectionToSummaryLine),
				priorObservations: memory.observations.map(observationToSummaryLine),
				chunk,
				allowedSourceEntryIds: sourceEntryIds,
				signal,
				maxTurns: runtime.config.agentMaxTurns,
				maxOutputTokens: runtime.config.agentMaxTokens,
				thinkingLevel: workerThinkingLevel(runtime, worker),
				modelRegistry: ctx.modelRegistry as Parameters<typeof runObserver>[0]['modelRegistry'],
			});
		};
		let observations;
		try {
			try {
				observations = await observe();
			} catch (error) {
				if (signal?.aborted || branchChanged()) return { ...result, stoppedBecause: "aborted" };
				if (!(error instanceof ObserverStreamError) || !runtime.config.fallbackModel || worker.fallbackUsed) throw error;
				const fallback = await runtime.resolveFallbackModel({ model: ctx.model, modelRegistry: ctx.modelRegistry, signal });
				if (signal?.aborted || branchChanged()) return { ...result, stoppedBecause: "aborted" };
				if (!fallback.ok || estimatedTokens > resolveObserverChunkMaxTokens(runtime.config, (fallback.model as { contextWindow?: number }).contextWindow)) throw error;
				worker = workerHeadersFor(ctx, { ...fallback, fallbackUsed: true });
				observations = await observe();
			}
		} catch (error) {
			// Leave a failed chunk uncovered so Pi can retain or summarize its raw source.
			if (signal?.aborted || branchChanged()) return { ...result, stoppedBecause: "aborted" };
			debugLog("compaction.catch_up.error", { chunkIndex });
			runtime.notify("Observational memory: catch-up observer failed; leaving source uncovered", "warning");
			return { ...result, stoppedBecause: "error" };
		}

		if (signal?.aborted || branchChanged()) return { ...result, stoppedBecause: "aborted" };
		const data = observations && observations.length > 0 ? buildObservationsRecordedData(observations, coversUpToId) : undefined;
		if (!data) {
			debugLog("compaction.catch_up.empty", { chunkIndex, coversUpToId });
			return { ...result, stoppedBecause: "empty" };
		}

		pi.appendEntry(OM_OBSERVATIONS_RECORDED, data);
		result.chunksRecorded++;
		debugLog("compaction.catch_up.recorded", { chunkIndex, count: observations!.length, coversUpToId });

		// Coverage is positional: everything at or before the marker counts as
		// covered, including entries the serializer skipped for lack of
		// renderable content (e.g. an aborted assistant message).
		const coveredIndex = entries.findIndex((entry) => entry.id === coversUpToId);
		remaining = remaining.filter((entry) => entries.indexOf(entry) > coveredIndex);
		branch = (ctx.sessionManager?.getBranch?.() as Entry[] | undefined) ?? branch;
	}

	if (remaining.length > 0 && !result.stoppedBecause) result.stoppedBecause = "max_chunks";
	return result;
}
