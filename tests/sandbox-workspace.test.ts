import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { sessionWorkspace } from '../src/main/sandbox/workspace'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pig-workspace-')))
  roots.push(root)
  return root
}
function repo(root: string) {
  const git = join(root, '.git')
  mkdirSync(join(git, 'objects'), { recursive: true })
  mkdirSync(join(git, 'refs'))
  writeFileSync(join(git, 'HEAD'), 'ref: refs/heads/main\n')
  return git
}
function linked(root: string, common: string) {
  const cwd = join(root, 'linked')
  mkdirSync(cwd)
  const gitdir = join(common, 'worktrees', 'linked')
  mkdirSync(gitdir, { recursive: true })
  writeFileSync(join(cwd, '.git'), `gitdir: ${relative(cwd, gitdir)}\n`)
  writeFileSync(join(gitdir, 'commondir'), '../..\n')
  writeFileSync(join(gitdir, 'gitdir'), `${join(cwd, '.git')}\n`)
  writeFileSync(join(gitdir, 'HEAD'), 'ref: refs/heads/linked\n')
  return { cwd, gitdir }
}

test('discovers repositories, linked worktrees and subdirectories without running PATH git', async () => {
  const root = fixture()
  const common = repo(join(root, 'main'))
  const { cwd } = linked(root, common)
  const sub = join(cwd, 'src', 'nested')
  mkdirSync(sub, { recursive: true })
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const sentinel = join(root, 'git-ran')
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf escaped > '${sentinel}'\nexit 1\n`)
  chmodSync(join(bin, 'git'), 0o755)
  const old = process.env.PATH
  process.env.PATH = bin
  try {
    expect(await sessionWorkspace(dirname(common))).toEqual({ cwd: dirname(common), gitCommonDir: common })
    expect(await sessionWorkspace(sub)).toEqual({ cwd: sub, gitCommonDir: common, gitDir: join(common, 'worktrees', 'linked') })
    expect(await sessionWorkspace(bin)).toEqual({ cwd: bin, gitCommonDir: null })
    expect(existsSync(sentinel)).toBe(false)
  } finally { process.env.PATH = old }
})

// Unsupported layouts keep the session usable: no Git write grant, and the .git entry stays read-only.
const degraded = (cwd: string, gitMetadata: string, gitDir?: string) => ({ cwd, gitCommonDir: null, gitMetadata, ...(gitDir ? { gitDir } : {}) })

test('commondir expansion, broken pointers and non-reciprocal worktrees get no Git grant', async () => {
  const root = fixture()
  const common = repo(join(root, 'main'))
  const { cwd, gitdir } = linked(root, common)
  const pointer = join(cwd, '.git')
  expect(await sessionWorkspace(cwd)).toEqual({ cwd, gitCommonDir: common, gitDir: gitdir })
  writeFileSync(join(gitdir, 'commondir'), root)
  expect(await sessionWorkspace(cwd)).toEqual(degraded(cwd, pointer, gitdir))
  writeFileSync(join(gitdir, 'commondir'), '../..\n')
  writeFileSync(join(gitdir, 'gitdir'), join(root, 'other', '.git'))
  expect(await sessionWorkspace(cwd)).toEqual(degraded(cwd, pointer, gitdir))
  writeFileSync(join(cwd, '.git'), 'gitdir: missing\n')
  expect(await sessionWorkspace(cwd)).toEqual(degraded(cwd, pointer, join(cwd, 'missing')))
  writeFileSync(join(cwd, '.git'), 'gitdir: a\ngitdir: b\n')
  expect(await sessionWorkspace(cwd)).toEqual(degraded(cwd, pointer))
})

test('symlink and separate-git-dir layouts are never granted', async () => {
  const root = fixture()
  const common = repo(join(root, 'main'))
  const cwd = join(root, 'other')
  mkdirSync(cwd)
  symlinkSync(common, join(cwd, '.git'))
  expect(await sessionWorkspace(cwd)).toEqual(degraded(cwd, join(cwd, '.git')))
  rmSync(join(cwd, '.git'))
  writeFileSync(join(cwd, '.git'), `gitdir: ${common}\n`)
  expect(await sessionWorkspace(cwd)).toEqual(degraded(cwd, join(cwd, '.git'), common))
  writeFileSync(join(common, 'commondir'), root)
  expect(await sessionWorkspace(dirname(common))).toEqual(degraded(dirname(common), common))
})

test('submodules and worktrees reached through a symlinked path keep the session usable', async () => {
  const root = fixture()
  const parent = repo(join(root, 'parent'))
  const modules = join(parent, 'modules', 'lib')
  mkdirSync(join(modules, 'objects'), { recursive: true })
  mkdirSync(join(modules, 'refs'))
  writeFileSync(join(modules, 'HEAD'), 'ref: refs/heads/main\n')
  const submodule = join(root, 'parent', 'lib')
  mkdirSync(submodule)
  writeFileSync(join(submodule, '.git'), 'gitdir: ../.git/modules/lib\n')
  expect(await sessionWorkspace(submodule)).toEqual(degraded(submodule, join(submodule, '.git'), modules))

  // Git wrote the worktree pointer through a symlinked directory, so the recorded path is not canonical.
  const alias = join(root, 'alias')
  symlinkSync(join(root, 'real'), alias)
  const common = repo(join(root, 'real', 'main'))
  const cwd = join(root, 'real', 'linked')
  mkdirSync(cwd)
  const gitdir = join(alias, 'main', '.git', 'worktrees', 'linked')
  mkdirSync(join(common, 'worktrees', 'linked'), { recursive: true })
  writeFileSync(join(cwd, '.git'), `gitdir: ${gitdir}\n`)
  writeFileSync(join(gitdir, 'commondir'), '../..\n')
  writeFileSync(join(gitdir, 'gitdir'), `${join(alias, 'linked', '.git')}\n`)
  writeFileSync(join(gitdir, 'HEAD'), 'ref: refs/heads/linked\n')
  expect(await sessionWorkspace(cwd)).toEqual(degraded(cwd, join(cwd, '.git'), gitdir))
})

test('a non-layout IO failure still fails loudly', async () => {
  const root = fixture()
  await expect(sessionWorkspace(join(root, 'missing'))).rejects.toThrow()
})
