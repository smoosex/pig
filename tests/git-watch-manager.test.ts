import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { FSWatcher } from 'node:fs'
import type { DiffWatchError } from '../src/shared/api'
import { createWorktreeWatchManager } from '../src/main/git/watch-manager'

class FakeWatcher extends EventEmitter {
  closes = 0
  close(): void { this.closes += 1 }
  ref(): this { return this }
  unref(): this { return this }
}

const gitProbe = async (_cwd: string, args: string[]): Promise<string> => {
  if (args.includes('--absolute-git-dir')) return '/outside/worktree-git\n'
  if (args.includes('--git-common-dir')) return '/outside/common\n'
  return '/outside/worktree-git/index\n'
}

function setup(
  createWatch: (path: string, listener: (event: string, filename: string | null) => void) => FakeWatcher
) {
  let lease = 0
  const changed: string[] = []
  const errors: DiffWatchError[] = []
  const manager = createWorktreeWatchManager({
    watch: (path, _options, listener) => createWatch(path, listener) as unknown as FSWatcher,
    runGit: gitProbe,
    dataDir: () => '/pig-data',
    createLease: () => `lease-${++lease}`,
    sendChanged: (cwd) => changed.push(cwd),
    sendError: (error) => errors.push(error),
    debounceMs: 1
  })
  return { manager, changed, errors }
}

describe('worktree watch ownership', () => {
  test('an establishment failure closes every partial resource and permits a clean replacement', async () => {
    const watchers: FakeWatcher[] = []
    let calls = 0
    let fail = true
    const { manager, changed } = setup((_path, listener) => {
      calls += 1
      if (fail && calls === 3) throw new Error('target denied')
      const watcher = new FakeWatcher()
      watchers.push(watcher)
      if (calls === 1) listener('change', 'file.ts')
      return watcher
    })

    const first = manager.watchWorktree('/worktree')
    const second = manager.watchWorktree('/worktree')
    const results = await Promise.allSettled([first, second])
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect(watchers.map((watcher) => watcher.closes)).toEqual([1, 1])
    await Bun.sleep(5)
    expect(changed).toEqual([])

    fail = false
    const replacement = await manager.watchWorktree('/worktree')
    expect(replacement).toBe('lease-3')
    manager.unwatchWorktree('/worktree', replacement)
    expect(watchers.slice(2).every((watcher) => watcher.closes === 1)).toBe(true)
  })

  test('a target watcher created after its entry fails closes itself instead of leaking', async () => {
    const watchers: FakeWatcher[] = []
    let root: FakeWatcher | undefined
    const { manager } = setup((_path) => {
      const watcher = new FakeWatcher()
      watchers.push(watcher)
      if (!root) root = watcher
      else if (watchers.length === 2) root.emit('error', new Error('root failed during target creation'))
      return watcher
    })

    await expect(manager.watchWorktree('/late-target')).rejects.toThrow('root failed during target creation')
    expect(watchers).toHaveLength(2)
    expect(watchers.map((watcher) => watcher.closes)).toEqual([1, 1])
  })

  test('an old lease cannot release the watcher that replaced its failed entry', async () => {
    const roots: FakeWatcher[] = []
    let call = 0
    const { manager, errors } = setup((_path) => {
      const watcher = new FakeWatcher()
      if (call++ % 4 === 0) roots.push(watcher)
      return watcher
    })

    const oldLease = await manager.watchWorktree('/replace')
    roots[0].emit('error', new Error('watch died'))
    expect(errors).toEqual([{ cwd: '/replace', leaseId: oldLease, message: 'watch died' }])

    const newLease = await manager.watchWorktree('/replace')
    manager.unwatchWorktree('/replace', oldLease)
    expect(roots[1].closes).toBe(0)
    manager.unwatchWorktree('/replace', newLease)
    expect(roots[1].closes).toBe(1)
  })
})
