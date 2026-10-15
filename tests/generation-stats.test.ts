import { describe, expect, test } from 'bun:test'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { GenerationSampler } from '../src/main/pi/generation-stats'

type Delta = [at: number, kind: 'text_delta' | 'thinking_delta' | 'toolcall_delta', text: string]

function reply(output = 100, reasoning?: number, patch: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant', timestamp: 10, api: 'openai-responses', provider: 'test', model: 'test',
    stopReason: 'stop', content: [{ type: 'text', text: 'answer' }],
    usage: {
      input: 10, output, reasoning, cacheRead: 0, cacheWrite: 0, totalTokens: output + 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    ...patch
  }
}

function sample(deltas: Delta[], endedAt: number, message = reply()) {
  const sampler = new GenerationSampler()
  for (const [at, kind, text] of deltas) sampler.record(kind, text, at)
  return sampler.finish(message, endedAt)
}

function unmeasured() {
  return { outputTokens: 0, durationMs: 0, measuredCalls: 0, totalCalls: 1, models: [] }
}

function measured(outputTokens: number, durationMs: number) {
  return { outputTokens, durationMs, measuredCalls: 1, totalCalls: 1, models: ['test/test'] }
}

const text: Delta[] = [[0, 'text_delta', 'first'], [500, 'text_delta', 'last']]

