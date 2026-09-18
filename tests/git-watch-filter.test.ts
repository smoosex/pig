/**
 * The worktree watch is what keeps the review panel honest, so the events it drops have to be the
 * noisy ones only: Pig's own data directory and git lock files, never a tracked file.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { gitWatchTargets, isGitLockEvent, isIgnoredWatchPath } from '../src/main/git/watch-path'
import { runGit } from '../src/main/git/run'

const run = promisify(execFile)
const git = (cwd: string, ...args: string[]) => run('git', ['-C', cwd, ...args])
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('isIgnoredWatchPath', () => {
  const cwd = '/repo'
  const dataDir = '/repo/.pig'

  test('drops Pig state writes inside the worktree', () => {
    expect(isIgnoredWatchPath(cwd, '.pig/sidebar.json', dataDir)).toBe(true)
    expect(isIgnoredWatchPath(cwd, '.pig/verify/open-project-sessions.json', dataDir)).toBe(true)
  })

  test('keeps worktree files even when the data directory lives elsewhere', () => {
    expect(isIgnoredWatchPath(cwd, '.pig/sidebar.json', '/home/me/.pig')).toBe(false)
    expect(isIgnoredWatchPath(cwd, 'src/app.ts', dataDir)).toBe(false)
    expect(isIgnoredWatchPath(cwd, 'bun.lock', dataDir)).toBe(false)
  })

  test('drops git lock files but keeps the index itself', () => {
    expect(isIgnoredWatchPath(cwd, '.git/index.lock', dataDir)).toBe(true)
    expect(isIgnoredWatchPath(cwd, '.git', dataDir)).toBe(false)
    expect(isIgnoredWatchPath(cwd, '.git/index', dataDir)).toBe(false)
    expect(isIgnoredWatchPath(cwd, '.git/HEAD', dataDir)).toBe(false)
  })
})

describe('gitWatchTargets', () => {
  test('adds nothing for a normal repository, whose git directory is inside the worktree', () => {
    expect(
      gitWatchTargets('/repo', {
        gitDir: '/repo/.git',
        index: '/repo/.git/index',
        refsDir: '/repo/.git/refs'
      })
    ).toEqual([])
  })

  test('watches the index, git directory and refs of a linked worktree', () => {
    expect(
      gitWatchTargets('/work/wt', {
        gitDir: '/work/main/.git/worktrees/wt',
        index: '/work/main/.git/worktrees/wt/index',
        refsDir: '/work/main/.git/refs'
      })
    ).toEqual([
      // The index first, and without the lock filter: git lands it by rename, and the watch on the file
      // is the only one that hears about that.
      { path: '/work/main/.git/worktrees/wt/index', filterLocks: false },
      { path: '/work/main/.git/worktrees/wt', filterLocks: true },
      { path: '/work/main/.git/refs', filterLocks: true }
    ])
  })

  test('resolves relative git paths against the worktree', () => {
    expect(
      gitWatchTargets('/work/wt', { gitDir: '../main/.git/worktrees/wt', index: '../main/.git/worktrees/wt/index', refsDir: '' })
    ).toEqual([
      { path: '/work/main/.git/worktrees/wt/index', filterLocks: false },
      { path: '/work/main/.git/worktrees/wt', filterLocks: true }
    ])
  })

  test('does not mistake a sibling directory for the worktree', () => {
    expect(
      gitWatchTargets('/work/wt', { gitDir: '/work/wt2/.git', index: '/work/wt2/.git/index', refsDir: '/work/wt2/.git/refs' })
    ).toHaveLength(3)
  })
})

describe('isGitLockEvent', () => {
  test('drops lock traffic by name', () => {
    expect(isGitLockEvent('index.lock')).toBe(true)
    expect(isGitLockEvent('logs/HEAD.lock')).toBe(true)
    expect(isGitLockEvent('refs/heads/feature.lock')).toBe(true)
  })

  test('keeps everything else, including a directory that merely ends in lock', () => {
    expect(isGitLockEvent('index')).toBe(false)
    expect(isGitLockEvent('logs/HEAD')).toBe(false)
    expect(isGitLockEvent('refs/heads/feature')).toBe(false)
    expect(isGitLockEvent('lock')).toBe(false)
  })
})

/**
 * The paths `watch.ts` resolves for a worktree, resolved the same way here so the test does not have to
 * import the electron-side module.
 */
async function gitPaths(cwd: string) {
  const [gitDir, commonDir, index] = await Promise.all([
    runGit(cwd, ['rev-parse', '--absolute-git-dir']),
    runGit(cwd, ['rev-parse', '--git-common-dir']),
    runGit(cwd, ['rev-parse', '--git-path', 'index'])
  ])
  return { gitDir: gitDir.trim(), index: index.trim(), refsDir: resolve(cwd, commonDir.trim(), 'refs') }
}

async function linkedWorktree(): Promise<{ main: string; wt: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pig-watch-'))
  temps.push(root)
  const main = join(root, 'main')
  const wt = join(root, 'wt')
  await run('git', ['init', '-q', '-b', 'main', main])
  await writeFile(join(main, 'base.txt'), 'base\n')
  await git(main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A')
  await git(main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base')
  await git(main, 'worktree', 'add', '-q', '-b', 'feature', wt)
  return { main, wt }
}

async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(50)
  }
  return predicate()
}

describe('the watches a linked worktree needs', () => {
  test('the git paths hear about staging and committing, the tree watch hears about neither', async () => {
    const { wt } = await linkedWorktree()
    await writeFile(join(wt, 'f.txt'), 'one\n')
    await sleep(400)

    const treeEvents: string[] = []
    const gitEvents: string[] = []
    const watchers: FSWatcher[] = [
      watch(wt, { recursive: true }, (_event, name) => treeEvents.push(name ?? ''))
    ]
    for (const target of gitWatchTargets(wt, await gitPaths(wt))) {
      watchers.push(
        watch(target.path, { recursive: true }, (_event, name) =>
          gitEvents.push(`${target.path}:${name ?? ''}`)
        )
      )
    }
    await sleep(400)

    // Staging writes the index under the main repository's .git/worktrees/<name>, and nothing at all
    // inside the worktree, so only the index watch can see it.
    await git(wt, 'add', 'f.txt')
    const staged = await waitFor(() => gitEvents.length > 0, 4000)
    expect(gitEvents.length, `no event for git add; tree saw ${JSON.stringify(treeEvents)}`).toBeGreaterThan(0)
    expect(staged).toBe(true)
    expect(treeEvents).toEqual([])

    gitEvents.length = 0
    await git(wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'f')
    // The index moves on a commit as well, so wait for the ref or reflog write that only a commit makes.
    const committed = await waitFor(() => gitEvents.some((event) => /HEAD|feature/.test(event)), 4000)
    expect(committed, `no ref or reflog event for git commit; saw ${JSON.stringify(gitEvents)}`).toBe(true)

    for (const watcher of watchers) watcher.close()
  }, 30_000)
})
