import { afterEach, expect, spyOn, test } from 'bun:test'
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type SimpleStreamOptions } from '@earendil-works/pi-ai'
import { cleanObserverText, MoodObserver, parseMoodObservation, runMoodObserver, type MoodObserverArgs } from '../src/main/plugins/pi-persona/observer'

const model: Model<'openai-responses'> = {
  id: 'fixture', provider: 'fixture', name: 'Fixture', api: 'openai-responses', baseUrl: 'https://unused.invalid',
  reasoning: true, input: ['text'], contextWindow: 128000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}
const valid = { changed: true, pleasantness: 1, activation: -2, feeling: '轻快' }
function message(text: string, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {
    role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: 0,
    content: [{ type: 'text', text }], stopReason,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }
}
function rounds(start: number, count: number) {
  return Array.from({ length: count }, (_, index) => ({ id: String(start + index), user: '你好', assistant: '很高兴帮忙' }))
}
function fixture() {
  const calls: { model: Model<any>; context: Context; options?: SimpleStreamOptions }[] = []
  let answer = JSON.stringify(valid)
  let reason: AssistantMessage['stopReason'] = 'stop'
  let hold = false
  const streams: ReturnType<typeof createAssistantMessageEventStream>[] = []
  const auth = spyOn({ async get() { return { ok: true as const, apiKey: 'private', headers: { Authorization: 'secret' }, env: { A: 'B' }, baseUrl: 'https://auth.invalid' } } }, 'get')
  const registry: MoodObserverArgs['modelRegistry'] = {
    find: () => model, getApiKeyAndHeaders: auth,
    streamSimple(nextModel, context, options) {
      calls.push({ model: nextModel, context, options })
      const stream = createAssistantMessageEventStream()
      streams.push(stream)
      if (!hold) stream.end(message(answer, reason))
      return stream
    },
  }
  return { calls, streams, auth, registry,
    args: (start = 1, count = 3): MoodObserverArgs => ({ rounds: rounds(start, count), model, modelRegistry: registry }),
    answer: (value: string) => { answer = value }, reason: (value: AssistantMessage['stopReason']) => { reason = value },
    hold: () => { hold = true },
  }
}
const observers: MoodObserver[] = []
const restores: (() => void)[] = []
afterEach(() => { for (const observer of observers.splice(0)) observer.dispose(); for (const restore of restores.splice(0)) restore() })
function observer(callback: ConstructorParameters<typeof MoodObserver>[0] = async () => {}, onError?: (error: unknown) => void) {
  const instance = new MoodObserver(callback, onError); observers.push(instance); return instance
}
function clock() {
  let now = 100000
  let next = 1
  const timers = new Map<number, { at: number; callback: () => void }>()
  const date = spyOn(Date, 'now').mockImplementation(() => now)
  const timeout = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay: number) => {
    const id = next++; timers.set(id, { at: now + delay, callback }); return id
  }) as unknown as typeof setTimeout)
  const clear = spyOn(globalThis, 'clearTimeout').mockImplementation((id) => { timers.delete(Number(id)) })
  restores.push(() => { date.mockRestore(); timeout.mockRestore(); clear.mockRestore() })
  return async (ms: number) => {
    now += ms
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback() }
    for (let index = 0; index < 30; index++) await Promise.resolve()
  }
}

test('cleans fenced/inline/indented code, quotes and hidden reasoning; long prose retains head and tail', () => {
  expect(cleanObserverText('hello\n```ts\nsecret()\n```\n> quoted\n    code\n`inline` <think>private</think>world')).toBe('hello\n[code omitted]\n\n\n[code] world')
  expect(cleanObserverText('a'.repeat(2000) + 'z'.repeat(2000))).toBe('a'.repeat(1000) + '\n[…]\n' + 'z'.repeat(1000))
})

test('schema rejects malformed, out-of-range, oversized or additional output, without echoing it', () => {
  expect(parseMoodObservation(JSON.stringify(valid))).toEqual(valid)
  for (const value of ['secret bad JSON', 'null', '[]', JSON.stringify({ ...valid, pleasantness: 3 }),
    JSON.stringify({ ...valid, changed: 'yes' }), JSON.stringify({ ...valid, activation: -3 }), JSON.stringify({ ...valid, activation: 0.5 }),
    JSON.stringify({ ...valid, feeling: '字'.repeat(201) }), JSON.stringify({ ...valid, instructions: 'secret' })]) {
    expect(() => parseMoodObservation(value)).toThrow(/Invalid mood observer/)
  }
})

