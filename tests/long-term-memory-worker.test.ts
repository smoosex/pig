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
    const { extractLearning } = await import('../src/main/features/memory/long-term/learning')
    const { rawWindow } = await import('./helpers/long-term-memory')
    const { selectMemories } = await import('../src/main/features/memory/long-term/relevance')
    const { abortable } = await import('../src/main/features/memory/long-term/extension')
    const { MemoryReviewError } = await import('../src/main/features/memory/long-term/review-errors')
    const model: Model<'openai-responses'> = { id: 'custom', provider: 'custom', name: 'Custom', api: 'openai-responses',
      baseUrl: 'https://unused.invalid', reasoning: true, input: ['text'], contextWindow: 128_000, maxTokens: 16_384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
    const calls: { context: Context; options?: SimpleStreamOptions; model: Model<any> }[] = []
    const id = 'a'.repeat(64)
    const window = rawWindow(root)
    const settings = { enabled: true, model: { provider: 'custom', id: 'custom', thinking: 'off' as const } }
    const access = { project: root, session: 'source-session' }
    let stop: AssistantMessage['stopReason'] = 'stop'
    let text = JSON.stringify({ episodes: [] })
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
    const result = await extractLearning(ctx, settings, window, [], new AbortController().signal)
    assert.deepEqual(result.episodes, []); assert.equal(calls.length, 1)
    assert.equal(calls[0]!.options!.reasoning, undefined)
    assert.equal(calls[0]!.model.baseUrl, 'https://resolved.invalid')
    assert.equal(calls[0]!.context.tools, undefined, 'review has no tool access')
    await extractLearning(ctx, { ...settings, model: { ...settings.model, thinking: 'high' } }, window, [], new AbortController().signal)
    assert.equal(calls[1]!.options!.reasoning, 'high')
    const huge = { ...window, sources: window.sources.map(source => ({ ...source, text: '中文字'.repeat(20_000) })) }
    await assert.rejects(extractLearning(ctx, settings, huge, [], new AbortController().signal), /budget/)
    const facts = [{ id, content: 'Pig embeds pi; no global CLI is required.', kind: 'knowledge' as const,
      scope: 'project' as const, scopeKey: root, projectKey: root, checkoutKey: '', applicability: 'Pig installation', status: 'active' as const, assertion: 'user-statement' as const,
      sourceTime: window.sources[0]!.ref.timestamp, createdAt: window.sources[0]!.ref.timestamp, updatedAt: window.sources[0]!.ref.timestamp }]
    const question = { availableContext: ['The visible conversation already establishes the current project.'], question: '是否需要本地有 pi？' + '完整问题'.repeat(600),
      recentExchanges: [{ user: 'Pig 的安装依赖是什么？', assistant: '正在讨论安装方式。' }] }
    text = JSON.stringify({ selectedIds: [id] })
    assert.deepEqual(await selectMemories(ctx, settings, question, facts, new AbortController().signal), facts)
    const selection = calls.at(-1)!
    assert.equal(selection.model.baseUrl, 'https://resolved.invalid')
    assert.equal(selection.options!.reasoning, undefined)
    assert.equal(selection.context.tools, undefined)
    const selectionPayload = JSON.parse(String(selection.context.messages[0]!.content))
    assert.equal(selectionPayload.question, question.question, 'the full current question reaches the selector')
    assert.deepEqual(selectionPayload.recentExchanges, question.recentExchanges)
    assert.deepEqual(selectionPayload.availableContext, question.availableContext)
    assert.equal(selectionPayload.memories[0].applicability, facts[0]!.applicability)
    assert.equal(selectionPayload.memories[0].scopeKey, undefined)
    const callCount = calls.length
    assert.deepEqual(await selectMemories(ctx, settings, question, [], new AbortController().signal), [])
    assert.equal(calls.length, callCount, 'no candidates means no authentication or request')
    text = JSON.stringify({ selectedIds: [] })
    assert.deepEqual(await selectMemories(ctx, settings, question, facts, new AbortController().signal), [])
    assert.deepEqual(await selectMemories(ctx, { enabled: true }, question, facts, new AbortController().signal), [])
    assert.equal(calls.at(-1)!.model.id, model.id, 'default recall selection follows OM model resolution')
    const find = ctx.modelRegistry.find
    ctx.modelRegistry.find = () => undefined
    await assert.rejects(selectMemories(ctx, settings, question, facts, new AbortController().signal), /model unavailable/)
    ctx.modelRegistry.find = find
    text = 'not JSON'
    await assert.rejects(selectMemories(ctx, settings, question, facts, new AbortController().signal), /Invalid.*JSON/)
    stop = 'length'
    await assert.rejects(selectMemories(ctx, settings, question, facts, new AbortController().signal), /did not complete/)
    stop = 'stop'
    await assert.rejects(extractLearning(ctx, settings, window, [], new AbortController().signal), /JSON/)
    text = JSON.stringify({ episodes: [] }); stop = 'length'
    await assert.rejects(extractLearning(ctx, settings, window, [], new AbortController().signal), /did not complete/)
    stop = 'error'; errorMessage = 'HTTP 401 SECRET-provider-payload'
    await assert.rejects(extractLearning(ctx, settings, window, [], new AbortController().signal),
      error => error instanceof MemoryReviewError && error.code === 'authentication' && error.httpStatus === 401 && !error.message.includes('SECRET'))
    errorMessage = 'SECRET-provider-payload'
    await assert.rejects(extractLearning(ctx, settings, window, [], new AbortController().signal),
      error => error instanceof MemoryReviewError && error.code === 'request' && !error.message.includes('SECRET'))
    for (const [message, code] of [['429: SECRET', 'rateLimit'], ['OpenAI API error (503): SECRET', 'httpServer'],
      ['fetch failed SECRET', 'connection'], ['Request timed out. SECRET', 'providerTimeout'], ['read ECONNRESET SECRET', 'connectionReset']]) {
      errorMessage = message
      await assert.rejects(selectMemories(ctx, settings, question, facts, new AbortController().signal),
        error => error instanceof MemoryReviewError && error.code === code && !error.message.includes('SECRET'))
    }
    hold = true
    const controller = new AbortController()
    const before = calls.length
    const pending = abortable(extractLearning(ctx, settings, window, [], controller.signal), controller.signal)
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
else test('learning and relevance use authenticated tool-free streams, honour thinking, enforce budgets and cancel without waiting for a provider', async () => {
  const { exitCode, stdout, stderr } = await runSelf(import.meta.path, ['--fixture'], { timeoutMs: 10_000 })
  assert.equal(exitCode, 0, stderr || stdout)
}, 15_000)
