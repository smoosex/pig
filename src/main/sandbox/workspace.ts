/**
 * Discovers conventional Git repositories without executing PATH programs or trusting arbitrary write
 * roots. Other layouts (submodules, separate-git-dir, symlinked paths) keep the workspace usable but
 * get no Git write grant and their `.git` entry stays read-only.
 */
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { Workspace } from './policy'
import { realTarget } from './path'

class UnsupportedGit extends Error {}

function invalid(): never {
  throw new UnsupportedGit('Unsafe or unsupported Git metadata; refusing to grant a Git write directory')
}

/** Only a layout this module does not recognise degrades; permission and other IO errors still fail. */
function unsupported(error: unknown): boolean {
  return error instanceof UnsupportedGit || ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
}

async function directory(path: string): Promise<void> {
  const stat = await lstat(path)
  if (!stat.isDirectory() || await realpath(path) !== path) invalid()
}

async function metadata(path: string): Promise<string> {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.size > 4096) invalid()
  const value = (await readFile(path, 'utf8')).replace(/\r?\n$/, '')
  if (!value || /[\x00-\x1f\x7f]/.test(value) || value !== value.trim()) invalid()
  return value
}

async function commonDirectory(path: string): Promise<void> {
  // Shape alone cannot establish ownership of an arbitrary target (e.g. $HOME). Restrict grants
  // to canonical .git directories; separate-git-dir and symlink layouts intentionally fail closed.
  if (basename(path) !== '.git') invalid()
  await directory(path)
  await directory(join(path, 'objects'))
  await directory(join(path, 'refs'))
  const head = await metadata(join(path, 'HEAD'))
  if (!/^ref: refs\/\S+$/.test(head) && !/^[a-fA-F0-9]{40}(?:[a-fA-F0-9]{24})?$/.test(head)) invalid()
}

export async function sessionWorkspace(cwd: string): Promise<Workspace> {
  const real = realTarget(cwd)
  const stat = await lstat(real)
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${real}`)
  for (let root = real; ; root = dirname(root)) {
    const dotGit = join(root, '.git')
    let entry
    try { entry = await lstat(dotGit) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (dirname(root) === root) return { cwd: real, gitCommonDir: null }
      continue
    }
    try {
      return { cwd: real, ...await repository(root, dotGit, entry.isDirectory(), entry.isFile()) }
    } catch (error) {
      if (!unsupported(error)) throw error
      const gitDir = entry.isFile() ? await pointerTarget(root, dotGit) : undefined
      return { cwd: real, gitCommonDir: null, gitMetadata: dotGit, ...(gitDir ? { gitDir } : {}) }
    }
  }
}

async function repository(root: string, dotGit: string, isDirectory: boolean, isFile: boolean): Promise<Omit<Workspace, 'cwd'>> {
  if (isDirectory) {
    await commonDirectory(dotGit)
    // commondir in a primary .git is not the conventional linked-worktree layout.
    try { await lstat(join(dotGit, 'commondir')); invalid() } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return { gitCommonDir: dotGit }
  }
  if (!isFile) invalid()
  const gitdir = await pointerTarget(root, dotGit)
  if (!gitdir) invalid()
  await directory(gitdir)
  const common = resolve(gitdir, await metadata(join(gitdir, 'commondir')))
  // Validate both directions and the exact Git worktrees/<id> placement, not just a plausible HEAD.
  if (dirname(gitdir) !== join(common, 'worktrees') || basename(gitdir).startsWith('.')) invalid()
  await commonDirectory(common)
  if (resolve(gitdir, await metadata(join(gitdir, 'gitdir'))) !== dotGit) invalid()
  await metadata(join(gitdir, 'HEAD'))
  return { gitCommonDir: common, gitDir: gitdir }
}

/** Where a `.git` file points, so its hooks and config can be denied even without a grant. */
async function pointerTarget(root: string, dotGit: string): Promise<string | undefined> {
  let pointer
  try { pointer = await metadata(dotGit) } catch (error) {
    if (unsupported(error)) return undefined
    throw error
  }
  return pointer.startsWith('gitdir: ') && pointer.length > 8 ? resolve(root, pointer.slice(8)) : undefined
}
