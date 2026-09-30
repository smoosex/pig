import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { Entry, Observation, Reflection } from '../src/main/plugins/observational-memory/session-ledger/types'

async function fixture(scenario: string): Promise<void> {
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const phase = scenario.startsWith('observer') ? 'observer' : scenario
  const calls: string[] = []
  const signals: AbortSignal[] = []
  let blocked = true
  let stale = false
  let staleAccesses = 0
  const notifications: string[] = []
  const writes: string[] = []
  const entries: Entry[] = [{
    type: 'message', id: 'source', timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: 'Remember the session lifecycle requirements.', timestamp: 1 }
  }]
  const observations: Observation[] = [{
    id: 'aaaaaaaaaaaa', content: 'Remember the lifecycle requirements.', timestamp: '2026-01-01T00:00:00.000Z',
    relevance: 'high', sourceEntryIds: ['source'], tokenCount: 20
  }]
  const reflections: Reflection[] = [{
    id: 'bbbbbbbbbbbb', content: 'Respect session lifecycle.', supportingObservationIds: ['aaaaaaaaaaaa'], tokenCount: 10
  }]
  class ObserverStreamError extends Error {}
  const run = async <T>(stage: string, args: { signal?: AbortSignal }, result: T): Promise<T> => {
    calls.push(stage)
    assert.ok(args.signal)
    signals.push(args.signal)
    if (blocked && stage === phase) {
      entered.resolve()
      await released.promise
      if (scenario === 'observer-error') throw new ObserverStreamError('aborted')
    }
    if (scenario === 'failure') throw new ObserverStreamError('Provider unavailable')
    return result
  }
  const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))
  mock.module(path('../src/main/plugins/observational-memory/agents/observer/agent.ts'), () => ({
    ObserverStreamError,
    runObserver: (args: { signal?: AbortSignal }) => run('observer', args, observations)
  }))
  mock.module(path('../src/main/plugins/observational-memory/agents/reflector/agent.ts'), () => ({
    runReflector: (args: { signal?: AbortSignal }) => run('reflector', args, reflections)
  }))
  mock.module(path('../src/main/plugins/observational-memory/agents/dropper/agent.ts'), () => ({
    runDropper: (args: { signal?: AbortSignal }) => run('dropper', args, ['aaaaaaaaaaaa'])
  }))

  const assertActive = () => {
    if (stale) {
      staleAccesses++
      throw new Error('This extension ctx is stale after session replacement or reload.')
    }
  }
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>()
  const pi = {
    on: (name: string, handler: (...args: any[]) => unknown) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler])
    },
    registerTool: () => {},
    appendEntry: (customType: string, data: unknown) => {
      assertActive()
      writes.push(customType)
      entries.push({ type: 'custom', id: `memory-${writes.length}`, customType, data })
    }
  } as unknown as ExtensionAPI
  const ctx = {
    cwd: '/project', hasUI: false,
    get ui(): never { throw new Error('Native plugin UI must not be used') },
    model: { provider: 'test', id: 'test', contextWindow: 100_000 },
    modelRegistry: {
      getApiKeyAndHeaders: async () => {
        assertActive()
        if (blocked && phase === 'auth') {
          entered.resolve()
          await released.promise
        }
        return { ok: true, apiKey: 'test' }
      },
      isUsingOAuth: () => { assertActive(); return false },
      hasConfiguredAuth: () => { assertActive(); return true }
    },
    sessionManager: {
      getBranch: () => { assertActive(); return entries },
      getSessionId: () => { assertActive(); return 'session' },
      getSessionFile: () => { assertActive(); return '/session.jsonl' }
    },
    getContextUsage: () => { assertActive(); return undefined }
  }
  const { registerSystemUI } = await import('../src/main/plugins/pig-ui')
  registerSystemUI('session', {
    send: () => {},
    memory: { notify: (message) => notifications.push(message) },
    review: { available: true, notify: () => {}, setActive: () => {}, choose: async () => undefined, edit: async () => undefined }
  })
  const { default: plugin } = await import('../src/main/plugins/observational-memory/index')
  const { memoryRuntime } = await import('../src/main/plugins/observational-memory/runtime')
  const emit = async (event: string) => {
    for (const handler of handlers.get(event) ?? []) await handler({}, ctx)
  }
  const start = async () => {
    plugin(pi)
    await emit('session_start')
    const runtime = memoryRuntime('session')!
    assert.ok(runtime)
    runtime.configLoaded = true
    Object.assign(runtime.config, {
      passive: false, observeAfterTokens: 1, reflectAfterTokens: 1,
      observationsPoolTargetTokens: 1, showWorkerNotifications: false, debugLog: false
    })
    await emit('agent_start')
    assert.ok(runtime.consolidationPromise)
    return { runtime, promise: runtime.consolidationPromise }
  }
  const { runtime, promise } = await start()
  if (scenario === 'failure' || scenario === 'success') {
    await promise
    if (scenario === 'failure') {
      assert.deepEqual(writes, [])
      assert.equal(runtime.lastObserverError, 'Provider unavailable')
      assert.deepEqual(notifications, ['Observational memory: observer failed: Provider unavailable'])
    } else {
      assert.deepEqual(writes, ['om.observations.recorded', 'om.reflections.recorded', 'om.observations.dropped'])
      assert.deepEqual(notifications, [])
    }
  } else {
    await entered.promise
    const before = [...writes]
    await emit('session_shutdown')
    await emit('session_shutdown')
    assert.equal(memoryRuntime('session'), undefined)
    assert.ok(signals.every((signal) => signal.aborted))
    stale = true
    released.resolve()
    await promise
    assert.deepEqual(writes, before)
    assert.deepEqual(notifications, [])
    assert.equal(staleAccesses, 0)
    assert.equal(runtime.lastObserverError, undefined)
    assert.equal(runtime.lastReflectorError, undefined)
    assert.equal(runtime.lastDropperError, undefined)
    assert.equal(calls.length, phase === 'auth' ? 0 : phase === 'reflector' ? 2 : phase === 'dropper' ? 3 : 1)

    if (scenario === 'observer') {
      stale = false
      blocked = false
      handlers.clear()
      const fresh = await start()
      assert.notEqual(fresh.runtime, runtime)
      await fresh.promise
      assert.deepEqual(writes, ['om.observations.recorded', 'om.reflections.recorded', 'om.observations.dropped'])
    }
  }
  assert.equal(runtime.consolidationInFlight, false)
  assert.equal(runtime.consolidationPromise, null)
}

if (process.argv[2] === '--memory-fixture') {
  await fixture(process.argv[3])
} else {
  for (const scenario of ['observer', 'observer-error', 'reflector', 'dropper', 'auth', 'failure', 'success']) {
    test(`memory lifecycle: ${scenario}`, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--memory-fixture', scenario], { stdout: 'pipe', stderr: 'pipe' })
      const timer = setTimeout(() => child.kill(), 10_000)
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
        ])
        assert.equal(code, 0, stderr || stdout)
      } finally {
        clearTimeout(timer)
        child.kill()
      }
    }, 15_000)
  }
}
