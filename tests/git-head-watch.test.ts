import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, watch, type FSWatcher } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHeadWatchManager } from '../src/main/git/head-watch'

class FakeWatcher extends EventEmitter {
  closed = false
  constructor(readonly path: string, readonly listener: (event: string, filename: string | null) => void) { super() }
  close(): void { this.closed = true }
}

function setup() {
  const watchers: FakeWatcher[] = []
  const changed: string[] = []
  const manager = createHeadWatchManager({
    watch: (path, listener) => {
      const watcher = new FakeWatcher(path, listener)
      watchers.push(watcher)
      return watcher as unknown as FSWatcher
    },
    gitDir: async (cwd) => `${cwd}/.git\n`,
    onChange: (cwd) => changed.push(cwd),
    debounceMs: 1
  })
  return { manager, watchers, changed }
}

describe('branch HEAD watch', () => {
  test('only HEAD writes refresh the project, debounced across its worktrees', async () => {
    const { manager, watchers, changed } = setup()
    await manager.sync('/p', ['/p', '/w'])
    expect(watchers.map((watcher) => watcher.path)).toEqual(['/p/.git', '/w/.git'])
    watchers[0].listener('rename', 'index')
    watchers[0].listener('rename', 'HEAD.lock')
    watchers[0].listener('rename', 'HEAD')
    watchers[1].listener('rename', 'HEAD')
    await Bun.sleep(10)
    expect(changed).toEqual(['/p'])
  })

  test('a listing closes dropped worktrees, and forgetting a project silences pending refreshes', async () => {
    const { manager, watchers, changed } = setup()
    await manager.sync('/p', ['/p', '/w'])
    await manager.sync('/p', ['/p'])
    expect(watchers.map((watcher) => watcher.closed)).toEqual([false, true])
    watchers[0].listener('rename', 'HEAD')
    manager.retain([])
    await Bun.sleep(10)
    expect(watchers[0].closed).toBe(true)
    expect(changed).toEqual([])
  })

  test('a real checkout is reported through the git directory watch', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'pig-head-watch-'))
    const run = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
    const changed: string[] = []
    const manager = createHeadWatchManager({
      watch: (path, listener) => watch(path, listener),
      gitDir: async () => join(repo, '.git'),
      onChange: (cwd) => changed.push(cwd),
      debounceMs: 1
    })
    try {
      run('init', '-q', '-b', 'main')
      run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
      await manager.sync(repo, [repo])
      // Anything init or commit left in flight must not pass for the checkout.
      await Bun.sleep(100)
      changed.length = 0
      run('checkout', '-q', '-b', 'feat/x')
      for (let i = 0; i < 50 && !changed.length; i++) await Bun.sleep(20)
      expect(changed).toEqual([repo])
    } finally {
      manager.forget(repo)
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
