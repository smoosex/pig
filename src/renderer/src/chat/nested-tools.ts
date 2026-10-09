/** Nested calls are bounded tool metadata, never independent messages or result bodies. */
import type { NestedToolCallRecord, NestedToolCalls } from '@earendil-works/pi-ai'
import type { PiSessionEvent, ToolPartialResult } from '../pi/types'

export type LiveNestedCall = Omit<NestedToolCallRecord, 'status'> & {
  status: NestedToolCallRecord['status'] | 'running'
}
export interface LiveNestedCalls extends Omit<NestedToolCalls, 'calls'> {
  calls: LiveNestedCall[]
  argumentBytesTotal?: number
}
const encoder = new TextEncoder()
export function nestedCallsForEvent(
  previous: LiveNestedCalls | undefined,
  event: PiSessionEvent
): LiveNestedCalls | undefined {
  if (typeof event.toolCallId !== 'string' || typeof event.toolName !== 'string') return previous
  const calls = [...(previous?.calls ?? [])]
  const index = calls.findIndex((call) => call.id === event.toolCallId)
  if (index < 0 && calls.length >= 256) return { ...previous!, calls, complete: false }
  const call: LiveNestedCall =
    index >= 0
      ? { ...calls[index] }
      : { id: event.toolCallId, name: event.toolName, status: 'running' }
  let complete = previous?.complete ?? true
  let argumentBytesTotal = previous?.argumentBytesTotal ?? 0
  if (index < 0 && event.args && typeof event.args === 'object' && !Array.isArray(event.args)) {
    const bytes = encoder.encode(JSON.stringify(event.args)).length
    if (bytes > 8192 || argumentBytesTotal + bytes > 32768) {
      call.argumentsBytes = bytes
      complete = false
    } else {
      call.arguments = event.args as NestedToolCallRecord['arguments']
      argumentBytesTotal += bytes
    }
  } else if (index < 0) complete = false
  if (event.type === 'tool_execution_end') {
    call.status = event.isError ? 'error' : 'ok'
    if (typeof event.durationMs === 'number') call.durationMs = event.durationMs
    const result = event.result as ToolPartialResult | undefined
    if (event.isError && Array.isArray(result?.content)) {
      call.error = result.content
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('\n')
        .slice(0, 500)
    }
  }
  if (index < 0) calls.push(call)
  else calls[index] = call
  return { calls, complete, argumentBytesTotal }
}
