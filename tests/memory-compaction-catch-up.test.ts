/*
 * Compaction must never discard source entries the observer has not reached (#81).
 *
 * Pi proposes `firstKeptEntryId` from its own `keepRecentTokens` budget, without
 * knowing how far the observation frontier has advanced. Everything between the
 * two would be removed with no memory describing it, so the hook either runs the
 * observer synchronously to cover the gap, retains the entries, or declines
 * ownership entirely. These tests pin that decision.
 */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { runObserver } from '../src/main/plugins/observational-memory/agents/observer/agent'
import { fullProjection, visibleProjection } from '../src/main/plugins/observational-memory/session-ledger'
import type { Entry, Observation } from '../src/main/plugins/observational-memory/session-ledger/types'

const timestamp = '2026-05-02T10:00:00.000Z'

type ObserverArgs = Parameters<typeof runObserver>[0]
const observerCalls: ObserverArgs[] = []
const observer = { result: async (): Promise<Observation[]> => [], error: undefined as unknown }

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))
const OM_OBSERVATIONS_RECORDED = 'om.observations.recorded'

mock.module(path('../src/main/plugins/observational-memory/agents/observer/agent.ts'), () => ({
  ObserverStreamError: class ObserverStreamError extends Error {},
  runObserver: async (args: ObserverArgs) => {
    observerCalls.push(args)
    if (observer.error) throw observer.error
    return observer.result()
  }
}))

import { registerCompactionHook } from '../src/main/plugins/observational-memory/hooks/compaction-hook'
import type { Runtime } from '../src/main/plugins/observational-memory/runtime'

function userMessage(id: string, text = `user ${id}`): Entry {
  return { type: 'message', id, timestamp, message: { role: 'user', content: text, timestamp: 1 } } as Entry
}

function assistantMessage(id: string, text = `assistant ${id}`): Entry {
  return {
    type: 'message', id, timestamp,
    message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'end_turn', timestamp: 1 }
  } as Entry
}

function toolResultMessage(id: string, text = `tool result ${id}`): Entry {
  return {
    type: 'message', id, timestamp,
    message: { role: 'toolResult', toolCallId: `call-${id}`, toolName: 'bash', content: [{ type: 'text', text }], timestamp: 1 }
  } as Entry
}

function observation(id: string, sourceEntryIds: string[], tokenCount = 10): Observation {
  return { id, content: `observation ${id}`, timestamp, relevance: 'medium', sourceEntryIds, tokenCount }
}

function coverage(id: string, coversUpToId: string, observationId: string): Entry {
  return {
    type: 'custom', id, timestamp, customType: OM_OBSERVATIONS_RECORDED,
    data: { observations: [observation(observationId, [coversUpToId])], coversUpToId }
  } as Entry
}

/** 0 u0  1 a0  2 u1  3 a1  4 t1  5 a2  6 u2  7 om(a0)  8 om(a1); Pi proposes to keep from u2. */
function laggingBranch(t1Text?: string): Entry[] {
  return [
    userMessage('u0'),
    assistantMessage('a0'),
    userMessage('u1'),
    assistantMessage('a1'),
    toolResultMessage('t1', t1Text),
    assistantMessage('a2'),
    userMessage('u2'),
    coverage('om-a0', 'a0', 'aaaaaaaaaaaa'),
    coverage('om-a1', 'a1', 'bbbbbbbbbbbb'),
  ]
}

