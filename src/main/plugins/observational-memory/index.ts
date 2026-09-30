import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompactionHook } from "./hooks/compaction-hook.js";
import { registerCompactionTrigger } from "./hooks/compaction-trigger.js";
import { registerConsolidationTrigger } from "./hooks/consolidation-trigger.js";
import { Runtime, registerMemoryRuntime } from "./runtime.js";
import { registerRecallTool } from "./tools/recall-observation.js";
import { memoryUI } from "../pig-ui.js";

export default function observationalMemory(pi: ExtensionAPI) {
	const runtime = new Runtime();

	registerConsolidationTrigger(pi, runtime);
	registerCompactionTrigger(pi, runtime);
	registerCompactionHook(pi, runtime);

	pi.on('session_start', (_event, ctx) => {
		runtime.notifications = memoryUI(ctx);
		registerMemoryRuntime(ctx.sessionManager.getSessionId(), runtime);
	});
	pi.on('session_shutdown', (_event, ctx) => {
		runtime.cancelConsolidation();
		runtime.notifications = undefined;
		registerMemoryRuntime(ctx.sessionManager.getSessionId());
	});
	registerRecallTool(pi);
}
