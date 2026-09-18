/**
 * Read-only views of a worktree for the change review panel: which files differ from HEAD, and the
 * patch behind them. Nothing here stages, writes, or commits.
 *
 * Paths stay repo-relative and spelled exactly as git reports them, because that string is what the
 * panel rows and the changes tab key on.
 */
import { constants, type Stats } from 'node:fs'
import { lstat, open, readlink, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, relative as relativeTo, resolve, sep } from 'node:path'
import type {
  DiffFileEntry,
  DiffFileStatus,
  DiffScope,
  UntrackedFileResult,
  WorktreeDiff,
  WorktreePatch
} from '../../shared/api'
import { GitExecError, isNotARepoError } from './exec'
import { runGit } from './run'
import { countLanes, readLanes } from './limit'

const MAX_PATCH_CHARS = 8 * 1024 * 1024
const MAX_UNTRACKED_BYTES = 1024 * 1024
const BINARY_PROBE_BYTES = 8000

const CONFLICTS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

export interface StatusEntry {
  path: string
  origPath?: string
  status: DiffFileStatus
  staged: boolean
}

export interface NumstatEntry {
  path: string
  origPath?: string
  /** Null for binary files: git reports `-`. */
  additions: number | null
  deletions: number | null
}

export type UntrackedFile =
  | { kind: 'text'; contents: string; lines: number }
  | { kind: 'binary' }
  | { kind: 'too-large'; bytes: number }
  /** A link stood where a regular file had just been: the read refused it, the row stays visible. */
  | { kind: 'blocked' }
  | { kind: 'missing' }

interface CountEntry {
  size: number
  mtimeMs: number
  lines: number
}

/**
 * Line counts per worktree and path for the untracked files somebody has opened. A count costs a read,
 * so it is only ever learned from the bytes a card already asked for, and the size and mtime it was read
 * at are kept with it: a refresh compares those against one lstat and drops a count whose file moved
 * rather than showing a stale number. No cache entry means no number and no work.
 */
const countCache = new Map<string, Map<string, CountEntry>>()

function statusFor(letter: string): DiffFileStatus {
  switch (letter) {
    case '?':
      return 'untracked'
    case 'A':
    case 'C':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'U':
      return 'conflicted'
    default:
      return 'modified'
  }
}

/** `git status --porcelain=v1 -z` records: `<XY> <path>\0`, then `<origPath>\0` after a rename. */
export function parseStatus(output: string): StatusEntry[] {
  const fields = output.split('\0')
  const entries: StatusEntry[] = []
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!
    if (field.length < 4) continue
    const code = field.slice(0, 2)
    const path = field.slice(3)
    const hasOrigPath = code[0] === 'R' || code[1] === 'R' || code[0] === 'C' || code[1] === 'C'
    const origPath = hasOrigPath ? fields[++index] : undefined
    if (CONFLICTS.has(code)) {
      entries.push({ path, status: 'conflicted', staged: false })
      continue
    }
    // X is the index against HEAD, Y the worktree against the index. Both sides can be dirty at
    // once, and the panel needs them apart: one entry per side, as `git status` itself implies.
    if (code[0] !== ' ' && code[0] !== '?') {
      entries.push({ path, origPath, status: statusFor(code[0]!), staged: true })
    }
    if (code[1] !== ' ') entries.push({ path, origPath, status: statusFor(code[1]!), staged: false })
  }
  return entries
}

/**
 * `git diff --numstat -z`: `<additions>\t<deletions>\t<path>\0`. A rename or copy record leaves the
 * path empty and appends the old and new path as their own NUL-terminated fields.
 */
export function parseNumstat(output: string): NumstatEntry[] {
  const fields = output.split('\0')
  const entries: NumstatEntry[] = []
  const count = (value: string | undefined) => (value === undefined || value === '-' ? null : Number(value))
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!
    if (!field) continue
    const first = field.indexOf('\t')
    if (first === -1) continue
    const second = field.indexOf('\t', first + 1)
    const additions = count(field.slice(0, first))
    const deletions = count(field.slice(first + 1, second))
    const path = field.slice(second + 1)
    if (path) {
      entries.push({ path, additions, deletions })
      continue
    }
    const origPath = fields[++index]
    const renamed = fields[++index]
    if (renamed) entries.push({ path: renamed, origPath, additions, deletions })
  }
  return entries
}

