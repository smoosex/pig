import { describe, expect, mock, test } from 'bun:test'
import type { SubagentInfo, SubagentSettings } from '../src/shared/api'
import type { SubagentDelivery } from '../src/main/plugins/pig-subagent-host'
import type { SubagentManager as Manager } from '../src/main/subagents/manager'
import type { RunEvent, RunResult, RunSpec, SubagentRunner } from '../src/main/subagents/runner'
import type { SubagentStore } from '../src/main/subagents/store'

mock.module('electron', () => ({ app: { isPackaged: false } }))
const { SubagentManager } = await import('../src/main/subagents/manager')
const { backgroundAck, formatReport } = await import('../src/main/subagents/result')
const { chooseModel } = await import('../src/main/subagents/runner')
const { interruptStale } = await import('../src/main/subagents/store')

interface FakeRun {
  spec: RunSpec
  emit: (event: RunEvent) => void
  finish: (result?: RunResult) => void
  aborted: boolean
}

function harness(settings: Partial<SubagentSettings> = {}) {
  const runs: FakeRun[] = []
  const saved = new Map<string, SubagentInfo[]>()
  const deliveries: SubagentDelivery[] = []
  const runner: SubagentRunner = {
    async start(spec, onEvent) {
      let finish!: (result?: RunResult) => void
      const done = new Promise<RunResult>((resolve) => { finish = (result = {}) => resolve(result) })
      const run: FakeRun = { spec, emit: onEvent, finish, aborted: false }
      runs.push(run)
      return {
        done,
        abort: () => {
          run.aborted = true
          finish()
        },
        messages: () => []
      }
    },
    readTranscript: async () => []
  }
  const store: SubagentStore = {
    dir: (id) => `/tmp/${id}`,
    load: async (id) => saved.get(id) ?? [],
    save: async (id, items) => { saved.set(id, items) },
    remove: async (id) => { saved.delete(id) }
  }
  const manager = new SubagentManager({
    runner,
    store,
    settings: async () => ({ maxConcurrent: 2, timeoutMinutes: 0, maxTurns: 0, ...settings }),
    chooseModel: async (_settings, parent) => ({ model: parent.model }),
    onChange: () => {},
    onError: (_id, error) => { throw error },
    coalesceMs: 5
  })
  manager.attach('parent', (delivery) => deliveries.push(delivery))
  return { manager, runs, saved, deliveries, store }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function request(title: string, background: boolean, extra: Record<string, unknown> = {}) {
  return { parentSessionId: 'parent', toolCallId: `call-${title}`, cwd: '/repo', title, prompt: `do ${title}`, background, ...extra }
}

function status(manager: Manager): Record<string, string> {
  return Object.fromEntries(manager.snapshot('parent').map((item) => [item.title, item.status]))
}

describe('subagent manager', () => {
  test('explicit restart preserves identity and resumes only an unfinished transcript', async () => {
    const { manager, runs, deliveries } = harness({ maxTurns: 1 })
    const spawned = await manager.spawn(request('resume', true))
    await tick()
    runs[0].emit({ type: 'turn_start' })
    runs[0].finish({ error: 'failed' })
    await tick()
    const info = manager.snapshot('parent')[0]
    const args = { parentSessionId: 'parent', id: spawned.id, cwd: '/repo', instruction: 'verify changes' }
    await expect(manager.restart(args)).rejects.toThrow('transcript is unavailable')
    await expect(manager.restart({ ...args, parentSessionId: 'other' })).rejects.toThrow('not found')
    info.sessionFile = import.meta.path
    const [first, second] = await Promise.allSettled([manager.restart(args), manager.restart(args)])
    expect(first.status).toBe('fulfilled')
    expect(second.status).toBe('rejected')
    await tick()
    expect(runs[1].spec.resumeFile).toBe(import.meta.path)
    expect(runs[1].spec.prompt).toContain('verify changes')
    runs[1].emit({ type: 'turn_start' })
    expect(runs[1].aborted).toBe(false)
    runs[1].finish()
    await wait(15)
    expect(manager.snapshot('parent')[0]).toMatchObject({ id: spawned.id, status: 'completed' })
    expect(deliveries.some((delivery) => delivery.text.includes('completed'))).toBe(true)
    expect(deliveries.some((delivery) => delivery.text.includes('failed'))).toBe(false)
    await expect(manager.restart(args)).rejects.toThrow('Completed')
    await manager.closeParent('parent')
  })

  test('restart cancellation before queueing rejects, but cancellation after acknowledgement does not stop the child', async () => {
    const { manager, runs } = harness()
    const spawned = await manager.spawn(request('cancel-restart', true))
    await tick()
    runs[0].finish({ error: 'failed' })
    await tick()
    manager.snapshot('parent')[0].sessionFile = import.meta.path
    const args = { parentSessionId: 'parent', id: spawned.id, cwd: '/repo' }
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(manager.restart({ ...args, signal: cancelled.signal })).rejects.toThrow()
    expect(manager.snapshot('parent')[0].status).toBe('failed')
    const controller = new AbortController()
    await manager.restart({ ...args, signal: controller.signal })
    controller.abort()
    await tick()
    expect(runs[1].aborted).toBe(false)
    runs[1].finish()
    await manager.closeParent('parent')
  })

  test.each(['cancel', 'failure', 'close'] as const)('restart is not scheduled while saving: %s', async (scenario) => {
    const { manager, runs, store, saved } = harness({ maxConcurrent: 1 })
    const spawned = await manager.spawn(request('restart', true))
    await tick()
    runs[0].finish({ error: 'failed' })
    await tick()
    const old = manager.snapshot('parent')[0]
    old.sessionFile = import.meta.path
    old.fallbackReason = 'old fallback'
    old.model = { provider: 'old', id: 'old' }
    await manager.spawn(request('other', true))
    await tick()
    const save = store.save
    let release!: () => void
    let entered!: () => void
    const enteredSave = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    let block = true
    store.save = async (id, items) => {
      if (block && items.some((item) => item.id === spawned.id && item.status === 'queued')) {
        block = false
        entered()
        await gate
        if (scenario === 'failure') throw new Error('save failed')
      }
      await save(id, items)
    }
    const controller = new AbortController()
    const restarting = manager.restart({ parentSessionId: 'parent', id: spawned.id, cwd: '/repo', signal: controller.signal,
      parentModel: { provider: 'new', id: 'new' } })
    const result = restarting.then(() => null, (error: unknown) => error)
    await enteredSave
    expect(manager.snapshot('parent').find((item) => item.id === spawned.id)).toMatchObject({ model: { provider: 'new', id: 'new' }, fallbackReason: undefined })
    runs[1].finish()
    await tick()
    expect(runs).toHaveLength(2)
    if (scenario === 'cancel') controller.abort()
    const closing = scenario === 'close' ? manager.closeParent('parent') : undefined
    release()
    expect(await result).toBeInstanceOf(Error)
    if (closing) await closing
    else {
      expect(manager.snapshot('parent').find((item) => item.id === spawned.id)).toMatchObject({ status: 'failed', fallbackReason: 'old fallback', model: { provider: 'old', id: 'old' } })
      expect(saved.get('parent')?.find((item) => item.id === spawned.id)?.status).toBe('failed')
      await manager.closeParent('parent')
    }
    expect(runs).toHaveLength(2)
  })

  test('restart updates model and clears stale fallback on successful commit', async () => {
    const { manager, runs } = harness()
    const spawned = await manager.spawn(request('model', true))
    await tick()
    runs[0].finish({ error: 'failed' })
    await tick()
    const old = manager.snapshot('parent')[0]
    old.sessionFile = import.meta.path
    old.fallbackReason = 'old fallback'
    old.model = { provider: 'old', id: 'old' }
    await manager.restart({ parentSessionId: 'parent', id: spawned.id, cwd: '/repo', parentModel: { provider: 'new', id: 'new' } })
    await tick()
    expect(manager.snapshot('parent')[0]).toMatchObject({ model: { provider: 'new', id: 'new' }, fallbackReason: undefined })
    expect(runs[1].spec.model).toEqual({ provider: 'new', id: 'new' })
    runs[1].finish()
    await manager.closeParent('parent')
  })

  test('parallel spawns persist distinct animals and balanced colors within each user run', async () => {
    const { manager, saved } = harness({ maxConcurrent: 1 })
    try {
      for (const parentTurnId of ['question-one', 'question-two']) {
        await Promise.all(Array.from({ length: 12 }, (_, i) =>
          manager.spawn(request(`${parentTurnId}-${i}`, true, { parentTurnId }))))
        const items = manager.snapshot('parent').filter((item) => item.parentTurnId === parentTurnId)
        expect(new Set(items.map((item) => item.appearance?.animal)).size).toBe(12)
        expect(new Set(items.slice(0, 7).map((item) => item.appearance?.color)).size).toBe(7)
        expect(saved.get('parent')?.filter((item) => item.parentTurnId === parentTurnId).map((item) => item.appearance))
          .toEqual(items.map((item) => item.appearance))
      }
    } finally {
      await manager.closeParent('parent')
    }
  })

  test('background children queue beyond the limit; foreground ones start immediately', async () => {
    const { manager, runs } = harness()
    await manager.spawn(request('a', true))
    await manager.spawn(request('b', true))
    const third = await manager.spawn(request('c', true))
    await tick()
    expect(third.text).toContain('queued: position 1')
    expect(status(manager)).toEqual({ a: 'running', b: 'running', c: 'queued' })

    const foreground = manager.spawn(request('fg', false))
    await tick()
    expect(status(manager).fg).toBe('running')

    runs[0].finish()
    await tick()
    expect(status(manager).c).toBe('running')

    runs.find((run) => run.spec.prompt === 'do fg')!.emit({ type: 'assistant', text: 'report', thinking: false, usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 }, cost: 0 })
    runs.find((run) => run.spec.prompt === 'do fg')!.finish()
    const outcome = await foreground
    expect(outcome.isError).toBe(false)
    expect(outcome.text).toContain('fg — completed')
    expect(outcome.text).toContain('report')
  })

  test('stopping the parent run aborts a foreground child and keeps its partial report', async () => {
    const { manager, runs } = harness()
    const controller = new AbortController()
    const pending = manager.spawn(request('fg', false, { signal: controller.signal }))
    await tick()
    runs[0].emit({ type: 'assistant', text: 'half done', thinking: false, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, cost: 0 })
    controller.abort()
    const outcome = await pending
    expect(runs[0].aborted).toBe(true)
    expect(runs[0].spec.signal?.aborted).toBe(true)
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain('— aborted')
    expect(outcome.text).toContain('half done')
  })

  test('usage adds up per model call and skips messages that report none', async () => {
    const { manager, runs } = harness()
    const pending = manager.spawn(request('fg', false))
    await tick()
    runs[0].emit({ type: 'assistant', text: '', thinking: false, usage: { input: 10, output: 2, cacheRead: 100, cacheWrite: 5 }, cost: 0.1 })
    runs[0].emit({ type: 'assistant', text: '', thinking: false, cost: 0 })
    runs[0].emit({ type: 'assistant', text: 'done', thinking: false, usage: { input: 3, output: 4, cacheRead: 110, cacheWrite: 0 }, cost: 0.2 })
    runs[0].finish()
    await pending
    const info = manager.snapshot('parent')[0]
    expect(info.usage).toEqual({ input: 13, output: 6, cacheRead: 210, cacheWrite: 5, total: 234, calls: 2 })
    expect(info.cost).toBeCloseTo(0.3)
  })

  test('turn and time limits stop the child with their own status', async () => {
    const { manager, runs } = harness({ maxTurns: 2, timeoutMinutes: 0 })
    const pending = manager.spawn(request('fg', false))
    await tick()
    runs[0].emit({ type: 'turn_start' })
    runs[0].emit({ type: 'tool', name: 'edit', args: { path: 'src/a.ts' } })
    runs[0].emit({ type: 'assistant', text: '', thinking: true, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, cost: 0 })
    runs[0].emit({ type: 'turn_start' })
    runs[0].emit({ type: 'turn_start' })
    const outcome = await pending
    expect(runs[0].aborted).toBe(true)
    const info = manager.snapshot('parent')[0]
    expect(info.status).toBe('turn_limit')
    expect(info.turns).toBe(2)
    expect(info.editedFiles).toEqual(['src/a.ts'])
    expect(info.turnTools).toEqual([{ tools: ['edit'], thinking: true }, { tools: [], thinking: false }])
    expect(outcome.text).toContain('Stopped after 2 turns')
  })

  test('background results that finish together arrive as one delivery, after a deliverer attaches', async () => {
    const { manager, runs, deliveries } = harness()
    await manager.spawn(request('a', true))
    await manager.spawn(request('b', true))
    await tick()
    const deliver = (delivery: SubagentDelivery) => deliveries.push(delivery)
    manager.attach('parent', deliver)
    await tick()
    manager.detach('parent', deliver)
    runs[0].finish()
    runs[1].finish({ error: 'boom' })
    await wait(20)
    expect(deliveries).toHaveLength(0)
    manager.attach('parent', deliver)
    await tick()
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0].text).toContain('a — completed')
    expect(deliveries[0].text).toContain('b — failed')
    expect(deliveries[0].details).toEqual({
      subagents: [
        { id: manager.snapshot('parent')[0].id, title: 'a', status: 'completed' },
        { id: manager.snapshot('parent')[1].id, title: 'b', status: 'failed' }
      ]
    })
  })

  test('closing the parent interrupts every child without delivering', async () => {
    const { manager, runs, saved, deliveries } = harness({ maxConcurrent: 1 })
    await manager.spawn(request('a', true))
    await manager.spawn(request('b', true))
    await tick()
    await manager.closeParent('parent')
    expect(runs[0].aborted).toBe(true)
    expect(runs).toHaveLength(1)
    await wait(20)
    expect(deliveries).toHaveLength(0)
    expect(saved.get('parent')!.map((item) => item.status)).toEqual(['interrupted', 'interrupted'])
  })

  test('clearing finished children hides them but keeps the record', async () => {
    const { manager, runs } = harness()
    await manager.spawn(request('a', true))
    await manager.spawn(request('b', true))
    await tick()
    runs[0].finish()
    await tick()
    await manager.clearFinished('parent')
    expect(manager.snapshot('parent').map((item) => [item.title, !!item.cleared])).toEqual([['a', true], ['b', false]])
  })
})

