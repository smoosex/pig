/**
 * One file for a file tab: the bytes behind it, and the one write that is allowed to replace them.
 *
 * A read is bounded and never follows a link, the same policy an untracked file gets in the changes
 * panel: a symlink inside the worktree — the last segment or a directory on the way to it — cannot become
 * a way to read, or write, something outside it. A write lands through a temporary file in the same
 * directory, so a crash mid-save leaves the old contents whole rather than a truncated file, and it only
 * replaces bytes the reader has actually seen.
 */
import { randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, open, realpath, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import type { FileMentionInfo, FileReadResult, FileStamp, FileWriteResult } from '../../shared/api'
import { MAX_WORKTREE_IMAGE_BYTES, worktreeImageMimeType } from '../../shared/worktree-files'
import { t } from '../i18n'
import { readLanes } from '../git/limit'
import { resolveWorktreePath } from './paths'
import { BINARY_PROBE_BYTES, isMissingError, readCapped, writeFailure } from './read'

/** A file a person edits by hand: past this it is data, and the tab refuses it instead of loading it. */
const MAX_EDITABLE_BYTES = 2 * 1024 * 1024

const BLOCKED_EXTERNAL_EXTENSIONS = new Set([
  '.app', '.command', '.tool', '.terminal', '.workflow', '.action', '.pkg', '.mpkg',
  '.exe', '.bat', '.cmd', '.com', '.msi', '.msp', '.scr', '.pif', '.lnk',
  '.url', '.webloc', '.inetloc', '.desktop', '.appimage'
])
const WINDOWS_SCRIPT_EXTENSIONS = new Set(['.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.ps1'])

async function readBoundedAbsoluteFile(absolute: string): Promise<FileReadResult> {
  const imageMime = worktreeImageMimeType(absolute)
  const rasterImage = imageMime !== null && imageMime !== 'image/svg+xml'
  try {
    const info = await lstat(absolute)
    if (info.isSymbolicLink()) return { kind: 'link' }
    if (!info.isFile()) return { kind: 'missing' }
    if (rasterImage || (imageMime === 'image/svg+xml' && info.size > MAX_EDITABLE_BYTES)) {
      if (info.size > MAX_WORKTREE_IMAGE_BYTES) return { kind: 'too-large', size: info.size }
      return await readLanes.run(async () => {
        const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const after = await handle.stat()
          if (!after.isFile()) return { kind: 'missing' }
          if (after.size > MAX_WORKTREE_IMAGE_BYTES) return { kind: 'too-large', size: after.size }
          return { kind: 'image', mimeType: imageMime, ...stampOf(after) }
        } finally {
          await handle.close()
        }
      })
    }
    if (info.size > MAX_EDITABLE_BYTES) return { kind: 'too-large', size: info.size }

    // O_NOFOLLOW holds the refusal at the open itself, so a link that appears between the lstat above
    // and this line is refused by the call that actually reads. Windows has no such flag; there the
    // check above stands alone, as it does for the untracked reads.
    //
    // The read goes through the same pool as an untracked file's, rather than one lane per open tab: a
    // change event re-reads every document at once, and this is the buffer — a couple of MiB each — that
    // the pool exists to bound. The allocation is inside the task so the bound covers it too.
    return await readLanes.run(async () => {
      const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        // One byte past the cap: that byte is the difference between "that was all of it" and "there was
        // more", and nothing past it is ever brought into memory.
        const buffer = Buffer.allocUnsafe(MAX_EDITABLE_BYTES + 1)
        const read = await readCapped(handle, buffer)
        const after = await handle.stat()
        if (read > MAX_EDITABLE_BYTES) {
          if (imageMime === 'image/svg+xml' && after.size <= MAX_WORKTREE_IMAGE_BYTES) {
            return { kind: 'image', mimeType: imageMime, ...stampOf(after) }
          }
          return { kind: 'too-large', size: after.size }
        }
        const bytes = buffer.subarray(0, read)
        if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return { kind: 'binary', size: after.size }
        return { kind: 'text', contents: bytes.toString('utf8'), ...stampOf(after) }
      } finally {
        await handle.close()
      }
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') return { kind: 'link' }
    if (isMissingError(error)) return { kind: 'missing' }
    throw error
  }
}

export async function readFile(cwd: string, path: string): Promise<FileReadResult> {
  const target = await resolveWorktreePath(cwd, path, 'file')
  if (!target) return { kind: 'missing' }
  return readBoundedAbsoluteFile(target.absolute)
}

/**
 * Replaces a file with the draft the reader has been editing. `expected` is the stamp that draft was
 * read at: a file that has changed on disk since — or is gone — is not overwritten, it is reported as
 * a conflict, and only a reader who has seen that answer can ask for the write anyway.
 */
export async function writeFile(
  cwd: string,
  path: string,
  contents: string,
  options: { expected?: FileStamp; overwrite?: boolean } = {}
): Promise<FileWriteResult> {
  const target = await resolveWorktreePath(cwd, path, 'file')
  if (!target || target.relative === '') throw new Error(t('error.fileOutsideWorkspace'))

  const before = await lstat(target.absolute).catch((error: unknown) => {
    if (isMissingError(error)) return null
    throw error
  })
  if (before?.isSymbolicLink()) throw new Error(t('error.symlinkWrite'))
  if (before && !before.isFile()) throw new Error(t('error.notAFile'))
  if (!options.overwrite && options.expected && !sameStamp(before && stampOf(before), options.expected)) {
    return { kind: 'conflict' }
  }

  // The temporary file is created beside the target so the rename stays within one filesystem, and it
  // carries the target's own mode: a script that was executable has to stay executable after a save.
  const temporary = join(dirname(target.absolute), `.pig-${randomUUID()}.tmp`)
  const mode = before ? before.mode & 0o777 : 0o644
  try {
    const handle = await open(temporary, 'wx', mode)
    try {
      await handle.writeFile(contents, 'utf8')
    } finally {
      await handle.close()
    }
    await rename(temporary, target.absolute)
  } catch (error) {
    await rm(temporary, { force: true })
    throw writeFailure(error)
  }
  return { kind: 'written', ...stampOf(await lstat(target.absolute)) }
}

/**
 * The absolute path to hand the desktop for its file manager to show. A link at the last segment is
 * followed by whatever looks the file up, which is what showing one amounts to — a file manager opening
 * a link is not pig reading the file behind it.
 */
export async function externalPath(cwd: string, path: string): Promise<string> {
  const target = await resolveWorktreePath(cwd, path, 'file')
  if (!target || target.relative === '') throw new Error(t('error.fileOutsideWorkspace'))
  return target.absolute
}

/**
 * The same path for the desktop to *open*, where the app that opens it would follow a link at the last
 * segment — the one way this call could put a file from outside the worktree in front of the reader, and
 * the same link a read refuses. The look and the open are two steps, so a link that appears between them
 * is the desktop's to follow; what this settles is that pig never names a target outside on purpose.
 */
export async function openablePath(cwd: string, path: string): Promise<string> {
  const absolute = await externalPath(cwd, path)
  const info = await lstat(absolute).catch((error: unknown) => {
    // Nothing there is not a link: the desktop gets the path and reports what it makes of it.
    if (isMissingError(error)) return null
    throw error
  })
  if (info?.isSymbolicLink()) throw new Error(t('error.symlinkFollow'))
  return absolute
}

/**
 * The facts a file chip's hover card shows. Lines are counted from the same bounded, link-refusing read a
 * file tab gets, so a binary or oversized file has no count rather than a costly or misleading one.
 */
export async function fileMentionInfo(cwd: string, path: string): Promise<FileMentionInfo> {
  const target = await resolveWorktreePath(cwd, path, 'file')
  if (!target || target.relative === '') return { kind: 'missing' }
  const info = await lstat(target.absolute).catch((error: unknown) => {
    if (isMissingError(error)) return null
    throw error
  })
  if (!info) return { kind: 'missing' }
  if (info.isDirectory()) return { kind: 'directory', absolutePath: target.absolute, modifiedAt: info.mtimeMs }
  const read = await readFile(cwd, path)
  if (read.kind === 'missing') return { kind: 'missing' }
  return {
    kind: 'file',
    absolutePath: target.absolute,
    modifiedAt: read.kind === 'text' || read.kind === 'image' ? read.mtimeMs : info.mtimeMs,
    lineCount: read.kind === 'text' ? lineCount(read.contents) : null
  }
}

export function expandLocalInputPath(rawPath: unknown): string | null {
  if (typeof rawPath !== 'string') return null
  const trimmed = rawPath.trim()
  if (!trimmed || trimmed.length > 4096 || trimmed.includes('\0')) return null
  const expanded = trimmed === '~'
    ? homedir()
    : trimmed.startsWith('~/') || trimmed.startsWith('~\\')
      ? join(homedir(), trimmed.slice(2))
      : trimmed
  return isAbsolute(expanded) ? resolve(expanded) : null
}

/**
 * Hover-card metadata for an absolute or `~/` filesystem reference outside open worktrees. Never
 * returns file contents, never follows a symlink at the target, and treats unreadable files as having
 * no line count rather than failing the card.
 */
export async function localFileMentionInfo(rawPath: string): Promise<FileMentionInfo> {
  const target = expandLocalInputPath(rawPath)
  if (!target) return { kind: 'missing' }
  const parent = dirname(target)
  const resolvedParent = parent === target ? target : await realpath(parent).catch(() => null)
  const absolute = parent === target
    ? target
    : resolvedParent
      ? join(resolvedParent, basename(target))
      : target
  const info = await lstat(absolute).catch((error: unknown) => {
    if (isMissingError(error)) return null
    throw error
  })
  if (!info) return { kind: 'missing' }
  if (info.isDirectory()) return { kind: 'directory', absolutePath: absolute, modifiedAt: info.mtimeMs }
  if (info.isSymbolicLink()) return { kind: 'file', absolutePath: absolute, modifiedAt: info.mtimeMs, lineCount: null }
  if (!info.isFile()) return { kind: 'missing' }
  const read = await readBoundedAbsoluteFile(absolute).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') return null
    throw error
  })
  if (read?.kind === 'missing') return { kind: 'missing' }
  return {
    kind: 'file',
    absolutePath: absolute,
    modifiedAt: read?.kind === 'text' || read?.kind === 'image' ? read.mtimeMs : info.mtimeMs,
    lineCount: read?.kind === 'text' ? lineCount(read.contents) : null
  }
}

