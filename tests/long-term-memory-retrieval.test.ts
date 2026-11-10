import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { LongTermFact, LongTermRetrievalTrace, MemoryFailureCode } from '../src/shared/long-term-memory'
import type { RecallQuestion } from '../src/main/features/memory/long-term/relevance'
import { runSelf } from './helpers/subprocess'

async function fixture(scenario: string) {
  const root = await mkdtemp(join(tmpdir(), 'pig-retrieval-'))
  const previous = process.env.PIG_DIR; process.env.PIG_DIR = root
  let unregister = () => {}
  try {
    let enabled = scenario !== 'disabled'
    const questionText = scenario === 'project-history' ? '我做过哪些项目？' : '项目决定使用中文检索'
    mock.module('../src/main/features/memory-settings', () => ({ getMemorySettings: async () => ({ passive: true, longTerm: { enabled } }) }))
    const relevance = await import('../src/main/features/memory/long-term/relevance')
    assert.equal(relevance.RELEVANCE_TIMEOUT_MS, 60_000)
    const { MemoryReviewError, REVIEW_FAILURES, providerFailure } = await import('../src/main/features/memory/long-term/review-errors')
    const selectionStarted = Promise.withResolvers<void>()
    const releaseSelection = Promise.withResolvers<void>()
    let selections = 0
    mock.module('../src/main/features/memory/long-term/relevance', () => ({ ...relevance, RELEVANCE_TIMEOUT_MS: 50,
      selectMemories: async (_ctx: unknown, _settings: unknown, question: RecallQuestion, memories: LongTermFact[], signal: AbortSignal) => {
        selections++
        assert.equal(question.question, questionText)
        if (scenario === 'duplicate') assert.ok(question.availableContext?.length)
        selectionStarted.resolve()
        if (['cancelled', 'timeout', 'rename', 'forget', 'disable', 'signal'].includes(scenario)) await releaseSelection.promise
        if (scenario === 'http-error') throw providerFailure('OpenAI API error (503): SECRET-provider-response')
        if (scenario.startsWith('failure-')) throw new MemoryReviewError(scenario.slice(8) as MemoryFailureCode, 'SECRET-provider-response')
        if (scenario === 'selection-error') throw new Error('SECRET-provider-error')
        const ids = ['rejected', 'preference-rejected', 'project-only', 'duplicate'].includes(scenario) ? [] : scenario === 'invalid' ? ['unknown-id']
          : scenario === 'filtered' ? [memories[1]!.id] : memories.map(item => item.id)
        // Simulate a provider that ignores abort; the host still must reject its late result.
        if (!['cancelled', 'timeout', 'signal'].includes(scenario)) signal.throwIfAborted()
        return relevance.parseSelection(JSON.stringify({ selectedIds: ids }), memories)
      },
    }))
    const { SessionManager } = await import('@earendil-works/pi-coding-agent')
    const { Runtime } = await import('../src/main/features/memory/runtime')
    const { registerLongTermMemory, memoryAccess } = await import('../src/main/features/memory/long-term/extension')
    const { sourceWindow } = await import('../src/main/features/memory/long-term/sources')
    const { LongTermMemoryStore } = await import('../src/main/features/memory/long-term/store')
    const { seedKnowledge } = await import('./helpers/long-term-memory')
    const { longTermMemoryPath } = await import('../src/main/features/memory/paths')
    const { registerSystemUI } = await import('../src/main/plugins/pig-ui')
    const manager = SessionManager.create(root, root)
    const user = manager.appendMessage({ role: 'user', content: questionText, timestamp: Date.now() })
    manager.appendCustomEntry('test.flush', {})
    const turn = new AbortController()
    const context = { cwd: root, sessionManager: manager, isIdle: () => true, signal: turn.signal } as unknown as ExtensionContext
    const access = await memoryAccess(context)
    const store = new LongTermMemoryStore(longTermMemoryPath())
    const window = sourceWindow(manager, { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile()!, cwd: root, project: access.project }, () => false)!
    const kind = ['project-only', 'project-history', 'legacy-profile'].includes(scenario) ? 'project' : scenario === 'preference-rejected' ? 'preference' : 'knowledge'
    const facts = ['empty', 'disabled'].includes(scenario) ? [] : seedKnowledge(store, window, [0, 1].map(index =>
      (['project-only', 'project-history'].includes(scenario) ? 'Atlas 是 Rust 日志查看器。' : scenario === 'preference-rejected' ? '以后 JavaScript 项目默认使用 Bun。' : scenario === 'budget' ? '中文检索'.repeat(300) : '项目决定使用中文检索') + index), kind)
    store.close()
    if (scenario === 'legacy-profile') {
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(longTermMemoryPath())
      db.prepare("UPDATE knowledge_items SET payload=json_set(payload, '$.content', ?)").run('Pig implementation lives in src/main/features/memory/long-term/extension.ts')
      db.close()
    }
    if (scenario === 'error') await writeFile(longTermMemoryPath(), 'invalid sqlite')
    const traces: LongTermRetrievalTrace[] = []
    const started = Promise.withResolvers<void>()
    registerSystemUI(manager.getSessionId(), {
      send: event => { if (event.kind === 'memory-retrieval') { traces.push(event.trace); if (event.trace.status === 'running') started.resolve() } },
      memory: { notify: () => {} },
      review: { available: true, returning: false, choose: async () => undefined, edit: async () => undefined,
        setFeedback: () => {}, setActive: () => {}, setReturning: () => {} },
    })
    unregister = () => registerSystemUI(manager.getSessionId())
    const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>()
    const pi = { on: (name: string, handler: (event: any, ctx: ExtensionContext) => any) => handlers.set(name, handler), registerTool: () => {} } as unknown as ExtensionAPI
    const runtime = new Runtime()
    const notifications: string[] = []
    runtime.notifications = { notify: message => { notifications.push(message) } }
    registerLongTermMemory(pi, runtime)
    await handlers.get('session_start')!({}, context)
    const original = manager.getEntries().length
    const messages = scenario === 'duplicate' ? [{ role: 'assistant', content: [{ type: 'text', text: '当前已经知道：项目使用中文关键词搜索，不必重复这一结论。' }] }] : []
    const pending = handlers.get('context')!({ messages }, context)
    if (['cancelled', 'rename', 'forget', 'disable', 'signal'].includes(scenario)) {
      await selectionStarted.promise
      if (scenario === 'cancelled') await handlers.get('agent_start')!({}, context)
      if (scenario === 'signal') turn.abort()
      if (scenario === 'rename') manager.appendSessionInfo('Renamed during selection')
      if (scenario === 'disable') enabled = false
      if (scenario === 'forget') {
        const current = new LongTermMemoryStore(longTermMemoryPath())
        current.forgetFact(facts[0]!.id); current.close()
      }
      if (!['cancelled', 'signal'].includes(scenario)) releaseSelection.resolve()
    }
    const response = await pending
    releaseSelection.resolve()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(manager.getEntries().length, original + (scenario === 'rename' ? 1 : 0), 'recall and its UI diagnostics never create ledger evidence')
    if (scenario === 'disabled') { assert.deepEqual(traces, []); assert.equal(response, undefined) }
    else {
      assert.equal(traces[0]!.status, 'running')
      const last = traces.at(-1)!
      assert.equal(last.turnId, user)
      assert.ok(last.renderKey.startsWith('user:'))
      assert.ok(last.durationMs! >= 0)
      const cancelled = ['cancelled', 'rename', 'forget', 'disable', 'signal'].includes(scenario)
      const failed = ['error', 'selection-error', 'invalid', 'timeout', 'http-error'].includes(scenario) || scenario.startsWith('failure-')
      if (failed || cancelled) {
        assert.equal(last.status, cancelled ? 'cancelled' : 'error')
        assert.equal(response, undefined); assert.deepEqual(last.memories, [])
        if (cancelled) assert.equal(last.error, undefined)
        else {
          const code: MemoryFailureCode = scenario.startsWith('failure-') ? scenario.slice(8) as MemoryFailureCode
            : scenario === 'error' ? 'storage' : scenario === 'invalid' ? 'evidence' : scenario === 'timeout' ? 'timeout'
            : scenario === 'http-error' ? 'httpServer' : 'request'
          const expected = { code, stage: REVIEW_FAILURES[code].stage, ...(scenario === 'http-error' ? { httpStatus: 503 } : {}) }
          assert.deepEqual(last.error, expected)
          assert.ok(notifications.some(message => message.includes(`[${expected.stage}/${code}]`)))
          if (scenario !== 'error') {
            assert.equal(await handlers.get('context')!({ messages: [] }, context), undefined)
            assert.deepEqual(traces.at(-1)!.error, expected)
            assert.equal(traces.at(-1)!.cached, true)
            assert.equal(selections, 1, 'cached failures preserve diagnostics without another request')
          }
        }
      }
      else {
        assert.equal(last.status, 'done')
        const noInjection = ['empty', 'rejected', 'preference-rejected', 'project-only', 'legacy-profile', 'duplicate'].includes(scenario)
        assert.equal(last.memories.length, noInjection ? 0 : ['budget', 'filtered'].includes(scenario) ? 1 : 2)
        if (noInjection) assert.equal(response, undefined)
        else {
          const injected = response.messages[0].content as string
          for (const memory of last.memories) assert.ok(injected.includes(memory.id))
          assert.ok(Buffer.byteLength(injected) <= 6000)
          assert.ok(!JSON.stringify(last).includes('scopeKey'), 'UI diagnostics do not leak filesystem scope keys')
          for (const key of ['scopeKey', 'projectKey', 'checkoutKey', 'createdAt', 'updatedAt', 'sourceTime', 'assertion']) assert.ok(!injected.includes(`"${key}"`), 'the request carries references, not database rows')
        }
      }
    }
    if (['disabled', 'empty', 'error', 'legacy-profile'].includes(scenario)) assert.equal(selections, 0, 'no matches means no model request')
    if (['success', 'rejected'].includes(scenario)) {
      const again = await handlers.get('context')!({ messages: [] }, context)
      assert.deepEqual(again, response)
      assert.equal(selections, 1, 'tool rounds reuse the selection, including zero matches')
      if (scenario === 'success') {
        const duplicate = await handlers.get('context')!({ messages: [{ role: 'assistant', content: [{ type: 'text', text: facts.map(fact => fact.content).join('\n') }] }] }, context)
        assert.equal(duplicate, undefined, 'cached facts already present in the effective context are not reinjected')
        assert.equal(selections, 1)
        assert.deepEqual(traces.at(-1)!.memories, [])
      }
    }
    assert.ok(!JSON.stringify({ traces, notifications }).includes('SECRET-'))
    await handlers.get('session_shutdown')!({}, context)
  } finally {
    unregister()
    if (previous === undefined) delete process.env.PIG_DIR; else process.env.PIG_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
}
if (process.argv.includes('--fixture')) await fixture(process.argv[3]!)
else for (const scenario of ['disabled', 'success', 'empty', 'budget', 'error', 'cancelled', 'filtered', 'rejected', 'invalid', 'selection-error', 'timeout', 'rename', 'forget', 'disable', 'signal', 'project-only', 'project-history', 'legacy-profile', 'preference-rejected', 'duplicate', 'http-error', 'failure-connection', 'failure-connectionReset', 'failure-dns', 'failure-tls', 'failure-providerTimeout', 'failure-httpClient', 'failure-authentication', 'failure-rateLimit']) test(`memory recall UI events: ${scenario}`, async () => {
  const { exitCode, stdout, stderr } = await runSelf(import.meta.path, ['--fixture', scenario], { timeoutMs: 10_000 })
  assert.equal(exitCode, 0, stderr || stdout)
}, 15_000)