function setup(args: {
  entries: Entry[]
  maxChunks?: number
  observerChunkMaxTokens?: number
  consolidationInFlight?: boolean
  resolveOk?: boolean
  resolved?: Extract<import('../src/main/plugins/observational-memory/runtime').ResolveResult, { ok: true }>
  signal?: AbortSignal
  passive?: boolean
  summaryMaxTokens?: number
}) {
  let resolveCalls = 0
  const appended: Array<{ customType: string; data: unknown }> = []
  const notifications: Array<{ message: string; level: string }> = []
  // Compaction coverage markers append to the branch, and the hook re-reads it
  // through `sessionManager.getBranch()` before deciding the final cut.
  const branch: Entry[] = [...args.entries]
  const pi = {
    on: () => {},
    appendEntry: (customType: string, data: unknown) => {
      appended.push({ customType, data })
      branch.push({ type: 'custom', id: `appended-${appended.length}`, timestamp, customType, data } as Entry)
    }
  } as unknown as ExtensionAPI
  const runtime = {
    config: {
      observationsPoolMaxTokens: 20_000,
      passive: args.passive ?? false,
      compactionSummaryMaxTokens: args.summaryMaxTokens,
      compactionCatchUpMaxChunks: args.maxChunks ?? 2,
      observerChunkMaxTokens: args.observerChunkMaxTokens,
      agentMaxTurns: 4,
      agentMaxTokens: 8192,
      showWorkerNotifications: false,
      model: { provider: 'test', id: 'memory', thinking: 'off' },
      piAutoCompactionEnabled: true,
      compactAfterTokens: 81_000,
      compactAfterTokensMode: 'calibrated',
    },
    compactHookInFlight: false,
    consolidationInFlight: args.consolidationInFlight ?? false,
    notify: (message: string, level: string) => { notifications.push({ message, level }) },
    resolveModel: async () => {
      resolveCalls++
      return args.resolveOk === false
        ? { ok: false, reason: 'no model' }
        : args.resolved ?? { ok: true, model: { provider: 'test', id: 'memory', contextWindow: 65536 }, apiKey: 'key' }
    },
    ensureConfig: () => {},
  } as unknown as Runtime

  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>()
  ;(pi as unknown as { on: (name: string, cb: (event: unknown, ctx: unknown) => Promise<unknown>) => void }).on = (name, cb) => { handlers.set(name, cb) }

  registerCompactionHook(pi, runtime)
  const handler = handlers.get('session_before_compact')
  if (!handler) throw new Error('compaction handler was not registered')

  const ctx = {
    cwd: '/tmp/project',
    model: { contextWindow: 65536 },
    modelRegistry: {},
    sessionManager: { getBranch: () => branch, getSessionId: () => 'catch-up-session' }
  }

  const run = (firstKeptEntryId: string) => handler!({
    preparation: { firstKeptEntryId, tokensBefore: 123 },
    branchEntries: args.entries,
    reason: 'threshold',
    willRetry: false,
    signal: args.signal ?? new AbortController().signal,
  }, ctx)

  return {
    pi, runtime, ctx, run, notifications, appended,
    shutdown: () => handlers.get('session_shutdown')!({}, ctx),
    resolveCalls: () => resolveCalls,
  }
}

for (const scenario of ['records', 'empty', 'error'] as const) {
  test(`catch-up observer run: ${scenario}`, async () => {
    const gap = observation('cccccccccccc', ['t1', 'a2'], 12)
    observerCalls.length = 0
    observer.error = undefined
    observer.result = async () => {
      if (scenario === 'records') return [gap]
      if (scenario === 'empty') return []
      throw new Error('Connection error.')
    }
    const { run, appended, notifications } = setup({ entries: laggingBranch() })
    const result = await run('u2') as any

    if (scenario === 'records') {
      assert.equal(observerCalls.length, 1)
      assert.deepEqual(observerCalls[0]!.allowedSourceEntryIds, ['t1', 'a2'])
      assert.equal(observerCalls[0]!.maxOutputTokens, 8192)
      assert.equal(observerCalls[0]!.thinkingLevel, 'off')
      assert.deepEqual(appended.map((entry) => entry.customType), [OM_OBSERVATIONS_RECORDED])
      assert.equal((appended[0]!.data as { coversUpToId: string }).coversUpToId, 'a2')
      // Coverage reaches Pi's boundary, so the cut stays where Pi proposed.
      assert.equal(result.compaction.firstKeptEntryId, 'u2')
      assert.deepEqual(result.compaction.details.observations.map((item: Observation) => item.id), [
        'aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc',
      ])
      assert.ok(!notifications.some((entry) => entry.message.includes('keeping them in context')))
    } else {
      assert.equal(observerCalls.length, 1)
      assert.deepEqual(appended, [])
      // The tail is retained instead of discarded.
      assert.equal(result.compaction.firstKeptEntryId, 'a1')
      if (scenario === 'error') {
        assert.ok(notifications.some((entry) => entry.message === 'Observational memory: catch-up observer failed: Connection error.'))
      }
    }
  })
}