export function countLines(contents: string): number {
  if (contents === '') return 0
  let newlines = 0
  for (let index = 0; index < contents.length; index++) {
    if (contents.charCodeAt(index) === 10) newlines++
  }
  return contents.charCodeAt(contents.length - 1) === 10 ? newlines : newlines + 1
}

function byPath(entries: NumstatEntry[]): Map<string, NumstatEntry> {
  const map = new Map<string, NumstatEntry>()
  for (const entry of entries) map.set(entry.path, entry)
  return map
}

/**
 * A symlink is read as the path it holds, never followed: that is the blob git would have stored for
 * a tracked link, and it is what keeps an untracked link from pulling a file outside the worktree —
 * a private key, an env file — into the diff. Only a real file is handed over as contents.
 *
 * The read itself carries O_NOFOLLOW, so a link that appears between the two calls is refused by the
 * open that actually reads rather than followed. That window needs a concurrent writer to hit at all,
 * and closing it costs nothing. Windows does not have the flag; there the check above stands alone.
 *
 * The same window exists for the size: the lstat is a hint the file is free to break, so the cap is held
 * by the read instead — it asks for one byte past the cap and knows the difference between "that was all
 * of it" and "there was more". Nothing past that byte is ever brought into memory.
 *
 * The bytes read here are also the only place an untracked file's line count can come from, so the one
 * is recorded for the other as they pass — but only when the file's size and mtime still read the same
 * after the read as before it, so a number never outlives the bytes it was counted from.
 */
async function readUntracked(cwd: string, path: string): Promise<UntrackedFile> {
  const absolute = join(cwd, path)
  try {
    const info = await lstat(absolute)
    if (info.isSymbolicLink()) {
      const contents = await readlink(absolute)
      const lines = countLines(contents)
      rememberCount(cwd, path, info, lines)
      return { kind: 'text', contents, lines }
    }
    if (!info.isFile()) return { kind: 'missing' }
    if (info.size > MAX_UNTRACKED_BYTES) return { kind: 'too-large', bytes: info.size }

    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const buffer = Buffer.allocUnsafe(MAX_UNTRACKED_BYTES + 1)
      const read = await readCapped(handle, buffer)
      const after = await handle.stat()
      if (read > MAX_UNTRACKED_BYTES) return { kind: 'too-large', bytes: after.size }
      const bytes = buffer.subarray(0, read)
      if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return { kind: 'binary' }
      const contents = bytes.toString('utf8')
      const lines = countLines(contents)
      if (after.size === info.size && after.mtimeMs === info.mtimeMs) {
        rememberCount(cwd, path, after, lines)
      }
      return { kind: 'text', contents, lines }
    } finally {
      await handle.close()
    }
  } catch (error) {
    return untrackedReadFailure(error)
  }
}

/** Fills the buffer from the start of an open file, stopping at its end or when the buffer is full. */
async function readCapped(handle: FileHandle, buffer: Buffer): Promise<number> {
  let offset = 0
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  return offset
}

function rememberCount(cwd: string, path: string, info: Stats, lines: number): void {
  const cache = countCache.get(cwd) ?? new Map<string, CountEntry>()
  countCache.set(cwd, cache)
  cache.set(path, { size: info.size, mtimeMs: info.mtimeMs, lines })
}

/**
 * The two codes that mean "that path is not there". Shared by the read and by the count validation, so
 * one errno list describes what a missing file is everywhere.
 */
export function isMissingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * What a refused read means. A file that is gone reads as `missing`, a link that `O_NOFOLLOW` declined as
 * `blocked`, and anything else — a permission, a descriptor table that ran out — is thrown so the card can
 * say what happened instead of reporting a file that is not there.
 */
export function untrackedReadFailure(error: unknown): UntrackedFile {
  if ((error as NodeJS.ErrnoException).code === 'ELOOP') return { kind: 'blocked' }
  if (isMissingError(error)) return { kind: 'missing' }
  throw error
}

