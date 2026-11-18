import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple as compatStreamSimple } from "@earendil-works/pi-ai/compat";

export type WorkerStreamSimple = (
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/**
 * Duck-typed subset of Pi's extension ModelRegistry.
 *
 * `streamSimple` is the host-composed path (Pi #8964). Until that lands on the
 * facade, `getRegisteredProviderConfig` exposes each `registerProvider`
 * `streamSimple` handler by provider id. Use only the model's exact provider
 * and require matching API metadata as a consistency check.
 */
export type StreamableModelRegistry = {
	streamSimple?: WorkerStreamSimple;
	getRegisteredProviderConfig?: (providerId: string) => {
		api?: string;
		streamSimple?: WorkerStreamSimple;
	} | undefined;
};

/**
 * Resolve the stream function background workers must pass to `agentLoop`.
 *
 * Direct `@earendil-works/pi-ai/compat` `streamSimple` only knows built-in API
 * ids. Custom providers (`cursor-sdk`, `cliproxyapi-*`, commandcode, …) live on
 * Pi's composed runtime. Using compat after a successful foreground turn is
 * what crashes Pi with `No API provider registered for api: …` (#30).
 */
export function resolveWorkerStreamSimple(
	model: Model<any>,
	modelRegistry?: StreamableModelRegistry | null,
	override?: WorkerStreamSimple,
): WorkerStreamSimple {
	return (nextModel, context, options) => {
		try {
			return selectWorkerStream(model, modelRegistry, override)(nextModel, context, options);
		} catch {
			// Pi's detached agentLoop only closes its outer stream on fulfillment.
			const stream = createAssistantMessageEventStream();
			const reason = options?.signal?.aborted ? "aborted" : "error";
			const error: AssistantMessage = {
				role: "assistant", content: [], api: nextModel.api, provider: nextModel.provider, model: nextModel.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: reason, errorMessage: "Memory provider failed to start its stream", timestamp: Date.now(),
			};
			stream.push({ type: "error", reason, error });
			return stream;
		}
	};
}

function selectWorkerStream(
	model: Model<any>,
	modelRegistry?: StreamableModelRegistry | null,
	override?: WorkerStreamSimple,
): WorkerStreamSimple {
	if (override) return override;

	const registryStream = modelRegistry?.streamSimple;
	if (typeof registryStream === "function") {
		return (nextModel, context, options) => registryStream.call(modelRegistry, nextModel, context, options);
	}

	try {
		const config = modelRegistry?.getRegisteredProviderConfig?.(model.provider);
		const composed = config?.streamSimple;
		if (config?.api === model.api && typeof composed === "function") {
			return composed;
		}
	} catch {
		// Incomplete host/test doubles still use the built-in compat dispatcher.
	}

	return compatStreamSimple;
}
