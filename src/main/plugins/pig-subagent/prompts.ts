/** Model-facing text of the spawn tool. Snippet and guidelines are sent with every request; keep them short. */

export const SPAWN_SNIPPET =
  'spawn: Delegate a self-contained task to a subagent with a fresh context, in the foreground (wait for its result) or background (keep working; result delivered later).'

export const SPAWN_GUIDELINES = [
  "Use spawn when a task is self-contained and would flood your context with exploration, logs, or search results you don't need to keep, or when independent tasks can run in parallel.",
  'Do not spawn for tasks you can finish in a few tool calls; delegation costs a full new context and adds latency.',
  'A subagent sees nothing of this conversation. Its prompt must state the goal, relevant paths and constraints, what is already known, and exactly what the final report should contain.',
  'Use background: true only when you have other useful work to do meanwhile. If you would just wait for the result, use background: false.',
  'Subagents share your working directory. Background subagents are best for read-only work (research, review, running tests). Never let two agents, including yourself, edit the same file concurrently.',
  'Background results arrive automatically as a subagent-result message. Never guess or fabricate a pending result. If nothing else remains, briefly say what you are waiting for and end your turn.'
]

export const SPAWN_DESCRIPTION = `Run a subagent on a self-contained task. The subagent starts with a fresh context (it cannot see this conversation), uses the same model settings, tools, and working directory as you, and cannot ask questions or spawn further subagents.

Returns the subagent's final message as its report, with status (completed / failed / timeout / turn_limit / aborted / interrupted), turns, duration, and tokens. Long reports are truncated with a path to the full transcript, which you can read.

background: false blocks until the subagent finishes and returns the report as this tool's result. Several foreground spawns in one message run in parallel.
background: true returns immediately with an id; the report arrives later as a subagent-result message. Excess background subagents are queued.`

export const TITLE_DESCRIPTION = 'Short label shown to the user, 3-8 words, e.g. "Map IPC contract usages".'
export const PROMPT_DESCRIPTION =
  'Complete, self-contained instructions. Include goal, relevant files, constraints, and the expected shape of the final report.'
export const BACKGROUND_DESCRIPTION = 'true to keep working while it runs; false to wait for its result.'

/** Appended to every child's system prompt. */
export const SUBAGENT_SYSTEM_PROMPT = `You are a subagent, delegated one task by a parent agent. No human is available.
- You cannot ask questions. When something is ambiguous, make a reasonable assumption, continue, and list your assumptions in the final report.
- Your final message is your deliverable and is returned verbatim to the parent. Make it a complete, self-contained report, not a plan or a progress note.
- Do only what the task requires. Do not modify files outside its scope; list every file you changed in the final report.
- Other agents may be working in the same directory. If a file's contents differ from what you expect, re-read it instead of overwriting it.`