/**
 * One untracked file for the changes tab's card, read when that card is opened. The path arrives from
 * the renderer, so it is held inside the worktree first; everything else is `readUntracked`'s policy —
 * a link is its target path, a real file is contents up to the cap.
 */
export async function readUntrackedFile(cwd: string, path: string): Promise<UntrackedFileResult> {
  const root = resolve(cwd)
  const absolute = resolve(root, path)
  if (isAbsolute(path) || (absolute !== root && !absolute.startsWith(`${root}${sep}`))) {
    return { kind: 'missing' }
  }
  // Back to the spelling git uses for the same file, which is what the count cache is keyed by.
  const relative = absolute === root ? '' : relativeTo(root, absolute).split(sep).join('/')
  // The validation pool stats paths; this one holds a buffer and reads bytes. Separate lanes, so a
  // refresh's queue of stats can never stand in front of a card's read.
  return readLanes.run(() => readUntracked(root, relative))
}

/**
 * The line counts already known for the untracked rows of a refresh. Each count was learned from the bytes
 * of a card that got opened, so a refresh validates what it has with one lstat per counted file and does
 * nothing at all for the rest — a worktree with nothing opened in it pays nothing, however many untracked
 * files it holds. A count whose file changed size or mtime is dropped: no number beats a wrong one.
 */
async function untrackedCounts(cwd: string, paths: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  const cache = countCache.get(cwd)
  if (!cache) return counts
  if (!paths.length) {
    countCache.delete(cwd)
    return counts
  }

  const present = new Set(paths)
  for (const path of cache.keys()) if (!present.has(path)) cache.delete(path)

  await Promise.all(
    [...cache.keys()].map((path) =>
      countLanes.run(async () => {
        // A queued task runs long after the snapshot above: another refresh, or a card's own read, may have
        // dropped or replaced this entry by then. So the entry is looked up here rather than captured in the
        // closure, and it is re-checked after the stat: only a task that still holds it may write or delete.
        const cached = cache.get(path)
        if (!cached) return

        const info = await lstat(join(cwd, path)).catch((error) => {
          // A path that is gone just stops being counted. A permission or an I/O error is not something to
          // hide behind a missing number: it goes up, and the refresh reports what is wrong with the tree.
          if (isMissingError(error)) return null
          throw error
        })
        if (cache.get(path) !== cached) return

        if (!info || info.size !== cached.size || info.mtimeMs !== cached.mtimeMs) {
          cache.delete(path)
          return
        }
        counts.set(path, cached.lines)
      })
    )
  )
  return counts
}

async function isWorktree(cwd: string): Promise<boolean> {
  try {
    return (await runGit(cwd, ['rev-parse', '--is-inside-work-tree'], { locale: 'C' })).trim() === 'true'
  } catch (error) {
    if (isNotARepoError(error)) return false
    throw error
  }
}

/** The empty tree: what a repository with no first commit yet is compared against. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/**
 * What the worktree is diffed against. A repository whose first commit has not been made — a fresh
 * `git init`, a worktree added with `--orphan` — has an unborn HEAD, and `git diff HEAD` refuses to
 * guess what that means rather than diffing against nothing. The empty tree is the revision git does
 * accept there, and it says the same thing: everything in the index and the worktree is new.
 */
async function baseRevision(cwd: string): Promise<string> {
  try {
    await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    return 'HEAD'
  } catch {
    return EMPTY_TREE
  }
}

/**
 * Adds and deletions are per scope and are not additive across staged and worktree changes, so the
 * per-side lists read `--cached` / the worktree while the path-wide `all` list reads the base revision.
 */
