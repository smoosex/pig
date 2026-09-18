/**
 * The review panel refreshes on `diff:changed` and nothing else, so this drives the real `watchWorktree`
 * against a real linked worktree: its index lives in the main repository's `.git/worktrees/<name>`, which
 * a recursive watch of the worktree cannot see. `watch.ts` imports electron, and the mock is process-wide,
 * so the fixture runs in a child process.
 */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const git = (cwd: string, ...args: string[]) => run('git', ['-C', cwd, ...args])
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(50)
  }
  return predicate()
}

async function runFixture(): Promise<void> {
  const sent: string[] = []
  mock.module('electron', () => ({
    app: { isPackaged: false, getPath: () => tmpdir() },
    BrowserWindow: {
      getAllWindows: () => [
        {
          isDestroyed: () => false,
          webContents: {
            send: (channel: string, payload: string) => sent.push(`${channel}:${payload}`)
          }
        }
      ]
    }
  }))

  const root = await mkdtemp(join(tmpdir(), 'pig-watch-'))
  process.env.PIG_DIR = join(root, 'data')
  const main = join(root, 'main')
  const wt = join(root, 'wt')
  try {
    await run('git', ['init', '-q', '-b', 'main', main])
    await writeFile(join(main, 'base.txt'), 'base\n')
    await git(main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A')
    await git(main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base')
    await git(main, 'worktree', 'add', '-q', '-b', 'feature', wt)
    // Staged later without another write, so nothing in the worktree moves.
    await writeFile(join(wt, 'f.txt'), 'one\n')

    const { unwatchWorktree, watchWorktree } = await import('../src/main/git/watch')
    const leaseId = await watchWorktree(wt)
    await sleep(800)
    sent.length = 0

    await git(wt, 'add', 'f.txt')
    const staged = await waitFor(() => sent.length > 0, 4000)
    assert.equal(staged, true, 'staging in a linked worktree reaches the renderer')
    assert.deepEqual([...new Set(sent)], [`diff:changed:${wt}`], 'as one notification for that worktree')

    sent.length = 0
    await git(wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'f')
    assert.equal(await waitFor(() => sent.length > 0, 4000), true, 'and so does a commit')

    unwatchWorktree(wt, leaseId)
    await sleep(400)
    sent.length = 0
    await writeFile(join(wt, 'g.txt'), 'two\n')
    await sleep(1200)
    assert.deepEqual(sent, [], 'nothing is reported once the panel lets go')

    const plain = join(root, 'plain')
    await mkdir(plain)
    await writeFile(join(plain, '.keep'), '')
    const plainLease = await watchWorktree(plain)
    assert.equal(sent.some((event) => String(event).startsWith('diff:watch-error:')), false, 'a plain directory is not a watch failure')
    unwatchWorktree(plain, plainLease)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--git-watch-fixture') {
  await runFixture()
} else {
  test('a linked worktree reports staging and commits to the renderer', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--git-watch-fixture'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const timeout = setTimeout(() => child.kill(), 12_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
      ])
      assert.equal(code, 0, stderr || stdout)
    } finally {
      clearTimeout(timeout)
      child.kill()
    }
  }, 20_000)
}
