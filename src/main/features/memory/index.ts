import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompactionHook } from "./hooks/compaction-hook.js";
import { maybeTriggerCompaction, registerCompactionTrigger } from "./hooks/compaction-trigger.js";
import { registerConsolidationTrigger } from "./hooks/consolidation-trigger.js";
import { Runtime, registerMemoryRuntime } from "./runtime.js";
import { registerRecallTool } from "./tools/recall-observation.js";
import { memoryUI } from "../../plugins/pig-ui.js";
import { collectPersistedMemoryCandidates, type CandidateContext } from "./long-term/service.js";
import { registerLongTermMemory } from "./long-term/extension.js";

export default function observationalMemory(pi: ExtensionAPI) {
	const runtime = new Runtime();

	registerConsolidationTrigger(pi, runtime, {
		afterIdleConsolidation: (ctx) => maybeTriggerCompaction(runtime, ctx as Parameters<typeof maybeTriggerCompaction>[1]),
		afterReflectionsRecorded: collectPersistedMemoryCandidates,
	});
	registerCompactionTrigger(pi, runtime);
	registerCompactionHook(pi, runtime);

	pi.on('session_start', (_event, ctx) => {
		runtime.notifications = memoryUI(ctx);
		registerMemoryRuntime(ctx.sessionManager.getSessionId(), runtime);
	});
	const collectCandidates = (ctx: CandidateContext) => {
		try {
			collectPersistedMemoryCandidates(ctx);
		} catch {
			runtime.notify("Long-term memory: candidate collection failed; existing memory is unchanged", "warning");
		}
	};
	pi.on('session_start', (_event, ctx) => collectCandidates(ctx));
	pi.on('session_tree', (_event, ctx) => collectCandidates(ctx));
	pi.on('session_shutdown', (_event, ctx) => {
		runtime.cancelConsolidation();
		runtime.notifications = undefined;
		registerMemoryRuntime(ctx.sessionManager.getSessionId());
	});
	registerRecallTool(pi);
	registerLongTermMemory(pi, runtime);
}
