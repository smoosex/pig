import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type SimpleStreamOptions } from '@earendil-works/pi-ai'
import { runSelf } from './helpers/subprocess'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pig-long-term-worker-'))
  const previous = process.env.PIG_DIR; process.env.PIG_DIR = root
  try {
    const { requestReviews } = await import('../src/main/features/memory/long-term/reviewer')
    const { abortable } = await import('../src/main/features/memory/long-term/extension')
    const { MemoryReviewError } = await import('../src/main/features/memory/long-term/review-errors')
    const model: Model<'openai-responses'> = { id: 'custom', provider: 'custom', name: 'Custom', api: 'openai-responses',
      baseUrl: 'https://unused.invalid', reasoning: true, input: ['text'], contextWindow: 128_000, maxTokens: 16_384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
    const calls: { context: Context; options?: SimpleStreamOptions; model: Model<any> }[] = []
    const id = 'a'.repeat(64)
    const candidate = { id, origin: { sessionId: 'source-session', sessionFile: '/session.jsonl', cwd: root }, reflectionId: 'b'.repeat(12),
      reflectionEntryId: 'reflection', reflectionRecordIndex: 0, content: '项目使用中文检索', recordedAt: '2026-11-06T00:00:00.000Z',
      evidence: [{ observationId: 'c'.repeat(12), observationEntryId: 'observation', observationRecordIndex: 0, sourceEntryIds: ['user'] }] }
    const inputs = [{ candidate, sources: [{ id: 'user', role: 'user', timestamp: candidate.recordedAt, text: '我们决定项目使用中文检索' }] }]
    const settings = { enabled: true, model: { provider: 'custom', id: 'custom', thinking: 'off' as const } }
    const access = { project: root, session: 'source-session' }
    let stop: AssistantMessage['stopReason'] = 'stop'
    let text = JSON.stringify({ reviews: [{ candidateId: id, action: 'skip', sourceEntryIds: [] }] })
    let hold = false
    let errorMessage: string | undefined
    const streams: ReturnType<typeof createAssistantMessageEventStream>[] = []
    const ctx = { cwd: root, model, sessionManager: { getSessionId: () => access.session }, modelRegistry: {
      find: () => model, hasConfiguredAuth: () => true,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'fixture', baseUrl: 'https://resolved.invalid' }),
      streamSimple: (model: Model<any>, context: Context, options?: SimpleStreamOptions) => {
        calls.push({ model, context, options })
        const stream = createAssistantMessageEventStream(); streams.push(stream)
        if (!hold) stream.end({ role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: 0,
          content: [{ type: 'text', text }], stopReason: stop, errorMessage,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } })
        return stream
      },
    } } as unknown as ExtensionContext
    let resolvedModel: { provider: string; id: string } | undefined
    const result = await requestReviews(ctx, settings, inputs, [], access, new AbortController().signal, value => { resolvedModel = value })
    assert.deepEqual(resolvedModel, { provider: 'custom', id: 'custom' })
    assert.equal(result[0]!.action, 'skip'); assert.equal(calls.length, 1)
    assert.equal(calls[0]!.options!.reasoning, undefined)
    assert.equal(calls[0]!.model.baseUrl, 'https://resolved.invalid')
    assert.equal(calls[0]!.context.tools, undefined, 'review has no tool access')
    await requestReviews(ctx, { ...settings, model: { ...settings.model, thinking: 'high' } }, inputs, [], access, new AbortController().signal)
    assert.equal(calls[1]!.options!.reasoning, 'high')
    const huge = [{ ...inputs[0]!, sources: [{ ...inputs[0]!.sources[0]!, text: '中文字'.repeat(20_000) }] }]
    await requestReviews(ctx, settings, huge, [], access, new AbortController().signal)
    const budgeted = calls.at(-1)!
    const body = String(budgeted.context.messages[0]!.content)
    assert.match(body, /context-budget excerpt/)
    assert.ok(Buffer.byteLength((budgeted.context.systemPrompt ?? '') + body) + budgeted.options!.maxTokens! <= 32_000)
    text = 'not JSON'
    await assert.rejects(requestReviews(ctx, settings, inputs, [], access, new AbortController().signal), /Invalid.*JSON/)
    text = JSON.stringify({ reviews: [{ candidateId: id, action: 'skip', sourceEntryIds: [] }] }); stop = 'length'
    await assert.rejects(requestReviews(ctx, settings, inputs, [], access, new AbortController().signal), /did not complete/)
    stop = 'error'; errorMessage = 'HTTP 401 SECRET-provider-payload'
    await assert.rejects(requestReviews(ctx, settings, inputs, [], access, new AbortController().signal),
      error => error instanceof MemoryReviewError && error.code === 'request' && !error.message.includes('SECRET'))
    errorMessage = 'SECRET-provider-payload'
    await assert.rejects(requestReviews(ctx, settings, inputs, [], access, new AbortController().signal),
      error => error instanceof MemoryReviewError && error.code === 'request' && !error.message.includes('SECRET'))
    hold = true
    const controller = new AbortController()
    const before = calls.length
    const pending = abortable(requestReviews(ctx, settings, inputs, [], access, controller.signal), controller.signal)
    const rejection = assert.rejects(pending, /cancelled/)
    while (calls.length <= before) await new Promise<void>(resolve => setImmediate(resolve))
    controller.abort(new Error('cancelled'))
    await rejection
    for (const stream of streams) stream.end()
  } finally {
    if (previous === undefined) delete process.env.PIG_DIR; else process.env.PIG_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
}
if (process.argv.includes('--fixture')) await fixture()
else test('admission uses authenticated composed streams, honours thinking, rejects truncated output and cancels without waiting for a provider', async () => {
  const { exitCode, stdout, stderr } = await runSelf(import.meta.path, ['--fixture'], { timeoutMs: 10_000 })
  assert.equal(exitCode, 0, stderr || stdout)
}, 15_000)
