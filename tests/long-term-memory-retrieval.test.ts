import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { LongTermRetrievalTrace } from '../src/shared/long-term-memory'
import { runSelf } from './helpers/subprocess'

async function fixture(scenario: string) {
  const root = await mkdtemp(join(tmpdir(), 'pig-retrieval-'))
  const previous = process.env.PIG_DIR; process.env.PIG_DIR = root
  let unregister = () => {}
  try {
    mock.module('../src/main/features/memory-settings', () => ({ getMemorySettings: async () => ({ passive: true, longTerm: { enabled: scenario !== 'disabled' } }) }))
    const { SessionManager } = await import('@earendil-works/pi-coding-agent')
    const { Runtime } = await import('../src/main/features/memory/runtime')
    const { registerLongTermMemory, memoryAccess } = await import('../src/main/features/memory/long-term/extension')
    const { collectMemoryCandidates } = await import('../src/main/features/memory/long-term/candidates')
    const { MemoryCandidateStore } = await import('../src/main/features/memory/long-term/store')
    const { longTermMemoryPath } = await import('../src/main/features/memory/paths')
    const { registerSystemUI } = await import('../src/main/plugins/pig-ui')
    const manager = SessionManager.create(root, root)
    const user = manager.appendMessage({ role: 'user', content: '项目决定使用中文检索', timestamp: Date.now() })
    manager.appendCustomEntry('om.observations.recorded', { version: 3, coversUpToId: user, observations: [
      { id: 'aaaaaaaaaaaa', content: '项目使用中文检索', timestamp: new Date().toISOString(), relevance: 'high', tokenCount: 10, sourceEntryIds: [user] },
    ] })
    manager.appendCustomEntry('om.reflections.recorded', { version: 3, coversUpToId: user, reflections: [0, 1].map(index => ({
      id: 'bbbbbbbbbbb' + index, content: '中文检索决策 ' + index, tokenCount: 10, supportingObservationIds: ['aaaaaaaaaaaa'],
    })) })
    const context = { cwd: root, sessionManager: manager, isIdle: () => true } as unknown as ExtensionContext
    const candidates = collectMemoryCandidates({ sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile()!, cwd: root }, manager.getBranch()).candidates
    const access = await memoryAccess(context)
    const store = new MemoryCandidateStore(longTermMemoryPath())
    store.enqueue(candidates)
    if (!['empty', 'disabled'].includes(scenario)) store.review(candidates.map((candidate, index) => ({ candidate, action: 'add', sourceEntryIds: [user], fact: {
      content: (scenario === 'budget' ? '中文检索'.repeat(300) : '项目决定使用中文检索') + index,
      kind: 'decision', scope: 'project', scopeKey: access.project, assertion: 'user-statement', sourceTime: new Date().toISOString(),
    } })), store.revision())
    store.close()
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
    registerLongTermMemory(pi, runtime)
    await handlers.get('session_start')!({}, context)
    const original = manager.getEntries().length
    const pending = handlers.get('context')!({ messages: [] }, context)
    if (scenario === 'cancelled') { await started.promise; await handlers.get('agent_start')!({}, context) }
    const response = await pending
    assert.equal(manager.getEntries().length, original, 'recall and its UI diagnostics never create ledger evidence')
    if (scenario === 'disabled') { assert.deepEqual(traces, []); assert.equal(response, undefined) }
    else {
      assert.equal(traces[0]!.status, 'running')
      const last = traces.at(-1)!
      assert.equal(last.turnId, user)
      assert.ok(last.renderKey.startsWith('user:'))
      assert.ok(last.durationMs! >= 0)
      if (['error', 'cancelled'].includes(scenario)) { assert.equal(last.status, scenario); assert.equal(response, undefined); assert.deepEqual(last.memories, []) }
      else {
        assert.equal(last.status, 'done')
        assert.equal(last.memories.length, scenario === 'empty' ? 0 : scenario === 'budget' ? 1 : 2)
        if (scenario === 'empty') assert.equal(response, undefined)
        else {
          const injected = response.messages[0].content as string
          for (const memory of last.memories) assert.ok(injected.includes(memory.id))
          assert.ok(Buffer.byteLength(injected) <= 6000)
          assert.ok(!JSON.stringify(last).includes('scopeKey'), 'UI diagnostics do not leak filesystem scope keys')
        }
      }
    }
    await handlers.get('session_shutdown')!({}, context)
  } finally {
    unregister()
    if (previous === undefined) delete process.env.PIG_DIR; else process.env.PIG_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
}
if (process.argv.includes('--fixture')) await fixture(process.argv[3]!)
else for (const scenario of ['disabled', 'success', 'empty', 'budget', 'error', 'cancelled']) test(`memory recall UI events: ${scenario}`, async () => {
  const { exitCode, stdout, stderr } = await runSelf(import.meta.path, ['--fixture', scenario], { timeoutMs: 10_000 })
  assert.equal(exitCode, 0, stderr || stdout)
}, 15_000)
