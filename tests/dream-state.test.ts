import { test, mock } from 'bun:test'
import assert from 'node:assert/strict'
import type { DreamStatus } from '../src/shared/dream'
import { runSelf } from './helpers/subprocess'

if (process.argv.includes('--dream-state-fixture')) {
  const idle: DreamStatus = { state: 'idle', changes: [], input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0, costKnown: true, requests: 0 }
  const running: DreamStatus = { ...idle, id: 'run', topic: 'Topic', state: 'running' }
  let resolveRead!: (status: DreamStatus) => void
  let starts = 0, stops = 0, reads = 0
  mock.module('../src/renderer/src/ipc/api', () => ({ api: {
    getMemorySettings: async () => ({ fileMemory: { enabled: true } }),
    dream: {
      status: () => { reads++; return new Promise<DreamStatus>(resolve => { resolveRead = resolve }) },
      start: async () => { starts++; return running },
      stop: async () => { stops++; return { ...running, state: 'cancelled' as const } }
    }
  } }))
  const { useDreamStore } = await import('../src/renderer/src/stores/dream')
  const state = () => useDreamStore.getState()
  useDreamStore.setState({ status: idle, draft: 'Topic' })
  const oldRead = state().refresh()
  await state().start()
  resolveRead(idle); await oldRead
  assert.equal(state().status?.state, 'running', 'a pre-start status read cannot restore idle')
  state().openDialog(true); state().closeDialog()
  assert.equal(starts, 1)
  assert.equal(stops, 0)
  assert.equal(state().status?.state, 'running')
  const oldRunningRead = state().refresh()
  await state().stop()
  resolveRead(running); await oldRunningRead
  assert.equal(state().status?.state, 'cancelled', 'a pre-stop read cannot revive running')
  assert.equal(stops, 1)
  assert.equal(reads, 2)
  state().openDialog()
  await Promise.resolve()
  assert.equal(state().enabled, true)
  assert.equal(starts, 1)
} else test('Dream status rejects stale polling responses and closing/reopening never controls the task', async () => {
  const result = await runSelf(import.meta.path, ['--dream-state-fixture'])
  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
})
