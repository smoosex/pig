/*
 * A memory worker whose model call fails ends its stream with a final assistant message
 * carrying stopReason "error"/"aborted" instead of throwing (see stream-errors.ts). Without
 * a retry signal the drain loop treats that exactly like "the model chose not to call the
 * tool", so the stage silently records nothing and the failure never reaches the pipeline.
 * These tests pin the distinction between "failed" and "deliberately empty".
 */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { Observation, Reflection } from '../src/main/plugins/observational-memory/session-ledger/types'
import { hashId } from '../src/main/plugins/observational-memory/ids'
import { estimateStringTokens } from '../src/main/plugins/observational-memory/tokens'
import { ReflectorStreamError, runReflector } from '../src/main/plugins/observational-memory/agents/reflector/agent'
import { DropperStreamError, runDropper } from '../src/main/plugins/observational-memory/agents/dropper/agent'

const observation: Observation = {
  id: 'aaaaaaaaaaaa', content: 'Remember the lifecycle requirements.', timestamp: '2026-01-01T00:00:00.000Z',
  relevance: 'medium', sourceEntryIds: ['source'], tokenCount: 20
}
const reflection: Reflection = {
  id: 'eeeeeeeeeeee', content: 'Respect session lifecycle.', supportingObservationIds: ['aaaaaaaaaaaa'], tokenCount: 10
}

type StreamEvent = { type: 'message_end'; message: { role: 'assistant'; stopReason: string; errorMessage?: string } }

/** Agent loop whose stream yields the given events; `onTurn` runs once per yielded event. */
function loopFrom(events: StreamEvent[], onTurn?: (context: any) => Promise<void>) {
  return ((_prompts: any[], context: any) => ({
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event
        await onTurn?.(context)
      }
    },
    result: async () => ({}),
  })) as any
}

const messageEnd = (stopReason: string, errorMessage?: string): StreamEvent =>
  ({ type: 'message_end', message: { role: 'assistant', stopReason, errorMessage } })
const cleanEnd = [messageEnd('endTurn')]
const toolTurnThenFailure = (errorMessage = 'rate limited') =>
  [messageEnd('toolUse'), messageEnd('error', errorMessage)]

const reflectorArgs = {
  model: { provider: 'test', maxTokens: 1000 } as any,
  reflections: [] as Reflection[],
  observations: [observation],
}
const dropperArgs = {
  model: { provider: 'test', maxTokens: 1000 } as any,
  reflections: [reflection],
  observations: [observation],
  targetTokens: 1,
}

for (const stopReason of ['error', 'aborted']) {
  test(`runReflector throws when the stream ${stopReason}s with no accepted reflections`, async () => {
    const loop = loopFrom([messageEnd(stopReason, 'rate limited')])
    const error = await runReflector({ ...reflectorArgs, agentLoop: loop }).then(() => undefined, (error: unknown) => error)
    assert.ok(error instanceof ReflectorStreamError, `expected ReflectorStreamError, got ${String(error)}`)
    assert.equal(error.stopReason, stopReason)
    assert.match(error.message, /rate limited/)
  })

  test(`runDropper throws when the stream ${stopReason}s with no selected drops`, async () => {
    const loop = loopFrom([messageEnd(stopReason, 'rate limited')])
    const error = await runDropper({ ...dropperArgs, agentLoop: loop }).then(() => undefined, (error: unknown) => error)
    assert.ok(error instanceof DropperStreamError, `expected DropperStreamError, got ${String(error)}`)
    assert.equal(error.stopReason, stopReason)
    assert.match(error.message, /rate limited/)
  })
}

test('runReflector keeps accepted reflections when a later stream turn fails', async () => {
  const content = 'User prefers source-backed memory.'
  const loop = loopFrom(toolTurnThenFailure(), async (context) => {
    await context.tools[0].execute('tool-1', { reflections: [{ content, supportingObservationIds: ['aaaaaaaaaaaa'] }] })
  })
  assert.deepEqual(await runReflector({ ...reflectorArgs, agentLoop: loop }), [
    { id: hashId(content), content, supportingObservationIds: ['aaaaaaaaaaaa'], tokenCount: estimateStringTokens(content) },
  ])
})

test('runDropper keeps safely selected drops when a later stream turn fails', async () => {
  const loop = loopFrom(toolTurnThenFailure(), async (context) => {
    await context.tools[0].execute('tool-1', { ids: ['aaaaaaaaaaaa'] })
  })
  assert.deepEqual(await runDropper({ ...dropperArgs, agentLoop: loop }), ['aaaaaaaaaaaa'])
})

test('a clean empty stream reports nothing instead of failing', async () => {
  assert.equal(await runReflector({ ...reflectorArgs, agentLoop: loopFrom(cleanEnd) }), undefined)
  assert.equal(await runDropper({ ...dropperArgs, agentLoop: loopFrom(cleanEnd) }), undefined)
})
