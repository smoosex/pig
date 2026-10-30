/**
 * Pig subagent extension: registers `spawn` and delivers background results into its session.
 *
 * Child sessions are built by Pig's SubagentManager (see pig-subagent-host). Delivery must go through
 * `pi.sendMessage`, the only API that steers a running session or starts a turn in an idle one.
 * session_shutdown also fires on resource reloads, so it only detaches delivery; Pig itself aborts
 * children when the parent session is closed.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { subagentHost, type SubagentDelivery } from "../pig-subagent-host.js";
import {
	BACKGROUND_DESCRIPTION,
	PROMPT_DESCRIPTION,
	SPAWN_DESCRIPTION,
	SPAWN_GUIDELINES,
	SPAWN_SNIPPET,
	TITLE_DESCRIPTION,
} from "./prompts.js";

const RESULT_TYPE = "subagent-result";

export default function subagentExtension(pi: ExtensionAPI) {
	let parentTurnId: string | undefined;
	pi.on("agent_start", (_event, ctx) => {
		parentTurnId = ctx.sessionManager.getBranch().findLast(
			(entry) => entry.type === "message" && entry.message.role === "user",
		)?.id;
	});
	const deliver = (delivery: SubagentDelivery) => {
		pi.sendMessage(
			{ customType: RESULT_TYPE, content: delivery.text, display: true, details: delivery.details },
			{ triggerTurn: true, deliverAs: "steer" },
		);
	};

	pi.on("session_start", (_event, ctx) => {
		subagentHost()?.attach(ctx.sessionManager.getSessionId(), deliver);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		subagentHost()?.detach(ctx.sessionManager.getSessionId(), deliver);
	});

	pi.registerTool(defineTool({
		name: "subagent_restart",
		label: "Restart subagent",
		description: "Explicitly resume an unfinished, ended subagent of this session from its original transcript in the background. Check the previous failure and decide whether resuming is appropriate; never retry automatically. The result arrives through the usual background notification.",
		parameters: Type.Object({ id: Type.String({ description: "Subagent ID" }), instruction: Type.Optional(Type.String({ description: "Additional instruction for continuing" })) }),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const host = subagentHost();
			if (!host) throw new Error("Subagents are unavailable in this host");
			const outcome = await host.restart({ signal, parentSessionId: ctx.sessionManager.getSessionId(), id: params.id, cwd: ctx.cwd, instruction: params.instruction, parentModel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined, parentThinkingLevel: ctx.thinkingLevel });
			return { content: [{ type: "text", text: outcome.text }], details: { subagentId: outcome.id }, isError: outcome.isError };
		},
	}));

	pi.registerTool(
		defineTool({
			name: "spawn",
			label: "Spawn subagent",
			description: SPAWN_DESCRIPTION,
			promptSnippet: SPAWN_SNIPPET,
			promptGuidelines: SPAWN_GUIDELINES,
			executionMode: "parallel",
			parameters: Type.Object({
				title: Type.String({ description: TITLE_DESCRIPTION }),
				prompt: Type.String({ description: PROMPT_DESCRIPTION }),
				background: Type.Boolean({ description: BACKGROUND_DESCRIPTION }),
			}),
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const host = subagentHost();
				if (!host) throw new Error("Subagents are unavailable in this host");
				const outcome = await host.spawn({
					parentSessionId: ctx.sessionManager.getSessionId(),
					parentTurnId,
					parentSessionFile: ctx.sessionManager.getSessionFile(),
					toolCallId,
					cwd: ctx.cwd,
					title: params.title,
					prompt: params.prompt,
					background: params.background,
					parentModel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
					parentThinkingLevel: ctx.thinkingLevel,
					signal: params.background ? undefined : signal,
					onProgress: params.background
						? undefined
						: (activity) => onUpdate?.({ content: [{ type: "text", text: activity }], details: undefined }),
				});
				return {
					content: [{ type: "text", text: outcome.text }],
					details: { subagentId: outcome.id },
					isError: outcome.isError,
				};
			},
		}),
	);
}
