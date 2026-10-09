import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { nestedCallsForEvent, type LiveNestedCalls } from '../src/renderer/src/chat/nested-tools'

test('live nested metadata is bounded by call count, argument bytes and error length', () => {
  let record: LiveNestedCalls | undefined
  for (let n = 0; n < 300; n++)
    record = nestedCallsForEvent(record, {
      type: 'tool_execution_start',
      toolCallId: `parent/${n}`,
      toolName: 'read',
      args: { path: 'file' }
    })
  assert.equal(record?.calls.length, 256)
  assert.equal(record?.complete, false)
  record = nestedCallsForEvent(record, {
    type: 'tool_execution_end',
    toolCallId: 'parent/0',
    toolName: 'read',
    isError: true,
    durationMs: 10,
    result: { content: [{ type: 'text', text: 'x'.repeat(1000) }] }
  })
  assert.equal(record?.calls[0].status, 'error')
  assert.equal(record?.calls[0].error?.length, 500)
  assert.equal(record?.calls[0].durationMs, 10)
  record = undefined
  for (let n = 0; n < 5; n++)
    record = nestedCallsForEvent(record, {
      type: 'tool_execution_start',
      toolCallId: `p/${n}`,
      toolName: 'write',
      args: { data: 'a'.repeat(7000) }
    })
  const data = record?.calls[3].arguments?.data
  assert.equal(typeof data === 'string' ? data.length : undefined, 7000)
  assert.equal(record?.calls[4].arguments, undefined)
  assert.ok(record?.calls[4].argumentsBytes! > 7000)
  assert.equal(record?.complete, false)
})