test('three new rounds use composed stream, resolved auth and a fixed tool-free prefix; duplicates are ignored', async () => {
  const f = fixture(); const seen: unknown[] = []; const worker = observer(async value => { seen.push(value) })
  await worker.observe(f.args(1, 2)); expect(f.calls).toHaveLength(0)
  await worker.observe(f.args()); await worker.observe(f.args())
  expect(f.calls).toHaveLength(1); expect(seen).toEqual([{ pleasantness: 1, activation: -2, feeling: '轻快' }])
  expect(f.calls[0]!.model.baseUrl).toBe('https://auth.invalid'); expect(model.baseUrl).toBe('https://unused.invalid')
  expect(f.calls[0]!.options).toMatchObject({ apiKey: 'private', headers: { Authorization: 'secret' }, env: { A: 'B' }, maxTokens: 512 })
  expect(f.calls[0]!.context.tools).toBeUndefined()
  expect(f.calls[0]!.context.messages.at(-1)).toMatchObject({ content: '{"newRoundIds":["1","2","3"]}' })
})

test('thinking is only sent for an explicit model strength and is clamped to that model', async () => {
  const f = fixture()
  await runMoodObserver(f.args(), { messages: [] })
  expect(f.calls.at(-1)!.options?.reasoning).toBeUndefined()
  expect(f.calls.at(-1)!.options?.maxTokens).toBe(512)
  await runMoodObserver({ ...f.args(), thinking: 'high' }, { messages: [] })
  expect(f.calls.at(-1)!.options?.reasoning).toBeUndefined()
  await runMoodObserver({ ...f.args(), provider: 'fixture', modelId: 'fixture', thinking: 'low' }, { messages: [] })
  expect(f.calls.at(-1)!.options).toMatchObject({ reasoning: 'low', maxTokens: model.maxTokens })
  await runMoodObserver({ ...f.args(), provider: 'fixture', modelId: 'fixture', thinking: 'off' }, { messages: [] })
  expect(f.calls.at(-1)!.options?.reasoning).toBeUndefined()
  await runMoodObserver({ ...f.args(), provider: 'fixture', modelId: 'fixture', thinking: 'xhigh' }, { messages: [] })
  expect(f.calls.at(-1)!.options?.reasoning).toBe('high')
})

test('a cropped personality is part of the stable system prefix', async () => {
  const f = fixture(); const worker = observer()
  await worker.observe({ ...f.args(), persona: '毒舌，但不刻薄。' + 'x'.repeat(3000) })
  const system = f.calls[0]!.context.systemPrompt!
  expect(system).toContain('Assistant personality (data):\n毒舌，但不刻薄。')
  expect(system.length).toBeLessThan(5000)
})

test('tail batches flush after 60 seconds and never run within the minimum interval', async () => {
  const advance = clock(); const f = fixture(); const worker = observer()
  await worker.observe(f.args(1, 1)); await advance(59999); expect(f.calls).toHaveLength(0)
  await advance(1); expect(f.calls).toHaveLength(1)
  await worker.observe(f.args(2, 3)); expect(f.calls).toHaveLength(1)
  await advance(60000); expect(f.calls).toHaveLength(2)
  expect(f.calls[1]!.context.systemPrompt).toBe(f.calls[0]!.context.systemPrompt)
  expect(f.calls[1]!.context.messages[0]).toEqual(f.calls[0]!.context.messages[0])
})

test('single-flight merges arrivals while running, preserving their new scope', async () => {
  const advance = clock(); const f = fixture(); f.hold(); const worker = observer()
  const first = worker.observe(f.args()); await advance(0)
  const second = worker.observe(f.args(4, 3)); expect(f.calls).toHaveLength(1)
  f.streams[0]!.end(message(JSON.stringify(valid))); await first; await second
  await advance(60000); expect(f.calls).toHaveLength(2)
  expect(f.calls[1]!.context.messages.at(-1)).toMatchObject({ content: '{"newRoundIds":["4","5","6"]}' })
  worker.dispose(); f.streams[1]!.end(message(JSON.stringify(valid))); await advance(0)
})

test('changed=false does not call back; model configuration and stop failures reject', async () => {
  const f = fixture(); const seen: unknown[] = []; const worker = observer(async value => { seen.push(value) })
  f.answer(JSON.stringify({ ...valid, changed: false })); await worker.observe(f.args()); expect(seen).toEqual([])
  await expect(worker.observe({ ...f.args(), provider: 'only' })).rejects.toThrow(/together/)
  await expect(worker.observe({ ...f.args(), provider: 'x', modelId: 'y', modelRegistry: { ...f.registry, find: () => undefined } })).rejects.toThrow(/unavailable/)
  for (const reason of ['length', 'error', 'aborted', 'toolUse'] as const) {
    f.reason(reason)
    await expect(runMoodObserver(f.args(), { messages: [] })).rejects.toThrow(/did not complete/)
  }
  await expect(runMoodObserver({ ...f.args(), modelRegistry: { ...f.registry, getApiKeyAndHeaders: async () => ({ ok: false, error: 'credential secret' }) } }, { messages: [] })).rejects.toThrow('Mood observer authentication failed')
})