test('declines ownership when nothing has ever been observed', async () => {
  observerCalls.length = 0
  observer.error = undefined
  observer.result = async () => []
  const { run, resolveCalls } = setup({ entries: [userMessage('u0'), assistantMessage('a0'), userMessage('u1')] })

  assert.equal(await run('u1'), undefined)
  assert.equal(observerCalls.length, 0)
  assert.equal(resolveCalls(), 0)
})

test('does not resolve a model when catch-up is disabled', async () => {
  observerCalls.length = 0
  observer.error = undefined
  observer.result = async () => []
  const { run, resolveCalls } = setup({ entries: laggingBranch(), maxChunks: 0 })

  const result = await run('u2') as any
  assert.equal(observerCalls.length, 0)
  assert.equal(resolveCalls(), 0)
  assert.equal(result.compaction.firstKeptEntryId, 'a1')
})

test('does not run catch-up while a background consolidation is in flight', async () => {
  observerCalls.length = 0
  observer.error = undefined
  observer.result = async () => []
  const { run, resolveCalls } = setup({ entries: laggingBranch(), consolidationInFlight: true })

  const result = await run('u2') as any
  assert.equal(observerCalls.length, 0)
  assert.equal(resolveCalls(), 0)
  assert.equal(result.compaction.firstKeptEntryId, 'a1')
})

test('retains the tail when the memory model is unavailable', async () => {
  observerCalls.length = 0
  observer.error = undefined
  observer.result = async () => []
  const { run, appended } = setup({ entries: laggingBranch(), resolveOk: false })

  const result = await run('u2') as any
  assert.equal(observerCalls.length, 0)
  assert.deepEqual(appended, [])
  assert.equal(result.compaction.firstKeptEntryId, 'a1')
})

test('cuts at Pi’s boundary when coverage already reaches it', async () => {
  observerCalls.length = 0
  observer.error = undefined
  observer.result = async () => []
  const entries = laggingBranch()
  entries.push(coverage('om-a2', 'a2', 'cccccccccccc'))
  const { run, appended } = setup({ entries })

  const result = await run('u2') as any
  assert.equal(observerCalls.length, 0)
  assert.deepEqual(appended, [])
  assert.equal(result.compaction.firstKeptEntryId, 'u2')
})

for (const cancellation of ['event', 'shutdown'] as const) {
  test(`catch-up discards partial output after ${cancellation} cancellation without touching stale ctx`, async () => {
    observerCalls.length = 0
    observer.error = undefined
    const entered = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    observer.result = async () => {
      entered.resolve()
      await released.promise
      return [observation('cccccccccccc', ['t1'])]
    }
    const controller = new AbortController()
    const fixture = setup({ entries: laggingBranch(), signal: controller.signal })
    const pending = fixture.run('u2')
    await entered.promise
    if (cancellation === 'event') controller.abort()
    else await fixture.shutdown()
    assert.equal(observerCalls[0]!.signal?.aborted, true)
    let staleAccesses = 0
    const stale = () => { staleAccesses++; throw new Error('stale context') }
    Object.defineProperty(fixture.ctx, 'cwd', { get: stale })
    fixture.ctx.sessionManager.getBranch = stale
    released.resolve()
    assert.deepEqual(await pending, { cancel: true })
    assert.deepEqual(fixture.appended, [])
    assert.deepEqual(fixture.notifications, [])
    assert.equal(staleAccesses, 0)
    assert.equal(fixture.runtime.compactHookInFlight, false)
  })
}

test('catch-up cancels during model resolution and propagates unexpected registry errors', async () => {
  const fixture = setup({ entries: laggingBranch() })
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  fixture.runtime.resolveModel = async (ctx) => {
    entered.resolve()
    await released.promise
    ctx.signal?.throwIfAborted()
    return { ok: true, model: { provider: 'test', contextWindow: 65536 } }
  }
  const pending = fixture.run('u2')
  await entered.promise
  await fixture.shutdown()
  released.resolve()
  assert.deepEqual(await pending, { cancel: true })
  assert.deepEqual(fixture.appended, [])
  const fresh = setup({ entries: laggingBranch() })
  const failure = new Error('registry failure')
  fresh.runtime.resolveModel = async () => { throw failure }
  await assert.rejects(fresh.run('u2'), (error: unknown) => error instanceof Error && error.cause === failure)
  assert.deepEqual(fresh.appended, [])
  assert.equal(fresh.runtime.compactHookInFlight, false)
})

