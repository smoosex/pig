import { expect, mock, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SubagentInfo } from '../src/shared/api'
import type { SubagentStore } from '../src/main/subagents/store'
import type { SubagentRunner } from '../src/main/subagents/runner'

mock.module('electron', () => ({ app: { isPackaged: false } }))
const { SubagentManager } = await import('../src/main/subagents/manager')
const tick = () => new Promise((resolve) => setTimeout(resolve, 10))
const request = { parentSessionId: 'p', toolCallId: 'call', cwd: '/repo', title: 'task', prompt: 'do it', background: false }
const ioError = () => Object.assign(new Error('storage failure'), { code: 'ENOSPC' })

function fixture(overrides: Partial<SubagentStore> = {}, runner?: SubagentRunner) {
  const errors: unknown[] = []
  const saved: SubagentInfo[][] = []
  const manager = new SubagentManager({
    store: { dir: () => '/tmp/p', load: async () => [], remove: async () => {}, save: async (_id, items) => { saved.push(items) }, ...overrides },
    runner: runner ?? { start: async () => ({ done: Promise.resolve({}), abort: () => {}, messages: () => [] }), readTranscript: async () => [] },
    settings: async () => ({ maxConcurrent: 1, maxTurns: 50, timeoutMinutes: 0 }),
    chooseModel: async () => ({}), onChange: () => {}, onError: (_id, error) => errors.push(error), coalesceMs: 0
  })
  return { manager, errors, saved }
}

test('index read failures reject load/spawn and never replace history', async () => {
  const error = Object.assign(new Error('broken index'), { code: 'EACCES' })
  let writes = 0
  const { manager } = fixture({ load: async () => { throw error }, save: async () => { writes++ } })
  await expect(manager.list('p')).rejects.toBe(error)
  await expect(manager.spawn(request)).rejects.toBe(error)
  await manager.closeParent('p')
  expect(writes).toBe(0)
})

test('corrupt JSON and invalid index shapes are never overwritten', async () => {
  const { createFileStore } = await import('../src/main/subagents/store')
  const root = await mkdtemp(join(tmpdir(), 'pig-subagent-corrupt-'))
  try {
    await mkdir(join(root, 'p'))
    const path = join(root, 'p', 'index.json')
    const store = createFileStore(() => root)
    const { manager } = fixture(store)
    await writeFile(path, '{broken')
    await expect(manager.list('p')).rejects.toBeInstanceOf(SyntaxError)
    expect(await readFile(path, 'utf8')).toBe('{broken')
    await writeFile(path, '{"subagents":null}')
    try {
      await manager.spawn(request)
      throw new Error('Expected invalid index to reject')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('ERR_SUBAGENT_INDEX')
    }
    expect(await readFile(path, 'utf8')).toBe('{"subagents":null}')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('initial index write failure rejects spawn before executing a model', async () => {
  const error = ioError()
  let starts = 0
  const { manager } = fixture({ save: async () => { throw error } }, {
    start: async () => { starts++; throw new Error('unexpected start') }, readTranscript: async () => []
  })
  await expect(manager.spawn(request)).rejects.toBe(error)
  expect(starts).toBe(0)
  expect(manager.snapshot('p')).toHaveLength(0)
})

test('terminal persistence failure fails the foreground result and reaches the UI boundary', async () => {
  const error = ioError()
  let writes = 0
  const { manager, errors } = fixture({ save: async () => { if (++writes === 3) throw error } })
  const result = await manager.spawn(request)
  expect(result.isError).toBe(true)
  expect(manager.snapshot('p')[0].status).toBe('failed')
  expect(errors).toEqual([error])
})

test('background persistence failure is visible and cannot deliver a completed result', async () => {
  const error = ioError()
  let writes = 0
  const { manager, errors } = fixture({ save: async () => { if (++writes === 3) throw error } })
  const deliveries: unknown[] = []
  manager.attach('p', (delivery) => deliveries.push(delivery))
  await manager.spawn({ ...request, background: true })
  await tick()
  expect(errors).toEqual([error])
  expect(deliveries).toEqual([])
  expect(manager.snapshot('p')[0].status).toBe('failed')
})

test('transcript-path persistence failure aborts the child and clear errors reject the invoke caller', async () => {
  const error = ioError()
  let writes = 0
  let aborted = false
  let finish!: () => void
  const done = new Promise<{}>((resolve) => { finish = () => resolve({}) })
  const { manager, errors } = fixture({ save: async () => { if (++writes >= 3) throw error } }, {
    start: async () => ({ sessionFile: '/tmp/child.jsonl', done, abort: () => { aborted = true; finish() }, messages: () => [] }),
    readTranscript: async () => []
  })
  const result = await manager.spawn(request)
  expect(aborted).toBe(true)
  expect(result.isError).toBe(true)
  expect(errors).toEqual([error])
  await expect(manager.clearFinished('p')).rejects.toBe(error)
  await expect(manager.closeParent('p')).rejects.toBe(error)
  expect(manager.snapshot('p')).toEqual([])
})

test('running transcript path is saved immediately; completed disk transcripts are read on demand after clearing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pig-subagent-memory-'))
  try {
    const path = join(root, 'child.jsonl')
    await writeFile(path, '{}')
    let finish!: () => void
    const done = new Promise<{}>((resolve) => { finish = () => resolve({}) })
    let reads = 0
    let snapshots = 0
    const messages = [{ role: 'assistant', content: [{ type: 'text', text: 'disk report' }] }]
    const { manager, saved } = fixture({}, {
      start: async () => ({ sessionFile: path, done, abort: finish, messages: () => { snapshots++; return messages } }),
      readTranscript: async () => { reads++; return messages }
    })
    const spawning = manager.spawn(request)
    await tick()
    expect(saved.some((items) => items[0]?.status === 'running' && items[0]?.sessionFile === path)).toBe(true)
    finish()
    await spawning
    expect(snapshots).toBe(0)
    expect(await manager.transcript('p', manager.snapshot('p')[0].id)).toEqual(messages)
    await manager.clearFinished('p')
    await manager.transcript('p', manager.snapshot('p')[0].id)
    expect(reads).toBe(2)
    expect(snapshots).toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