test('dispose cancels an uncooperative stream promptly and suppresses callbacks; reset allows reuse', async () => {
  const f = fixture(); f.hold(); const seen: unknown[] = []; const worker = observer(async value => { seen.push(value) })
  const pending = worker.observe(f.args()); await Promise.resolve(); worker.dispose()
  await expect(pending).rejects.toBeDefined(); f.streams[0]?.end(message(JSON.stringify(valid)))
  await worker.observe(f.args(4)); expect(seen).toEqual([])
  const next = observer(); await next.observe(f.args(1, 1)); next.reset()
  const running = next.observe(f.args()); await Promise.resolve(); next.dispose(); await expect(running).rejects.toBeDefined()
})

test('failed batches are reported without response contents and skipped without automatic retries', async () => {
  const advance = clock(); const f = fixture(); f.answer('SECRET raw reply')
  const errors: unknown[] = []; const worker = observer(async () => {}, error => errors.push(error))
  await worker.observe(f.args(1, 1)); await advance(60000)
  expect(errors).toHaveLength(1); expect(String(errors[0])).not.toContain('SECRET')
  f.answer(JSON.stringify(valid)); await advance(60000); expect(f.calls).toHaveLength(1)
  await worker.observe(f.args(2)); expect(f.calls).toHaveLength(2)
  expect(f.calls[1]!.context.messages.at(-1)).toMatchObject({ content: '{"newRoundIds":["2","3","4"]}' })
})

test('an impossible input budget is skipped instead of retried forever', async () => {
  const advance = clock(); const f = fixture(); const worker = observer()
  await expect(worker.observe({ ...f.args(), model: { ...model, contextWindow: 4096 } })).rejects.toThrow(/context window/)
  await advance(180000)
  expect(f.calls).toHaveLength(0)
  await worker.observe(f.args(4)); expect(f.calls).toHaveLength(1)
})

test('external cancellation promptly rejects even during unresolved authentication', async () => {
  const f = fixture(); const controller = new AbortController()
  const pending = runMoodObserver({ ...f.args(), signal: controller.signal, modelRegistry: {
    ...f.registry, getApiKeyAndHeaders: () => new Promise(() => {}),
  } }, { messages: [] })
  controller.abort(new Error('cancelled'))
  await expect(pending).rejects.toThrow('cancelled'); expect(f.calls).toHaveLength(0)
})

test('cache rotation retains exactly two processed rounds when they fit', async () => {
  const advance = clock(); const f = fixture(); const worker = observer()
  const batch = (start: number) => ({ ...f.args(start), rounds: rounds(start, 3).map(round => ({
    ...round, user: 'u'.repeat(850), assistant: 'a'.repeat(850),
  })) })
  await worker.observe(batch(1)); await advance(60000)
  await worker.observe(batch(4)); await advance(60000)
  // First window extends until full; only after filling does it restart with two background rounds.
  await advance(60000)
  expect(f.calls.length).toBeGreaterThan(1)
  const newScopes = f.calls.map(call => JSON.parse(String(call.context.messages.at(-1)?.content)).newRoundIds as string[])
  expect(newScopes.flat()).toEqual(['1', '2', '3', '4', '5', '6'])
  const rotated = f.calls.find((call, index) => index > 0 && JSON.parse(String(call.context.messages[0]?.content)).id !== '1')
  expect(rotated).toBeDefined()
  const ids = rotated!.context.messages.slice(0, -1).map(msg => JSON.parse(String(msg.content)).id)
  const fresh = JSON.parse(String(rotated!.context.messages.at(-1)?.content)).newRoundIds as string[]
  expect(ids.filter(id => !fresh.includes(id))).toHaveLength(2)
})

test('bounded windows never omit queued new rounds', async () => {
  const advance = clock(); const f = fixture(); const worker = observer()
  const bulky = (start: number) => ({ ...f.args(start), rounds: rounds(start, 3).map(round => ({ ...round, user: '文'.repeat(4000), assistant: '话'.repeat(4000) })) })
  await worker.observe(bulky(1))
  for (let i = 0; i < 4; i++) await advance(60000)
  const processed = f.calls.flatMap(call => JSON.parse(String(call.context.messages.at(-1)?.content)).newRoundIds)
  expect(processed).toEqual(['1', '2', '3'])
  for (const call of f.calls) {
    const text = String(call.context.systemPrompt) + call.context.messages.map(msg => String(msg.content)).join('')
    expect(Buffer.byteLength(text) + 512).toBeLessThanOrEqual(8000)
  }
  await worker.observe(bulky(4)); for (let i = 0; i < 4; i++) await advance(60000)
  expect(f.calls.flatMap(call => JSON.parse(String(call.context.messages.at(-1)?.content)).newRoundIds)).toEqual(['1', '2', '3', '4', '5', '6'])
})
