import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { runDropper } from '../src/main/plugins/observational-memory/agents/dropper/agent'
import type { Entry, Observation, Reflection } from '../src/main/plugins/observational-memory/session-ledger/types'

type DropperArgs = Parameters<typeof runDropper>[0]
type DropperLoop = NonNullable<DropperArgs['agentLoop']>
type LoopArgs = Parameters<DropperLoop>

async function fixture(): Promise<void> {
  const { mock } = await import('bun:test')
  const { observationPoolMetrics, observationTokenSum } = await import('../src/main/plugins/observational-memory/agents/dropper/pool')
  const { boundWorkerMemory } = await import('../src/main/plugins/observational-memory/session-ledger')
  const actualRunDropper = (await import('../src/main/plugins/observational-memory/agents/dropper/agent')).runDropper
  const { Runtime } = await import('../src/main/plugins/observational-memory/runtime')
  const observations: Observation[] = Array.from({ length: 30 }, (_, i) => ({
    id: i.toString(16).padStart(12, '0'), content: 'x'.repeat(1960),
    timestamp: '2026-01-01T00:00:00.000Z', relevance: 'medium', sourceEntryIds: ['source'], tokenCount: 490
  }))
  const reflection: Reflection = {
    id: 'eeeeeeeeeeee', content: 'Stable memory', supportingObservationIds: observations.map((item) => item.id), tokenCount: 3
  }
  const targetTokens = 10_000
  const budget = 8192
  const metrics = observationPoolMetrics(observations, targetTokens)
  const candidates = boundWorkerMemory([reflection], observations, budget, { observationsFrom: 'oldest' }).observations
  assert.ok(metrics.observationTokens > targetTokens)
  assert.ok(observationTokenSum(candidates) < targetTokens, 'the candidate subset alone looks below target')
  assert.ok(candidates.length < observations.length)
  let calls = 0
  let toolCalls = 0
  mock.module('../src/main/plugins/observational-memory/agents/reflector/agent.ts', () => ({ runReflector: async () => [reflection] }))
  mock.module('../src/main/plugins/observational-memory/agents/dropper/agent.ts', () => ({
    runDropper: async (args: DropperArgs) => {
      calls++
      assert.deepEqual(args.observations, candidates)
      assert.deepEqual(args.poolMetrics, metrics, 'eligibility is computed from the full active pool')
      const loop = ((prompts: LoopArgs[0], context: LoopArgs[1]) => ({
        async *[Symbol.asyncIterator]() {
          const prompt = JSON.stringify(prompts)
          assert.ok(prompt.includes(`~${metrics.observationTokens.toLocaleString()} tokens`))
          assert.ok(prompt.includes(`Maximum drops allowed this run: ${metrics.maxDropsAllowed}`))
          const tool = context.tools?.[0]
          assert.ok(tool)
          toolCalls++
          // A model may propose ids outside its bounded input; those remain protected.
          await tool.execute('drop-1', { ids: [...candidates.map((item) => item.id), observations.at(-1)!.id, 'ffffffffffff'] })
        },
        result: async () => []
      })) as unknown as DropperLoop
      return actualRunDropper({ ...args, agentLoop: loop })
    }
  }))
  const { runConsolidationPipeline } = await import('../src/main/plugins/observational-memory/hooks/consolidation-trigger')
  const entries: Entry[] = [
    { type: 'message', id: 'source', message: { role: 'user', content: 'Already observed content', timestamp: 1 } },
    { type: 'custom', id: 'om-source', customType: 'om.observations.recorded', data: { observations, coversUpToId: 'source' } }
  ]
  const writes: Array<{ customType: string; data: unknown }> = []
  const pi = {
    appendEntry: (customType: string, data: unknown) => {
      writes.push({ customType, data })
      entries.push({ type: 'custom', id: `write-${writes.length}`, customType, data })
    }
  } as unknown as ExtensionAPI
  const runtime = new Runtime()
  Object.assign(runtime.config, { observeAfterTokens: 100_000, reflectAfterTokens: 1, workerMemoryMaxTokens: budget, observationsPoolTargetTokens: targetTokens, showWorkerNotifications: false })
  const notifications: string[] = []
  runtime.notifications = { notify: (message) => notifications.push(message) }
  await runConsolidationPipeline(pi, runtime, {
    signal: new AbortController().signal, cwd: '/project',
    model: { provider: 'test', contextWindow: 65_536, maxTokens: 1000 },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'key' }) },
    sessionManager: { getBranch: () => entries, getSessionId: () => 'dropper-budget' }
  })
  assert.equal(calls, 1)
  assert.equal(toolCalls, 1, 'the real dropper must execute even though bounded candidates fit under the target')
  assert.deepEqual(notifications, [])
  assert.deepEqual(writes.map((item) => item.customType), ['om.reflections.recorded', 'om.observations.dropped'])
  const dropped = writes[1].data as { observationIds: string[] }
  assert.equal(dropped.observationIds.length, metrics.maxDropsAllowed)
  assert.ok(dropped.observationIds.every((id) => candidates.some((item) => item.id === id)))
}

if (process.argv.includes('--dropper-budget-fixture')) {
  await fixture()
} else {
  test('bounded dropper candidates use full-pool eligibility and never drop an unsupplied id', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--dropper-budget-fixture'], { stdout: 'pipe', stderr: 'pipe' })
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