test('passive mode uses retention without automatic observer calls or ledger writes', async () => {
  observerCalls.length = 0
  const { run, appended, resolveCalls } = setup({ entries: laggingBranch(), passive: true })
  const result = await run('u2') as any
  assert.equal(result.compaction.firstKeptEntryId, 'a1')
  assert.equal(resolveCalls(), 0)
  assert.deepEqual(observerCalls, [])
  assert.deepEqual(appended, [])
})

for (const model of [
  { provider: 'opencode' },
  { provider: 'opencode-go' },
  { provider: 'custom', baseUrl: 'https://opencode.ai/zen/v1' },
]) {
  test(`catch-up includes session headers for ${model.provider}`, async () => {
    observerCalls.length = 0
    observer.error = undefined
    observer.result = async () => [observation('cccccccccccc', ['t1', 'a2'])]
    const headers = { Authorization: 'test' }
    const { run } = setup({ entries: laggingBranch(), resolved: { ok: true, model: { ...model, contextWindow: 65536 }, headers } })
    const result = await run('u2') as any
    assert.equal(result.compaction.firstKeptEntryId, 'u2')
    assert.deepEqual(observerCalls[0]!.headers, { ...headers, 'x-opencode-session': 'catch-up-session', 'x-opencode-client': 'pi' })
    assert.deepEqual(headers, { Authorization: 'test' })
  })
}

test('catch-up respects fallback thinking rather than the primary setting', async () => {
  observerCalls.length = 0
  observer.error = undefined
  observer.result = async () => [observation('cccccccccccc', ['t1', 'a2'])]
  const { run, runtime } = setup({ entries: laggingBranch(), resolved: { ok: true, model: { provider: 'test', contextWindow: 65536 }, fallbackUsed: true } })
  runtime.config.model = { provider: 'test', id: 'primary', thinking: 'high' }
  runtime.config.fallbackModel = { provider: 'test', id: 'fallback', thinking: 'off' }
  await run('u2')
  assert.equal(observerCalls[0]!.thinkingLevel, 'off')
})

test('visible memory snapshot matches budgeted summary while full history retains omitted records', async () => {
  const observations = Array.from({ length: 100 }, (_, i) => observation(i.toString(16).padStart(12, '0'), ['a0']))
  const reflections = Array.from({ length: 20 }, (_, i) => ({
    id: (i + 100).toString(16).padStart(12, '0'), content: 'Stable reflection '.repeat(10),
    supportingObservationIds: [observations[0].id], tokenCount: 45
  }))
  const entries = [userMessage('u0'), assistantMessage('a0'), {
    type: 'custom', id: 'om-a0', customType: OM_OBSERVATIONS_RECORDED, data: { observations, coversUpToId: 'a0' }
  } as Entry, {
    type: 'custom', id: 'reflections', customType: 'om.reflections.recorded', data: { reflections, coversUpToId: 'om-a0' }
  } as Entry, userMessage('u1')]
  const { run, runtime } = setup({ entries, summaryMaxTokens: 600 })
  runtime.config.observationsPoolMaxTokens = 1
  const result = await run('u1') as any
  const visibleIds = result.compaction.details.observations.map((item: Observation) => item.id)
  const renderedIds = observations.filter((item) => result.compaction.summary.includes(`[${item.id}]`)).map((item) => item.id)
  assert.ok(renderedIds.length > 0 && renderedIds.length < observations.length)
  assert.deepEqual(visibleIds, renderedIds)
  const compacted = [...entries, { type: 'compaction', id: 'compacted', ...result.compaction } as Entry]
  assert.deepEqual(visibleProjection(compacted).observations.map((item) => item.id), renderedIds)
  assert.deepEqual(fullProjection(compacted).observations, observations)
  const renderedReflectionIds = reflections.filter((item) => result.compaction.summary.includes(`[${item.id}]`)).map((item) => item.id)
  assert.ok(renderedReflectionIds.length > 0 && renderedReflectionIds.length < reflections.length)
  assert.deepEqual(visibleProjection(compacted).reflections.map((item) => item.id), renderedReflectionIds)
  assert.deepEqual(fullProjection(compacted).reflections, reflections)
})
