import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { runSelf } from './helpers/subprocess'

async function fixture(scenario: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pig-memory-queue-'))
  const previous = process.env.PIG_DIR
  process.env.PIG_DIR = root
  try {
    const errors = await import('../src/main/features/memory/long-term/review-errors')
    // Real timers exercise cancellation and wake-up ownership; shorten only production policy intervals.
    class FastBackoff extends errors.ReviewBackoff {
      override fail(key: string): number { super.fail(key, Date.now() - 60_000 + 120); return 120 }
    }
    mock.module('../src/main/features/memory/long-term/review-errors', () => ({ ...errors, ReviewBackoff: FastBackoff, REVIEW_TIMEOUT_MS: 50 }))
    const { SessionManager } = await import('@earendil-works/pi-coding-agent')
    const { Runtime } = await import('../src/main/features/memory/runtime')
    const { collectMemoryCandidates } = await import('../src/main/features/memory/long-term/candidates')
    const { MemoryCandidateStore } = await import('../src/main/features/memory/long-term/store')
    const { longTermMemoryPath } = await import('../src/main/features/memory/paths')
    const { admissionInput } = await import('../src/main/features/memory/long-term/reviewer')
    const manager = SessionManager.create(root, root)
    const user = manager.appendMessage({ role: 'user', content: '项目决定使用中文检索', timestamp: Date.now() })
    manager.appendCustomEntry('om.observations.recorded', { version: 3, coversUpToId: user, observations: [
      { id: 'aaaaaaaaaaaa', content: '项目使用中文检索', timestamp: new Date().toISOString(), relevance: 'high', tokenCount: 10, sourceEntryIds: [user] },
    ] })
    const count = ['drain', 'bad-first', 'shared', 'rename'].includes(scenario) ? 3 : 1
    manager.appendCustomEntry('om.reflections.recorded', { version: 3, coversUpToId: user, reflections: Array.from({ length: count }, (_, index) => ({
      id: String(index + 1).repeat(12), content: `项目使用中文检索 ${index}`, tokenCount: 10, supportingObservationIds: ['aaaaaaaaaaaa'],
    })) })
    const candidates = collectMemoryCandidates({ sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile()!, cwd: root }, manager.getBranch()).candidates
    const store = new MemoryCandidateStore(longTermMemoryPath()); store.enqueue(candidates); store.close()
    const probe = () => {
      const current = new MemoryCandidateStore(longTermMemoryPath())
      try { return current.page('candidates').candidates } finally { current.close() }
    }
    let enabled = true
    mock.module('../src/main/features/memory-settings', () => ({ getMemorySettings: async () => ({ longTerm: { enabled } }) }))
    const calls: string[] = []
    const signals: AbortSignal[] = []
    const release = Promise.withResolvers<void>()
    const retry = Promise.withResolvers<void>()
    const logs: unknown[][] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { logs.push(args) }
    mock.module('../src/main/features/memory/long-term/reviewer', () => ({
      admissionInput,
      requestReviews: async (_ctx: unknown, _settings: unknown, inputs: ReturnType<typeof admissionInput>[], _existing: unknown, _access: unknown, signal: AbortSignal) => {
        const candidate = inputs[0]!.candidate
        calls.push(candidate.id); signals.push(signal)
        if (scenario === 'shared' && calls.length === 1) throw new errors.MemoryReviewError('authentication', 'SECRET-provider-response')
        if (scenario === 'bad-first' && calls.length === 1) throw new errors.MemoryReviewError('json', 'SECRET-model-output')
        if (['timeout', 'cancel', 'fast-settle', 'branch', 'disable', 'rename'].includes(scenario) && calls.length === 1) await release.promise
        if (scenario === 'rename' && calls.length === 2) await retry.promise
        return [{ candidate, action: 'skip', sourceEntryIds: [] }]
      },
    }))
    const { registerLongTermMemory } = await import('../src/main/features/memory/long-term/extension')
    const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>()
    const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
      registerTool: () => {} } as unknown as ExtensionAPI
    const notifications: string[] = []
    const runtime = new Runtime()
    runtime.notifications = { notify: (message: string) => { notifications.push(message) } }
    const consolidation = Promise.withResolvers<void>()
    if (scenario === 'consolidation') runtime.consolidationPromise = consolidation.promise
    let branchReads = 0
    const getBranch = manager.getBranch.bind(manager)
    manager.getBranch = (...args) => { branchReads++; return getBranch(...args) }
    const context = { cwd: root, sessionManager: manager, isIdle: () => true } as unknown as ExtensionContext
    const emit = async (name: string) => { for (const handler of handlers.get(name) ?? []) await handler({}, context) }
    const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
    const until = async (check: () => boolean) => {
      const deadline = Date.now() + 2000
      while (!check()) { assert.ok(Date.now() < deadline, `Timed out: ${scenario}`); await sleep(2) }
    }
    registerLongTermMemory(pi, runtime)
    try {
      await emit('session_start')
      if (scenario === 'consolidation') {
        await sleep(90)
        assert.equal(calls.length, 0)
        assert.deepEqual(notifications, [], 'waiting for OM must not use the model timeout')
        runtime.consolidationPromise = null; consolidation.resolve()
      }
      await until(() => calls.length > 0)
      if (scenario === 'drain' || scenario === 'consolidation') {
        await until(() => probe().length === 0)
        assert.equal(calls.length, count, 'one idle event drains all eligible candidates')
        assert.equal(branchReads, 1, 'the unchanged queue reuses one source branch snapshot')
        assert.deepEqual(notifications, [])
      } else if (scenario === 'bad-first') {
        await until(() => calls.length === 3 && probe().filter(item => item.status === 'pending').length === 1)
        assert.equal(new Set(calls).size, 3, 'failed oldest candidate must not block later candidates')
        assert.equal(probe().filter(item => item.status === 'pending').length, 1)
        await until(() => probe().length === 0)
        assert.equal(calls.length, 4, 'failed candidate wakes after its cooldown')
        assert.equal(calls[3], calls[0])
        assert.match(notifications[0]!, /\[json\]/)
      } else if (scenario === 'shared') {
        await sleep(30)
        assert.equal(calls.length, 1, 'authentication failure pauses the whole queue')
        await emit('agent_settled')
        await sleep(15)
        assert.equal(calls.length, 1, 'idle events do not bypass shared cooldown')
        await until(() => probe().length === 0)
        assert.equal(calls.length, 4)
        assert.match(notifications[0]!, /\[authentication\]/)
      } else if (scenario === 'timeout') {
        await until(() => notifications.length > 0)
        assert.match(notifications[0]!, /timed out.*\[timeout\]/)
        assert.ok(signals[0]!.aborted)
        await emit('session_shutdown')
        release.resolve(); await sleep(15)
        assert.equal(probe()[0]!.status, 'pending', 'late model result cannot commit')
      } else if (scenario === 'fast-settle') {
        // Invoke both handlers synchronously, before the cancelled flight can finish its microtasks.
        for (const handler of handlers.get('agent_start') ?? []) handler({}, context)
        for (const handler of handlers.get('agent_settled') ?? []) handler({}, context)
        await until(() => probe().length === 0)
        assert.equal(calls.length, 2, 'a settled event during cancellation cannot be lost')
        release.resolve()
        assert.deepEqual(notifications, [])
      } else if (scenario === 'branch') {
        manager.branch(user)
        await emit('session_tree')
        release.resolve(); await sleep(80)
        assert.equal(calls.length, 1, 'candidate outside the current branch is not reviewed')
        assert.equal(probe()[0]!.status, 'pending')
        assert.deepEqual(notifications, [])
      } else if (scenario === 'rename') {
        const leaf = manager.getLeafId()
        manager.appendSessionInfo('Renamed during review')
        assert.notEqual(manager.getLeafId(), leaf)
        release.resolve()
        await until(() => calls.length === 2)
        assert.equal(calls[1], calls[0], 'the stale result is discarded and the same candidate is retried')
        assert.equal(probe().length, count, 'no candidate is deleted by the stale review')
        retry.resolve()
        await until(() => probe().length === 0)
        assert.equal(calls.length, count + 1, 'renaming alone must not stall the remaining queue')
        assert.equal(branchReads, 2, 'retry refreshes the changed branch snapshot once')
        assert.deepEqual(notifications, [])
      } else if (scenario === 'disable') {
        enabled = false
        release.resolve(); await sleep(80)
        assert.equal(probe()[0]!.status, 'pending', 'configuration recheck rejects disabled reviews')
        assert.equal(calls.length, 1)
      } else {
        await emit('agent_start')
        release.resolve(); await sleep(180)
        assert.equal(probe()[0]!.status, 'pending')
        assert.equal(calls.length, 1, 'task start cancels the queue and pending wakeups')
        assert.deepEqual(notifications, [])
      }
      assert.doesNotMatch(JSON.stringify({ logs, notifications }), /SECRET-/)
    } finally {
      await emit('session_shutdown')
      release.resolve(); retry.resolve(); consolidation.resolve()
      console.warn = originalWarn
    }
  } finally {
    if (previous === undefined) delete process.env.PIG_DIR; else process.env.PIG_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv.includes('--fixture')) await fixture(process.argv[3]!)
else for (const scenario of ['drain', 'bad-first', 'shared', 'consolidation', 'timeout', 'cancel', 'fast-settle', 'branch', 'rename', 'disable']) {
  test(`long-term idle queue: ${scenario}`, async () => {
    const result = await runSelf(import.meta.path, ['--fixture', scenario], { timeoutMs: 10_000 })
    assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  }, 15_000)
}
