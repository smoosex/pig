import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { DiffWatchError, SessionApi } from '../src/shared/api'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const api: Partial<SessionApi> = {}
Object.defineProperty(globalThis, 'window', { value: { api }, configurable: true })

test('renderer shares one worktree watch and refreshes every active scope once', async () => {
  let changed: ((cwd: string) => void) | undefined
  let watchError: ((error: DiffWatchError) => void) | undefined
  let watches = 0
  let worktreeReads = 0
  let patchReads = 0
  const unwatched: string[] = []
  Object.assign(api, {
    readWorktreeDiff: async () => {
      worktreeReads += 1
      return { git: true, staged: [], unstaged: [], all: [] }
    },
    readWorktreePatch: async () => {
      patchReads += 1
      return { git: true, patch: '', truncated: false }
    },
    watchWorktreeDiff: async () => `lease-${++watches}`,
    unwatchWorktreeDiff: async (_cwd, leaseId) => { unwatched.push(leaseId) },
    onDiffChanged: (listener) => {
      changed = listener
      return () => { changed = undefined }
    },
    onDiffWatchError: (listener) => {
      watchError = listener
      return () => { watchError = undefined }
    }
  } satisfies Partial<SessionApi>)
  const { retainWorktreePatch, retainWorktreeWatch, useDiffStore } = await import('../src/renderer/src/stores/diff')
  const cwd = '/shared-watch'
  const releasePanel = retainWorktreeWatch(cwd, [1, 1])
  const releaseTab = retainWorktreeWatch(cwd, [1, 1])
  const releasePatch = retainWorktreePatch(cwd, 'all')
  await sleep(0)

  assert.equal(watches, 1)
  assert.equal(worktreeReads, 1)
  assert.equal(patchReads, 1)

  changed?.(cwd)
  await sleep(0)
  assert.equal(worktreeReads, 2)
  assert.equal(patchReads, 2)

  releasePanel()
  assert.deepEqual(unwatched, [])
  releasePatch()
  releaseTab()
  await sleep(0)
  assert.deepEqual(unwatched, ['lease-1'])
  assert.equal(changed, undefined)
  assert.equal(watchError, undefined)
  useDiffStore.getState().forgetWorktree(cwd)
})

test('a released acquisition returns its late lease and a retry success repairs the snapshot', async () => {
  let resolveLease: ((lease: string) => void) | undefined
  let calls = 0
  let reads = 0
  const unwatched: string[] = []
  const api = window.api as Partial<SessionApi>
  api.readWorktreeDiff = async () => {
    reads += 1
    return { git: true, staged: [], unstaged: [], all: [] }
  }
  api.watchWorktreeDiff = async () => {
    calls += 1
    if (calls === 1) return await new Promise<string>((resolve) => { resolveLease = resolve })
    if (calls === 2) throw new Error('EMFILE')
    return 'recovered'
  }
  api.unwatchWorktreeDiff = async (_cwd, leaseId) => { unwatched.push(leaseId) }
  api.onDiffChanged = () => () => {}
  api.onDiffWatchError = () => () => {}

  const { retainWorktreeWatch, useDiffStore } = await import('../src/renderer/src/stores/diff')
  const lateCwd = '/late-watch'
  const releaseLate = retainWorktreeWatch(lateCwd, [1, 1])
  releaseLate()
  resolveLease?.('late')
  await sleep(0)
  assert.deepEqual(unwatched, ['late'])

  const retryCwd = '/retry-watch'
  const releaseRetry = retainWorktreeWatch(retryCwd, [1, 1])
  await sleep(8)
  assert.equal(calls, 3)
  assert.equal(useDiffStore.getState().worktrees[retryCwd]?.watchError, undefined)
  assert.equal(reads, 3, 'initial reads for both entries plus one recovery snapshot')
  releaseRetry()
  await sleep(0)
  assert.deepEqual(unwatched, ['late', 'recovered'])
  useDiffStore.getState().forgetWorktree(lateCwd)
  useDiffStore.getState().forgetWorktree(retryCwd)
})

test('an error-state holder retries the read while ready and loading holders stay shared', async () => {
  const api = window.api as Partial<SessionApi>
  let reads = 0
  let failRead = true
  api.readWorktreeDiff = async () => {
    reads += 1
    if (failRead) throw new Error('read failed')
    return { git: true, staged: [], unstaged: [], all: [] }
  }
  api.watchWorktreeDiff = async () => 'read-lease'
  api.unwatchWorktreeDiff = async () => {}
  api.onDiffChanged = () => () => {}
  api.onDiffWatchError = () => () => {}

  const { retainWorktreeWatch, useDiffStore } = await import('../src/renderer/src/stores/diff')
  const cwd = '/read-retry'
  const first = retainWorktreeWatch(cwd, [])
  const whileLoading = retainWorktreeWatch(cwd, [])
  assert.equal(reads, 1, 'a loading snapshot is shared')
  await sleep(0)
  assert.equal(useDiffStore.getState().worktrees[cwd]?.status, 'error')

  failRead = false
  const afterError = retainWorktreeWatch(cwd, [])
  assert.equal(reads, 2, 'a new holder retries an errored snapshot')
  await sleep(0)
  const whileReady = retainWorktreeWatch(cwd, [])
  assert.equal(reads, 2, 'a ready snapshot is not reread for another holder')

  whileReady()
  afterError()
  whileLoading()
  first()
  useDiffStore.getState().forgetWorktree(cwd)
})

test('retry exhaustion goes quiet until a new holder starts a fresh retry round', async () => {
  const api = window.api as Partial<SessionApi>
  let watches = 0
  api.readWorktreeDiff = async () => ({ git: true, staged: [], unstaged: [], all: [] })
  api.watchWorktreeDiff = async () => {
    watches += 1
    throw new Error('EMFILE')
  }
  api.unwatchWorktreeDiff = async () => {}
  api.onDiffChanged = () => () => {}
  api.onDiffWatchError = () => () => {}

  const { retainWorktreeWatch, useDiffStore } = await import('../src/renderer/src/stores/diff')
  const cwd = '/exhausted-watch'
  const first = retainWorktreeWatch(cwd, [1, 1])
  await sleep(10)
  assert.equal(watches, 3, 'the initial attempt and two configured retries are finite')
  await sleep(10)
  assert.equal(watches, 3, 'an exhausted entry does not keep retrying')
  assert.match(useDiffStore.getState().worktrees[cwd]?.watchError ?? '', /EMFILE/)

  const second = retainWorktreeWatch(cwd, [1, 1])
  await sleep(10)
  assert.equal(watches, 6, 'a later holder opens one new finite retry round')
  await sleep(10)
  assert.equal(watches, 6)

  second()
  first()
  useDiffStore.getState().forgetWorktree(cwd)
})