test('closing the parent aborts a child even while its runner is still starting', async () => {
  let enter!: (spec: RunSpec) => void
  const entered = new Promise<RunSpec>((resolve) => { enter = resolve })
  let release!: () => void
  const starting = new Promise<void>((resolve) => { release = resolve })
  let ran = false
  const manager = new SubagentManager({
    runner: {
      async start(spec) {
        enter(spec)
        await starting
        spec.signal?.throwIfAborted()
        ran = true
        return { done: Promise.resolve({}), abort: () => {}, messages: () => [] }
      },
      readTranscript: async () => []
    },
    store: { dir: () => '/unused', load: async () => [], save: async () => {}, remove: async () => {} },
    settings: async () => ({ maxConcurrent: 1, timeoutMinutes: 0, maxTurns: 0 }),
    chooseModel: async () => ({}), onChange: () => {}, onError: (_id, error) => { throw error }
  })
  await manager.spawn(request('pending', true))
  const spec = await entered
  const closing = manager.closeParent('parent')
  expect(spec.signal?.aborted).toBe(true)
  release()
  await closing
  expect(ran).toBe(false)
})

test('parent removal waits for the final index write before deleting files', async () => {
  let release!: () => void
  const writing = new Promise<void>((resolve) => { release = resolve })
  let removed = false
  let finished = false
  const manager = new SubagentManager({
    runner: { start: async () => { throw new Error('unused') }, readTranscript: async () => [] },
    store: {
      dir: () => '/unused', load: async () => [],
      save: () => writing,
      remove: async () => { removed = true }
    },
    settings: async () => ({ maxConcurrent: 1, timeoutMinutes: 0, maxTurns: 0 }),
    chooseModel: async () => ({}), onChange: () => {}, onError: (_id, error) => { throw error }
  })
  await manager.list('parent')
  const removing = manager.removeParent('parent').then(() => { finished = true })
  await tick()
  expect(removed).toBe(false)
  expect(finished).toBe(false)
  release()
  await removing
  expect(removed).toBe(true)
})