describe('generation sampling', () => {
  test('times through response completion, excluding the wait before its first content', () => {
    expect(sample([[10_000, 'text_delta', 'first'], [10_500, 'text_delta', 'last']], 10_600))
      .toEqual(measured(100, 600))
  })

  test('excludes hidden reasoning tokens and their time together', () => {
    const answer: Delta[] = [
      [14_000, 'text_delta', 'a'.repeat(100)],
      [14_750, 'text_delta', 'b'.repeat(100)],
      [15_500, 'text_delta', 'c'.repeat(100)]
    ]
    expect(sample(answer, 15_500, reply(2200, 2000))).toEqual(measured(200, 1500))
    expect(sample([[13_990, 'thinking_delta', 'summary'], ...answer], 15_500, reply(2200, 2000)))
      .toEqual(measured(200, 1500))
  })

  test('starts the answer flow after thinking even when both arrive in the same millisecond', () => {
    expect(sample([
      [1000, 'thinking_delta', 'summary'.repeat(1000)],
      [1000, 'text_delta', 'first'],
      [2000, 'text_delta', 'last']
    ], 2000, reply(1100, 1000))).toEqual(measured(100, 1000))
  })

  test('keeps a paced answer after visible thinking', () => {
    expect(sample([
      [0, 'thinking_delta', 'thought'], [1000, 'thinking_delta', 'thought'],
      [2000, 'text_delta', 'a'.repeat(100)], [4500, 'text_delta', 'b'.repeat(100)],
      [7000, 'text_delta', 'c'.repeat(100)], [9500, 'text_delta', 'd'.repeat(100)],
      [12_000, 'text_delta', 'e'.repeat(100)]
    ], 12_000, reply(600, 100))).toEqual(measured(500, 10_000))
  })

  test.each(['streamed', 'hidden'] as const)('rejects text/reasoning/text replies with %s reasoning', (kind) => {
    const deltas: Delta[] = [
      [0, 'text_delta', 'commentary'], [500, 'text_delta', 'commentary'],
      ...(kind === 'streamed' ? [
        [1000, 'thinking_delta', 'thought'], [10_000, 'thinking_delta', 'thought']
      ] satisfies Delta[] : []),
      [10_500, 'text_delta', 'answer'], [11_000, 'text_delta', 'answer']
    ]
    expect(sample(deltas, 11_000, reply(1200, 1000, {
      api: 'openai-codex-responses',
      content: [
        { type: 'text', text: 'commentary' },
        { type: 'thinking', thinking: kind === 'hidden' ? '' : 'thought' },
        { type: 'text', text: 'answer' }
      ]
    }))).toEqual(unmeasured())
  })

  test.each([
    { name: 'one chunk', deltas: [[0, 'text_delta', 'all at once']] as Delta[], end: 2000 },
    { name: 'large first chunk', deltas: [[0, 'text_delta', 'a'.repeat(990)], [2000, 'text_delta', 'b'.repeat(10)]] as Delta[], end: 2000 },
    {
      name: 'held after early text',
      deltas: [[0, 'text_delta', 'a'.repeat(10)], [10_000, 'text_delta', 'b'.repeat(495)], [10_200, 'text_delta', 'c'.repeat(495)]] as Delta[],
      end: 10_200
    }
  ])('rejects buffered delivery: $name', ({ deltas, end }) => {
    expect(sample(deltas, end)).toEqual(unmeasured())
  })

  test('rejects a burst whose first text arrived with the held answer', () => {
    expect(sample([
      [5200, 'thinking_delta', 'first thought'], [5300, 'thinking_delta', 'last thought'],
      [15_764, 'text_delta', 'a'.repeat(176)], [15_882, 'text_delta', 'b'.repeat(176)],
      [16_000, 'text_delta', 'c'.repeat(176)]
    ], 16_000, reply(550, 22))).toEqual(unmeasured())
  })

  test('times streamed tool arguments when there was no reasoning', () => {
    expect(sample([
      [1000, 'toolcall_delta', '{"code":"'], [2000, 'toolcall_delta', 'return 1"}']
    ], 2000, reply(100, 0, { stopReason: 'toolUse', content: [] }))).toEqual(measured(100, 1000))
  })

  test('requires paced, unredacted reasoning for a reasoning-only tool reply', () => {
    const deltas: Delta[] = [
      [0, 'thinking_delta', 'first thought'], [1000, 'thinking_delta', 'last thought'],
      [2000, 'toolcall_delta', '{"path":'], [3000, 'toolcall_delta', '"file"}']
    ]
    const visible = reply(1500, 1400, {
      api: 'anthropic-messages', stopReason: 'toolUse', content: [{ type: 'thinking', thinking: 'full thought' }]
    })
    expect(sample(deltas, 3000, visible)).toEqual(measured(1500, 3000))
    expect(sample(deltas, 3000, { ...visible, api: 'openai-responses' })).toEqual(unmeasured())
    expect(sample(deltas, 3000, { ...visible, api: 'google-generative-ai' })).toEqual(unmeasured())
    expect(sample(deltas, 3000, {
      ...visible, content: [{ type: 'thinking', thinking: '[Reasoning redacted]', redacted: true }]
    })).toEqual(unmeasured())
  })

  test('does not guess answer tokens when the reasoning breakdown is missing', () => {
    expect(sample([
      [0, 'thinking_delta', 'thought'], [500, 'thinking_delta', 'thought'],
      [1000, 'text_delta', 'first'], [1500, 'text_delta', 'last']
    ], 1500, reply(100, undefined, { api: 'anthropic-messages' }))).toEqual(unmeasured())
    expect(sample(text, 500, reply(100, undefined, {
      content: [{ type: 'thinking', thinking: '', redacted: true }, { type: 'text', text: 'answer' }]
    }))).toEqual(unmeasured())
  })

  test('does not assign arguments written before the first text to its shorter window', () => {
    expect(sample([
      [0, 'thinking_delta', 'thought'], [500, 'toolcall_delta', '{"path":"file"}'],
      [1000, 'text_delta', 'first'], [1500, 'text_delta', 'last']
    ], 1500, reply(500, 100))).toEqual(unmeasured())
  })

  test.each(['error', 'aborted', 'pending', 'deferred'] as const)('leaves %s calls out of the measured speed', (stopReason) => {
    expect(sample(text, 500, reply(100, 0, { stopReason }))).toEqual(unmeasured())
  })

  test('leaves non-streamed and invalid token samples out of the speed', () => {
    expect(sample([], 1000)).toEqual(unmeasured())
    const unknownEnd = new GenerationSampler()
    for (const [at, kind, delta] of text) unknownEnd.record(kind, delta, at)
    expect(unknownEnd.finish(reply(), undefined)).toEqual(unmeasured())
    expect(sample(text, 500, reply(0))).toEqual(unmeasured())
    expect(sample(text, 500, reply(Infinity))).toEqual(unmeasured())
    expect(sample(text, 500, reply(100, 101))).toEqual(unmeasured())
  })
})