export async function readWorktreeDiff(cwd: string): Promise<WorktreeDiff> {
  if (!(await isWorktree(cwd))) return { git: false, staged: [], unstaged: [], all: [] }

  // The base revision is asked for alongside the rest, and the diff that needs it waits for the answer:
  // what a repository without a HEAD is compared to is not something this call can assume.
  const [base, statusOutput, stagedOutput, worktreeOutput] = await Promise.all([
    baseRevision(cwd),
    runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=no']),
    runGit(cwd, ['diff', '--cached', '--numstat', '-z', '-M']),
    runGit(cwd, ['diff', '--numstat', '-z', '-M'])
  ])
  const baseOutput = await runGit(cwd, ['diff', base, '--numstat', '-z', '-M'])

  const status = parseStatus(statusOutput)
  const stagedCounts = byPath(parseNumstat(stagedOutput))
  const worktreeCounts = byPath(parseNumstat(worktreeOutput))
  const baseCounts = byPath(parseNumstat(baseOutput))

  const untrackedPaths = [...new Set(status.filter((entry) => entry.status === 'untracked').map((entry) => entry.path))]
  const untrackedLines = await untrackedCounts(cwd, untrackedPaths)

  const staged: DiffFileEntry[] = []
  const unstaged: DiffFileEntry[] = []
  for (const entry of status) {
    const untracked = entry.status === 'untracked'
    const counts = untracked ? undefined : (entry.staged ? stagedCounts : worktreeCounts).get(entry.path)
    const lines = untracked ? untrackedLines.get(entry.path) ?? null : null
    const file: DiffFileEntry = {
      path: entry.path,
      origPath: entry.origPath,
      status: entry.status,
      additions: untracked ? lines : counts?.additions ?? null,
      deletions: untracked ? (lines === null ? null : 0) : counts?.deletions ?? null
    }
    ;(entry.staged ? staged : unstaged).push(file)
  }

  // One row per path: the flat list is where staged and worktree edits of the same file meet, and
  // its status follows the newer side so a half-staged file does not read as `R` or `D`.
  const all = new Map<string, DiffFileEntry>()
  for (const file of [...staged, ...unstaged]) {
    const counts = baseCounts.get(file.path)
    const merged: DiffFileEntry = {
      path: file.path,
      origPath: file.origPath,
      status: file.status,
      additions: file.status === 'untracked' ? file.additions : counts?.additions ?? file.additions,
      deletions: file.status === 'untracked' ? file.deletions : counts?.deletions ?? file.deletions
    }
    const existing = all.get(file.path)
    all.set(file.path, existing ? { ...merged, origPath: existing.origPath ?? merged.origPath } : merged)
  }

  return {
    git: true,
    staged,
    unstaged,
    all: [...all.values()].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  }
}

/**
 * One scope of the worktree in a single patch. Tracked files come from one `git diff` — the base
 * revision for `all`, the index for `staged`, the index against the worktree for `unstaged` — and
 * untracked files, which no diff command prints, are read one at a time as the changes tab opens their
 * cards. Over the cap the patch stops at a file boundary, so no hunk is ever half applied and the tab
 * can say which files it left out.
 */
export async function readWorktreePatch(cwd: string, scope: DiffScope): Promise<WorktreePatch> {
  if (!(await isWorktree(cwd))) {
    return { git: false, patch: '', truncated: false }
  }

  // `git diff` takes the index as its right side for `staged` and its left side for `unstaged`: the
  // two halves of the same file are different diffs, which is why the scope reaches git at all.
  const args =
    scope === 'staged'
      ? ['diff', '--cached', '-M', '--no-color', '--no-ext-diff', '--unified=3']
      : scope === 'unstaged'
        ? ['diff', '-M', '--no-color', '--no-ext-diff', '--unified=3']
        : ['diff', await baseRevision(cwd), '-M', '--no-color', '--no-ext-diff', '--unified=3']

  let rawPatch: string
  let overflow = false
  try {
    rawPatch = await runGit(cwd, args)
  } catch (error) {
    if (!(error instanceof GitExecError)
      || error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
      || error.stdout === undefined) throw error
    rawPatch = error.stdout
    overflow = true
  }
  const truncated = overflow || rawPatch.length > MAX_PATCH_CHARS
  const patch = truncated ? rawPatch.slice(0, fileBoundary(rawPatch)) : rawPatch
  return { git: true, patch, truncated }
}

/** Where the cap lands between files: the next `diff --git` line starts the file that had to go. */
function fileBoundary(patch: string): number {
  const boundary = patch.lastIndexOf('\ndiff --git ', MAX_PATCH_CHARS)
  return boundary === -1 ? 0 : boundary + 1
}
