/**
 * The cwd a renderer sends is the one thing the guards inside a worktree cannot judge: a root the renderer
 * names is a root, so every path check passes for `/etc` just as well as for the project the user opened.
 * This fixture drives the real IPC handlers against a real temp project and a real linked worktree, with
 * the opened-projects file under a PIG_DIR of its own and electron stubbed, so the refusal is the thing
 * being tested rather than the wiring around it.
 *
 * Each case runs in its own process, like the other fixtures: the opened-projects file is read through an
 * environment variable and electron is replaced in the module registry, and neither belongs to the tests
 * that share this process otherwise.
 */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGit } from '../src/main/git/run'

async function runFixture(): Promise<void> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'pig-access-')))
  const pigDir = join(base, 'pig')
  await mkdir(pigDir, { recursive: true })

  const project = join(base, 'project')
  await mkdir(project)
  await runGit(project, ['init', '-b', 'main'])
  await writeFile(join(project, 'readme.md'), '# hi\n')
  await writeFile(join(project, 'src.ts'), 'export const value = 1\n')
  await runGit(project, ['add', '-A'])
  await runGit(project, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base'])
  const linked = join(base, 'linked')
  await runGit(project, ['worktree', 'add', '-q', '-b', 'feature', linked])

  const plain = join(base, 'plain')
  await mkdir(plain)

  // A project is routinely reached through a link: the guard has to recognise the worktree behind the
  // spelling it was handed, not only the one it stored.
  const alias = join(base, 'alias')
  await symlink(project, alias)

  await writeFile(
    join(pigDir, 'opened-projects.json'),
    JSON.stringify({
      version: 1,
      projects: [
        { cwd: project, openedAt: new Date().toISOString() },
        { cwd: plain, openedAt: new Date().toISOString() }
      ]
    })
  )
  process.env.PIG_DIR = pigDir

  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const { expect, mock } = await import('bun:test')
  mock.module('electron', () => ({
    app: { isPackaged: false },
    ipcMain: {
      handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
        handlers.set(channel, listener)
      }
    },
    shell: { openPath: async () => '', showItemInFolder: () => {} },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    BrowserWindow: { getAllWindows: () => [] }
  }))

  const { applyLocaleSetting } = await import('../src/main/i18n')
  // Pig's own errors come from the dictionary: pin the wording these tests spell out.
  applyLocaleSetting('zh-CN')
  const { openedWorktree, requireWorktree } = await import('../src/main/worktree-access')
  const { registerFilesIpc } = await import('../src/main/ipc/files')
  const { registerDiffIpc } = await import('../src/main/ipc/diff')
  registerFilesIpc()
  registerDiffIpc()

  const ask = (channel: string, ...args: unknown[]): Promise<unknown> => {
    const listener = handlers.get(channel)
    assert.ok(listener, `expected ${channel} to be registered`)
    return Promise.resolve(listener!(null, ...args))
  }

  assert.equal(await openedWorktree(project), project, 'the project is its own worktree')
  // A worktree is answered in the spelling that was asked with, because that string goes back out in the
  // change events the window matches against its own key: an alias that was accepted has to be echoed.
  assert.equal(await openedWorktree(alias), alias, 'the same worktree behind an alias, spelled as asked')
  assert.equal(await requireWorktree(alias), alias, 'and the guard that the callers use echoes it too')
  assert.equal(await openedWorktree(linked), linked, 'a linked worktree counts')
  assert.equal(await openedWorktree(plain), plain, 'a project that is not a repository still counts')
  assert.equal(await openedWorktree('/etc'), null)
  assert.equal(await openedWorktree(join(base, 'elsewhere')), null)
  assert.equal(await openedWorktree(''), null)
  assert.equal(await openedWorktree(undefined), null)
  await assert.rejects(() => requireWorktree('/etc'), /不是已打开的工作区/)

  // A file below a worktree's own root is not a worktree itself, however much it looks like a path.
  assert.equal(await openedWorktree(join(project, 'src')), join(project, 'src') === project ? project : null)

  expect(await ask('files:read', project, 'src.ts')).toEqual({
    kind: 'text',
    contents: 'export const value = 1\n',
    mtimeMs: expect.any(Number),
    size: 23
  })
  const diff = (await ask('diff:read-worktree', project)) as { git: boolean }
  expect(diff.git).toBe(true)

  // What the guard is for: the same calls used to read, list, write and watch whatever root a renderer
  // named — `/etc` included — because every check inside a worktree agrees with any root it is given.
  await assert.rejects(() => ask('files:read', '/etc', 'hosts'), /不是已打开的工作区/)
  await assert.rejects(() => ask('files:read-directory', '/etc', ''), /不是已打开的工作区/)
  await assert.rejects(() => ask('files:write', '/etc', 'hosts', 'nope', {}), /不是已打开的工作区/)
  await assert.rejects(() => ask('files:open-externally', base, 'readme.md'), /不是已打开的工作区/)
  await assert.rejects(() => ask('files:reveal-externally', base, 'readme.md'), /不是已打开的工作区/)
  await assert.rejects(() => ask('diff:read-worktree', base), /不是已打开的工作区/)
  await assert.rejects(() => ask('diff:read-untracked', base, 'readme.md'), /不是已打开的工作区/)
  await assert.rejects(() => ask('diff:read-patch', base, 'all'), /不是已打开的工作区/)
  await assert.rejects(() => ask('diff:watch', base), /不是已打开的工作区/)

  await rm(base, { recursive: true, force: true })
}

if (process.argv[2] === '--worktree-access-fixture') {
  await runFixture()
} else {
  test('worktree access: only the opened projects and their worktrees are readable', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--worktree-access-fixture'], {
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text()
    ])
    assert.equal(code, 0, stdout + stderr)
  })
}
