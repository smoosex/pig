import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Runtime } from '../src/main/plugins/observational-memory/runtime'
import type { Entry, Observation } from '../src/main/plugins/observational-memory/session-ledger/types'

async function idleFixture(cancel: boolean): Promise<void> {
  const { mock } = await import('bun:test')
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const observations: Observation[] = [{
    id: 'aaaaaaaaaaaa', content: 'Covered source', timestamp: '2026-01-01T00:00:00.000Z',
    relevance: 'medium', sourceEntryIds: ['observed'], tokenCount: 10
  }]
  let workerSignal: AbortSignal | undefined
  mock.module('../src/main/plugins/observational-memory/agents/observer/agent.ts', () => ({
    ObserverStreamError: class extends Error {},
    runObserver: async (args: { signal?: AbortSignal }) => {
      workerSignal = args.signal
      entered.resolve()
      await released.promise
      return [{ ...observations[0], id: 'bbbbbbbbbbbb', sourceEntryIds: ['unobserved'] }]
    }
  }))
  const { registerConsolidationTrigger } = await import('../src/main/plugins/observational-memory/hooks/consolidation-trigger')
  const { maybeTriggerCompaction, registerCompactionTrigger } = await import('../src/main/plugins/observational-memory/hooks/compaction-trigger')
  const runtime = new Runtime()
  runtime.configLoaded = true
  Object.assign(runtime.config, {
    consolidateWhenIdle: true, passive: false, observeAfterTokens: 1,
    reflectAfterTokens: 100_000, compactAfterTokens: 1, showWorkerNotifications: false,
    showCompactionNotifications: false
  })
  const notifications: string[] = []
  runtime.notifications = { notify: (message) => notifications.push(message) }
  const entries: Entry[] = [
    { type: 'message', id: 'observed', message: { role: 'user', content: 'Previously covered source.', timestamp: 1 } },
    { type: 'custom', id: 'coverage', customType: 'om.observations.recorded', data: { observations, coversUpToId: 'observed' } },
    { type: 'message', id: 'unobserved', message: { role: 'user', content: 'New source requiring observation.', timestamp: 2 } }
  ]
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>()
  const writes: string[] = []
  const pi = {
    on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    appendEntry: (customType: string, data: unknown) => {
      writes.push(customType)
      entries.push({ type: 'custom', id: `write-${writes.length}`, customType, data })
    }
  } as unknown as ExtensionAPI
  let compactions = 0
  let contextReads = 0
  const ctx = {
    cwd: '/project',
    model: { provider: 'test', contextWindow: 65_536 },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'key' }) },
    sessionManager: { getBranch: () => { contextReads++; return entries }, getSessionId: () => 'idle-test' },
    isIdle: () => true,
    compact: (options: { onComplete: () => void }) => {
      assert.equal(runtime.consolidationInFlight, false, 'native compaction must not compete with memory workers')
      compactions++
      options.onComplete()
    }
  }
  registerConsolidationTrigger(pi, runtime, {
    afterIdleConsolidation: (context) => maybeTriggerCompaction(runtime, context as Parameters<typeof maybeTriggerCompaction>[1])
  })
  registerCompactionTrigger(pi, runtime)
  const emit = async (event: string) => {
    for (const handler of handlers.get(event) ?? []) await handler({}, ctx)
  }
  await emit('agent_settled')
  await entered.promise
  const promise = runtime.consolidationPromise!
  const reads = contextReads
  maybeTriggerCompaction(runtime, ctx as unknown as Parameters<typeof maybeTriggerCompaction>[1])
  assert.equal(contextReads, reads, 'a waiting trigger does not need another context snapshot')
  await new Promise((done) => setTimeout(done, 5))
  assert.equal(compactions, 0)
  assert.equal(runtime.compactInFlight, false)
  if (cancel) {
    await emit('agent_start')
    assert.equal(workerSignal?.aborted, true)
  }
  released.resolve()
  await promise
  await new Promise((done) => setTimeout(done, 5))
  assert.equal(compactions, cancel ? 0 : 1)
  assert.deepEqual(writes, cancel ? [] : ['om.observations.recorded'])
  assert.deepEqual(notifications, [])
  assert.equal(runtime.consolidationInFlight, false)
  assert.equal(runtime.compactInFlight, false)
}

if (process.argv.includes('--idle-fixture')) {
  await idleFixture(process.argv.includes('--cancel'))
} else {
  for (const cancel of [false, true]) {
    test(`idle consolidation ${cancel ? 'pauses on agent_start without scheduling compaction' : 'finishes before native compaction starts'}`, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--idle-fixture', ...(cancel ? ['--cancel'] : [])], { stdout: 'pipe', stderr: 'pipe' })
      const timer = setTimeout(() => child.kill(), 10_000)
      try {
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
        assert.equal(code, 0, stderr || stdout)
      } finally {
        clearTimeout(timer)
        child.kill()
      }
    }, 15_000)
  }

  test('deferred compaction rechecks idle consolidation before touching the native compactor', async () => {
    const { maybeTriggerCompaction } = await import('../src/main/plugins/observational-memory/hooks/compaction-trigger')
    const runtime = new Runtime()
    runtime.configLoaded = true
    Object.assign(runtime.config, { consolidateWhenIdle: true, compactAfterTokens: 1, showCompactionNotifications: false })
    const entries: Entry[] = [
      { type: 'message', id: 'source', message: { role: 'user', content: 'Observed content', timestamp: 1 } },
      { type: 'custom', id: 'coverage', customType: 'om.observations.recorded', data: { observations: [{
        id: 'aaaaaaaaaaaa', content: 'Covered source', timestamp: '2026-01-01T00:00:00.000Z',
        relevance: 'medium', sourceEntryIds: ['source'], tokenCount: 10
      }], coversUpToId: 'source' } }
    ]
    let compactions = 0
    const ctx = {
      cwd: '/project', model: { contextWindow: 65536 },
      sessionManager: { getBranch: () => entries },
      isIdle: () => true, compact: () => { compactions++ }
    }
    maybeTriggerCompaction(runtime, ctx as unknown as Parameters<typeof maybeTriggerCompaction>[1])
    assert.equal(runtime.compactInFlight, true)
    runtime.consolidationInFlight = true
    await new Promise((done) => setTimeout(done, 5))
    assert.equal(compactions, 0)
    assert.equal(runtime.compactInFlight, false)
  })

  test('idle completion runs after cleanup and reports callback failure at the detached task boundary', async () => {
    const runtime = new Runtime()
    const notifications: string[] = []
    runtime.notifications = { notify: (message) => notifications.push(message) }
    let completions = 0
    await runtime.launchConsolidationTask(async () => {}, () => {
      assert.equal(runtime.consolidationInFlight, false)
      assert.equal(runtime.consolidationPromise, null)
      completions++
      throw new Error('completion failed')
    })
    assert.equal(completions, 1)
    assert.deepEqual(notifications, ['Observational memory: consolidation failed: completion failed'])
  })
}