/**
 * Resolves an explicit user-clicked local path outside open worktrees for `shell.openPath`, refusing
 * symlinks, special files, and executable/launcher bundles so a model-emitted link cannot launch code.
 */
export async function openableLocalPath(rawPath: string): Promise<string> {
  const target = expandLocalInputPath(rawPath)
  if (!target) throw new Error(t('error.fileOutsideWorkspace'))
  const parent = dirname(target)
  let absolute = target
  if (parent !== target) {
    const resolvedParent = await realpath(parent).catch((error: unknown) => {
      if (isMissingError(error)) return null
      throw error
    })
    if (!resolvedParent) throw new Error(t('error.missingEntry'))
    absolute = join(resolvedParent, basename(target))
  }
  const info = await lstat(absolute).catch((error: unknown) => {
    if (isMissingError(error)) return null
    throw error
  })
  if (!info) throw new Error(t('error.missingEntry'))
  if (info.isSymbolicLink()) throw new Error(t('error.symlinkFollow'))
  if (!info.isFile() && !info.isDirectory()) throw new Error(t('error.notAFile'))
  const ext = extname(absolute).toLowerCase()
  if (
    BLOCKED_EXTERNAL_EXTENSIONS.has(ext) ||
    (process.platform === 'win32' && WINDOWS_SCRIPT_EXTENSIONS.has(ext))
  ) {
    throw new Error(t('error.unsafeExternalOpen'))
  }
  return absolute
}

/** Counted the way an editor numbers them: a trailing newline does not open another line. */
function lineCount(contents: string): number {
  if (!contents) return 0
  return contents.split('\n').length - (contents.endsWith('\n') ? 1 : 0)
}

function stampOf(info: Stats): FileStamp {
  return { mtimeMs: info.mtimeMs, size: info.size }
}

function sameStamp(current: FileStamp | null, expected: FileStamp): boolean {
  return current !== null && current.mtimeMs === expected.mtimeMs && current.size === expected.size
}
