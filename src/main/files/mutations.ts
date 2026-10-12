/**
 * The writes a reader asks of the file tree from its context menu: a new file or folder, a rename, a
 * move to the trash, and the absolute path behind a row for the clipboard.
 *
 * Every one of them goes through the same path guard the reads use, and for the same reason: the string
 * is only half of the answer, and a link inside the worktree can still lead out of it. A rename is the
 * one that needs the most care — it takes a name rather than a path, so it cannot be pointed anywhere
 * outside the row's own directory, but the row it names may itself be a link, and moving one is how a
 * link leaves the worktree without ever being followed.
 *
 * A name is judged before anything touches the disk. A path separator in a name would silently create a
 * directory, and `.` and `..` are the two names that are not names at all, so both are refused here
 * rather than by whatever the filesystem makes of them.
 *
 * A name that is already taken is refused by the call that would take it, never by a check made before
 * it: a check and the call it guards are two steps, and the name can be taken in between. `open` with
 * `wx` is what promises a new file did not replace one, and a folder gets the same promise by making its
 * parents recursively and then its own last segment on its own — a recursive `mkdir` is happy to walk
 * into a directory that is already there, while a single-segment one refuses it.
 *
 * A folder's parents are made one segment at a time rather than in one recursive call. `resolveWorktreePath`
 * answers a path that is not there by handing back the unresolved spelling — safe for a read, whose own
 * call then reports it missing, but not for a write that would *make* the missing chain: a recursive
 * `mkdir` walks straight through a link on the way and lands outside the worktree. Walking the segments
 * is not a precaution added on top; it is the thing that makes the guard hold for a create at all.
 */
import { lstat, mkdir, open, rename } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { FileRenameResult } from '../../shared/api'
import { t } from '../i18n'
import { isMissingError, writeFailure } from './read'
import { worktreeRelative, resolveWorktreePath } from './paths'

/** The one thing a name may not contain, and the two that are not names at all. */
const SEPARATORS = /[/\\]/
const RESERVED = new Set(['.', '..'])

export interface NewEntry {
  /** Worktree-relative path of the file or folder that was created. */
  path: string
}

/**
 * Creates an empty file, or a folder and the ones it needs on the way to it.
 *
 * A file is created with `wx`, so an existing one is reported as taken rather than emptied — the reader
 * asked for a new file, and overwriting one by accident is not what that means. A folder gets the same
 * promise by making its own last segment on its own, which is the step a recursive `mkdir` would skip.
 */
export async function createEntry(
  cwd: string,
  path: string,
  kind: 'file' | 'directory'
): Promise<NewEntry> {
  const parent = await resolveWorktreePath(cwd, dirname(path), 'directory')
  if (!parent) throw new Error(t('error.fileOutsideWorkspace'))
  const name = basename(path)
  if (!name || SEPARATORS.test(name) || RESERVED.has(name)) throw new Error(t('error.invalidName'))
  if (kind === 'directory') await makeDirectories(cwd, parent.relative)
  const target = join(parent.absolute, name)
  // Each kind is refused by the call that would take the name, and neither asks whether it is free first:
  // `open` with `wx` refuses an existing file outright, and `mkdir` on a lone segment refuses a directory.
  try {
    if (kind === 'file') {
      const handle = await open(target, 'wx')
      await handle.close()
    } else {
      await mkdir(target)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(t('error.nameTaken'))
    throw writeFailure(error)
  }
  return { path: worktreeRelative(parent.relative, name) }
}

/**
 * Makes every level of a worktree-relative directory, one segment at a time.
 *
 * Each segment is resolved as it is reached, and the resolved spelling is what the next one is joined
 * onto, so a level that turns out to be a link somewhere is caught by the resolution rather than walked
 * through. A `mkdir` that loses a race for a level another writer just made is the one failure treated as
 * success, and it is re-checked rather than assumed: what matters is not who made the level, but that it
 * is a directory inside the worktree.
 */
async function makeDirectories(cwd: string, path: string): Promise<void> {
  if (!path) return
  const segments = path.split('/')
  let walked = ''
  for (const segment of segments) {
    if (!segment || RESERVED.has(segment)) throw new Error(t('error.invalidName'))
    walked = walked ? `${walked}/${segment}` : segment
    // Resolving rather than joining is the whole guard: a level that is a link out of the worktree is
    // refused here, and one that cannot be resolved yet is the level this is about to make.
    const resolved = await resolveWorktreePath(cwd, walked, 'directory')
    if (!resolved) throw new Error(t('error.fileOutsideWorkspace'))
    const created = await mkdir(resolved.absolute).then(
      () => true,
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw writeFailure(error)
      }
    )
    if (created) continue
    // Something is already there: it has to be a directory, and it has to still resolve inside.
    const info = await lstat(resolved.absolute).catch((error: unknown) => {
      if (isMissingError(error)) return null
      throw error
    })
    if (!info?.isDirectory()) throw new Error(t('error.nameTaken'))
    if (info.isSymbolicLink()) throw new Error(t('error.symlinkFollow'))
    const after = await resolveWorktreePath(cwd, walked, 'directory')
    if (!after) throw new Error(t('error.fileOutsideWorkspace'))
  }
}

/**
 * Moves a row to a new name in its own directory.
 *
 * The new name is judged the same way a new file's is, and the row it renames is refused when it is a
 * link: `lstat` is what sees the link itself, and renaming one is how it would leave the worktree
 * without pig ever reading through it.
 *
 * A name that is already there is refused rather than replaced. POSIX `rename` overwrites whatever stands
 * at the destination, and that is a file's uncommitted work — the tree is where a reader looks at files
 * they have not committed yet, so the one operation here that could destroy some is the one that does not
 * get to. The check is made just before the call, which is a race like any other: losing it means the
 * filesystem replaces the destination, exactly as it would have without the check, and never means
 * anything left the worktree.
 */
export async function renameEntry(
  cwd: string,
  path: string,
  name: string
): Promise<FileRenameResult> {
  const parent = await resolveWorktreePath(cwd, dirname(path), 'directory')
  if (!parent) throw new Error(t('error.fileOutsideWorkspace'))
  if (!name || SEPARATORS.test(name) || RESERVED.has(name)) throw new Error(t('error.invalidName'))
  const source = await resolveWorktreePath(cwd, path, 'file')
  if (!source) throw new Error(t('error.fileOutsideWorkspace'))
  const info = await lstat(source.absolute).catch((error: unknown) => {
    if (isMissingError(error)) return null
    throw error
  })
  if (!info) throw new Error(t('error.missingEntry'))
  if (info.isSymbolicLink()) throw new Error(t('error.symlinkFollow'))
  const target = join(parent.absolute, name)
  // Renaming a row to the name it already answers to is nothing to do, and there is nothing at the
  // destination to refuse in that case.
  if (target !== source.absolute && (await stands(target))) throw new Error(t('error.nameTaken'))
  await rename(source.absolute, target).catch((error: unknown) => {
    throw writeFailure(error)
  })
  return { path: worktreeRelative(parent.relative, name) }
}

/** The absolute path of a row, for the clipboard and for the desktop's trash to take. */
export async function absolutePath(cwd: string, path: string): Promise<string> {
  const target = await resolveWorktreePath(cwd, path, 'file')
  if (!target) throw new Error(t('error.fileOutsideWorkspace'))
  return target.absolute
}

/** Whether anything at all stands at this path, a link included. */
async function stands(path: string): Promise<boolean> {
  const info = await lstat(path).catch((error: unknown) => {
    if (isMissingError(error)) return null
    throw error
  })
  return info !== null
}
