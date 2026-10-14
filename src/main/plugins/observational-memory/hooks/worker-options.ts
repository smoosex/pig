// Shared request options for background consolidation and synchronous compaction catch-up.
import type { ResolveResult, Runtime } from "../runtime.js";

type ResolvedModel = Extract<ResolveResult, { ok: true }>;

export function workerHeadersFor(
	ctx: { sessionManager: { getSessionId?: () => string } },
	resolved: ResolvedModel,
): ResolvedModel {
	// Console Go (opencode.ai) rejects requests without x-opencode-session
	// (400 MissingSessionID). Mirror pi's own session headers on worker calls.
	const model = (resolved.model ?? {}) as { provider?: string; baseUrl?: string };
	if (
		model.provider !== "opencode"
		&& model.provider !== "opencode-go"
		&& !(typeof model.baseUrl === "string" && model.baseUrl.includes("opencode.ai"))
	) {
		return resolved;
	}
	const sessionId = ctx.sessionManager.getSessionId?.();
	if (!sessionId) return resolved;
	return {
		...resolved,
		headers: {
			...(resolved.headers ?? {}),
			"x-opencode-session": sessionId,
			"x-opencode-client": "pi",
		},
	};
}

/** The fallback's own thinking setting wins when the fallback is active. */
export function workerThinkingLevel(runtime: Runtime, resolved: ResolvedModel) {
	if (resolved.fallbackUsed === true) {
		return runtime.config.fallbackModel?.thinking ?? runtime.config.model?.thinking ?? "low";
	}
	return runtime.config.model?.thinking ?? "low";
}