describe('subagent model choice', () => {
  const parent = { model: { provider: 'p', id: 'parent' }, thinkingLevel: 'high' as const }
  const lookup = (available: boolean, exists: boolean) => ({ available: () => available, exists: () => exists })

  test('follows the parent when nothing is configured', () => {
    expect(chooseModel({ thinkingLevel: 'low' }, parent, lookup(true, true))).toEqual({ model: parent.model, thinkingLevel: 'high' })
  })

  test('uses a configured model that has credentials', () => {
    const configured = { model: { provider: 'q', id: 'cheap' } }
    expect(chooseModel(configured, parent, lookup(true, true))).toEqual({ model: configured.model, thinkingLevel: 'high' })
  })

  test('falls back to the parent model and thinking level, saying why', () => {
    const configured = { model: { provider: 'q', id: 'cheap' }, thinkingLevel: 'low' as const }
    expect(chooseModel(configured, parent, lookup(false, true))).toEqual({
      ...parent, fallbackReason: 'q/cheap has no credentials'
    })
    expect(chooseModel(configured, parent, lookup(false, false)).fallbackReason).toBe('q/cheap is not available')
  })
})

describe('subagent reports', () => {
  const base: SubagentInfo = {
    id: 'abcd1234', parentSessionId: 'parent', toolCallId: 'call', title: 'Map IPC', prompt: 'p', background: true,
    status: 'completed', model: { provider: 'p', id: 'm' }, fallbackReason: 'q/x is not available',
    createdAt: 0, startedAt: 0, endedAt: 221_000, turns: 12, maxTurns: 50, turnTools: [], toolCounts: {},
    editedFiles: [], usage: { input: 8_000, output: 6_000, cacheRead: 39_000, cacheWrite: 1_000, total: 54_000, calls: 12 }, cost: 0.4, sessionFile: '/s/child.jsonl'
  }

  test('carries status, model fallback, usage and the report', () => {
    const text = formatReport({ ...base, output: 'Found 3 usages.' })
    expect(text.split('\n').slice(0, 3)).toEqual([
      '[subagent #abcd1234] Map IPC — completed',
      'model: p/m (fallback: q/x is not available)',
      'turns: 12 · duration: 3m41s · tokens: 48k in / 6k out'
    ])
    expect(text.endsWith('Found 3 usages.')).toBe(true)
  })

  test('truncates long reports and points at the transcript', () => {
    const text = formatReport({ ...base, output: Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n') })
    expect(text).toContain('line 0')
    expect(text).not.toContain('line 2999')
    expect(text).toContain('[Report truncated. Full transcript: /s/child.jsonl]')
  })

  test('failures keep the error and the partial report', () => {
    const text = formatReport({ ...base, status: 'timeout', error: 'Stopped after 30 minutes', output: 'partial findings' })
    expect(text).toContain('error: Stopped after 30 minutes')
    expect(text).toContain('partial findings')
  })

  test('background acknowledgement forbids assuming the outcome', () => {
    expect(backgroundAck(base, 0)).toContain('Do not assume its outcome')
  })
})

test('a restart interrupts children that were still queued or running', () => {
  const items = [
    { status: 'running' }, { status: 'queued' }, { status: 'completed', endedAt: 5 }
  ] as SubagentInfo[]
  expect(interruptStale(items, 9).map((item) => [item.status, item.endedAt])).toEqual([
    ['interrupted', 9], ['interrupted', 9], ['completed', 5]
  ])
})

test('an incomplete timeline and legacy usage are rebuilt from the transcript when the index loads', async () => {
  const transcript = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '' }, { type: 'toolCall', name: 'read' }, { type: 'toolCall', name: 'bash' }],
      usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 300, cost: { total: 0.01 } } },
    { role: 'toolResult', content: [] },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }], usage: { input: 4, output: 9, cacheRead: 300, cacheWrite: 0, cost: { total: 0.02 } } }
  ]
  const legacy = {
    id: 'old', parentSessionId: 'parent', toolCallId: 'c', title: 'Old', prompt: 'p', background: true,
    status: 'completed', createdAt: 0, turns: 2, maxTurns: 50, toolCounts: { read: 1, bash: 1 }, editedFiles: [],
    tokens: { input: 0, output: 0 }, cost: 0, sessionFile: '/s/old.jsonl',
    turnTools: [{ calls: [], omitted: 2 }, { calls: [], omitted: 0 }]
  }
  const { createFileStore } = await import('../src/main/subagents/store')
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const root = await mkdtemp(join(tmpdir(), 'pig-subagent-store-'))
  try {
    await mkdir(join(root, 'parent'))
    await writeFile(join(root, 'parent', 'index.json'), JSON.stringify({ version: 1, subagents: [legacy] }))
    const store = createFileStore(() => root)
    const manager = new SubagentManager({
      runner: { start: async () => { throw new Error('unused') }, readTranscript: async () => transcript },
      store,
      settings: async () => ({ maxConcurrent: 1, timeoutMinutes: 0, maxTurns: 0 }),
      chooseModel: async () => ({}),
      onChange: () => {}, onError: (_id, error) => { throw error }
    })
    const [item] = await manager.list('parent')
    expect(item.turnTools).toEqual([{ tools: ['read', 'bash'], thinking: true }, { tools: [], thinking: false }])
    await wait(20)
    const saved = JSON.parse(await readFile(join(root, 'parent', 'index.json'), 'utf8'))
    expect(saved.subagents[0].turnTools).toEqual(item.turnTools)
    // Folded legacy tokens are replaced by the transcript's breakdown, not carried over.
    expect(item.usage).toEqual({ input: 24, output: 14, cacheRead: 300, cacheWrite: 300, total: 638, calls: 2 })
    expect(item.cost).toBeCloseTo(0.03)
    expect('tokens' in saved.subagents[0]).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
