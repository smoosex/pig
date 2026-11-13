/** Persist nested file-operation evidence as branch-local UI data, never model context. */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { compile, obj, oneOf, opt, str } from '@earendil-works/pi-schema'

export const FILE_CHANGE_ENTRY = 'pig-file-change-v1'
const recordSchema = compile(obj({
  toolCallId: str({ minLength: 1 }), parentToolCallId: str({ minLength: 1 }),
  tool: oneOf(['edit', 'write'] as const), path: str({ minLength: 1 }),
  patch: opt(str()), diff: opt(str())
}))

export function readFileChangeRecord(value: unknown) {
  if (!recordSchema.check(value)) {
    throw Object.assign(new Error('Invalid persisted file-change record'), { code: 'ERR_INVALID_FILE_CHANGE_RECORD' })
  }
  return value
}

/** A write records its output, not the file's unknown previous content. */
export function writtenPatch(path: string, content: string): string {
  const lines = content.split(/\r?\n/)
  const newline = lines.at(-1) === ''
  if (newline) lines.pop()
  const body = lines.map((line) => `+${line}`)
  if (!newline) body.push('\\ No newline at end of file')
  return [`--- /dev/null`, `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...body, ''].join('\n')
}

export function registerFileChangeRecorder(pi: ExtensionAPI): void {
  const calls = new Map<string, { rootId: string; input?: Record<string, unknown> }>()
  pi.on('tool_execution_start', event => {
    calls.set(event.toolCallId, {
      rootId: event.parentToolCallId ? calls.get(event.parentToolCallId)?.rootId ?? event.parentToolCallId : event.toolCallId
    })
  })
  pi.on('tool_result', event => {
    if (!event.parentToolCallId || (event.toolName !== 'edit' && event.toolName !== 'write')) return
    const call = calls.get(event.toolCallId)
    if (call) call.input = event.input
  })
  pi.on('tool_execution_end', event => {
    const call = calls.get(event.toolCallId)
    calls.delete(event.toolCallId)
    if (!event.parentToolCallId || event.isError || !call?.input || (event.toolName !== 'edit' && event.toolName !== 'write')) return
    const { path, content } = call.input
    if (typeof path !== 'string' || !path) return
    const details = event.result?.details
    // Observe the finalized result after every tool_result handler, including redaction hooks.
    const diff = typeof details?.patch === 'string' ? { patch: details.patch }
      : typeof details?.diff === 'string' ? { diff: details.diff }
      : event.toolName === 'write' && typeof content === 'string' ? { patch: writtenPatch(path, content) } : {}
    pi.appendEntry(FILE_CHANGE_ENTRY, {
      toolCallId: event.toolCallId, parentToolCallId: call.rootId, tool: event.toolName, path, ...diff
    })
  })
  pi.on('agent_settled', () => { calls.clear() })
  pi.on('session_shutdown', () => { calls.clear() })
}
