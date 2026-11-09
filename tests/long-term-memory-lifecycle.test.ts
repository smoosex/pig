import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { runSelf } from './helpers/subprocess'

async function fixture(scenario: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pig-long-term-lifecycle-'))
  const previous = process.env.PIG_DIR; process.env.PIG_DIR = root
  try {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent')
    const { collectMemoryCandidates } = await import('../src/main/features/memory/long-term/candidates')
    const { MemoryCandidateStore } = await import('../src/main/features/memory/long-term/store')
    const { longTermMemoryPath } = await import('../src/main/features/memory/paths')
    const { Runtime } = await import('../src/main/features/memory/runtime')
    const manager = SessionManager.create(root, root)
    const user = manager.appendMessage({ role: 'user', content: '项目决定使用中文检索', timestamp: Date.now() })
    manager.appendCustomEntry('om.observations.recorded', { version: 3, coversUpToId: user, observations: [
      { id: 'aaaaaaaaaaaa', content: '项目使用中文检索', timestamp: new Date().toISOString(), relevance: 'high', tokenCount: 10, sourceEntryIds: [user] },
    ] })
    manager.appendCustomEntry('om.reflections.recorded', { version: 3, coversUpToId: user, reflections: [
      { id: 'bbbbbbbbbbbb', content: '项目使用中文检索', tokenCount: 10, supportingObservationIds: ['aaaaaaaaaaaa'] },
    ] })
    const candidate = collectMemoryCandidates({ sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile()!, cwd: root }, manager.getBranch()).candidates[0]!
    assert.ok(candidate)
    const store = new MemoryCandidateStore(longTermMemoryPath()); store.enqueue([candidate]); store.close()
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>()
    let requests = 0
    mock.module('../src/main/features/memory-settings', () => ({ getMemorySettings: async () => ({ longTerm: { enabled: scenario !== 'disabled' } }) }))
    mock.module('../src/main/features/memory/long-term/reviewer', () => ({
      admissionInput: (item: unknown) => item,
      requestReviews: async (_ctx: unknown, _settings: unknown, _inputs: unknown, _existing: unknown, access: { project: string }) => {
        requests++; entered.resolve(); await release.promise
        if (scenario === 'error') throw new Error('Provider failed')
        return [{ candidate, action: 'add', sourceEntryIds: [user], fact: { content: '项目决定使用中文检索', kind: 'decision', scope: 'project',
          scopeKey: access.project, assertion: 'user-statement', sourceTime: new Date().toISOString() } }]
      },
    }))
    const relevance = await import('../src/main/features/memory/long-term/relevance')
    mock.module('../src/main/features/memory/long-term/relevance', () => ({ ...relevance,
      selectMemories: async (...args: Parameters<typeof relevance.selectMemories>) => [...args[3]],
    }))
    const { registerLongTermMemory } = await import('../src/main/features/memory/long-term/extension')
    const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>()
    const tools: string[] = []
    const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
      registerTool: (tool: { name: string }) => tools.push(tool.name) } as unknown as ExtensionAPI
    const notifications: string[] = []
    const runtime = new Runtime(); runtime.notifications = { notify: (message: string) => { notifications.push(message) } }
    const context = { cwd: root, sessionManager: manager, isIdle: () => true } as unknown as ExtensionContext
    const emit = async (name: string) => {
      let result: unknown
      for (const handler of handlers.get(name) ?? []) result = await handler({}, context)
      return result
    }
    registerLongTermMemory(pi, runtime)
    assert.deepEqual(tools, ['memory_search', 'memory_recall', 'memory_read'])
    await emit('session_start')
    if (scenario === 'disabled') {
      for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(requests, 0)
      await emit('session_shutdown'); return
    }
    await entered.promise
    await emit('agent_settled')
    assert.equal(requests, 1, 'same-session workers cannot overlap')
    if (['agent_start', 'session_tree', 'session_shutdown'].includes(scenario)) await emit(scenario)
    if (scenario === 'forget') { const current = new MemoryCandidateStore(longTermMemoryPath()); current.deleteCandidate(candidate.id); current.close() }
    release.resolve()
    const deadline = Date.now() + 2000
    for (;;) {
      const probe = new MemoryCandidateStore(longTermMemoryPath())
      const committed = probe.page('memories').memories.length > 0
      probe.close()
      if (scenario === 'success' ? committed : notifications.length > 0 || !['error', 'forget'].includes(scenario)) break
      if (Date.now() >= deadline) break
      await new Promise<void>(resolve => setTimeout(resolve, 5))
    }
    const result = new MemoryCandidateStore(longTermMemoryPath())
    try {
      if (scenario === 'success') {
        assert.equal(result.page('memories').memories.length, 1)
        const original = manager.getEntries().length
        const contextHandler = handlers.get('context')![0]!
        const response = await contextHandler({ messages: [] }, context) as { messages: { role: string; content: string }[] }
        assert.match(response.messages[0]!.content, /untrusted historical data/)
        assert.equal(manager.getEntries().length, original, 'automatic recall never persists new evidence')
      } else assert.equal(result.page('memories').memories.length, 0, 'cancelled, failed or forgotten candidates never commit')
      if (scenario === 'error' || scenario === 'forget') assert.ok(notifications.some(message => /review failed/.test(message)))
      else if (scenario !== 'success') assert.deepEqual(notifications, [])
    } finally { result.close(); await emit('session_shutdown') }
  } finally {
    if (previous === undefined) delete process.env.PIG_DIR; else process.env.PIG_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
}
if (process.argv.includes('--fixture')) await fixture(process.argv[3]!)
else for (const scenario of ['disabled', 'success', 'agent_start', 'session_tree', 'session_shutdown', 'forget', 'error']) {
  test(`long-term admission lifecycle: ${scenario}`, async () => {
    const { exitCode, stdout, stderr } = await runSelf(import.meta.path, ['--fixture', scenario], { timeoutMs: 10_000 })
    assert.equal(exitCode, 0, stderr || stdout)
  }, 15_000)
}
