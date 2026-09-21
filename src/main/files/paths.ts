/**
 * Path guards shared by everything that turns a renderer string into a worktree path: the changes
 * panel's untracked reads, the file tree and the file tabs.
 *
 * The string is only half of it. `worktreePath` reads it — an absolute path, a `..` segment, or a sibling
 * that merely shares the root's prefix are refused before anything is opened — but a link inside the
 * worktree can still lead out of it, and O_NOFOLLOW only holds the segment it is opened for. So the guard
 * callers use is `resolveWorktreePath`: it resolves the directories and hands back the resolved path, and
 * nothing it returns carries a link on the way out.
 */
import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface WorktreePath {
  root: string
  /** The normalized, `/`-separated spelling: what git and the renderer agree on for the same file. */
  relative: string
  absolute: string
}

/**
 * The absolute path behind a renderer-supplied worktree path, or null when the path is not inside the
 * worktree. Nothing here touches the disk: it is the string that is being judged.
 */
function worktreePath(cwd: string, path: string): WorktreePath | null {
  const root = resolve(cwd)
  const absolute = resolve(root, path)
  if (isAbsolute(path) || (absolute !== root && !absolute.startsWith(`${root}${sep}`))) return null
  return {
    root,
    relative: absolute === root ? '' : relative(root, absolute).split(sep).join('/'),
    absolute
  }
}

/**
 * The path a caller should use, with the directories it names resolved — null when the string is not
 * inside the worktree, or when a link inside it leads out of one.
 *
 * Both sides are resolved, because a worktree can be reached through a link itself (/tmp on macOS), and
 * what comes back is the resolved path rather than the one that came in: checking a path and then using
 * the unchecked one would leave a link free to move in between. A file's own segment is left alone — a
 * reader refuses a link there by name and a writer opens with O_NOFOLLOW — so what gets resolved for a
 * file is the directory that segment lives in.
 *
 * A path that is not there resolves to nothing, and that is not an escape: the original spelling goes
 * back so the caller's own call reports it missing exactly as it did before.
 */
export async function resolveWorktreePath(
  cwd: string,
  path: string,
  kind: 'file' | 'directory'
): Promise<WorktreePath | null> {
  const target = worktreePath(cwd, path)
  if (!target) return null
  const root = await realpath(target.root).catch(() => null)
  // A worktree that cannot be resolved is one that is not there: it holds nothing to hand out.
  if (!root) return null
  const isDirectory = kind === 'directory'
  const resolved = await realpath(
    isDirectory ? target.absolute : dirname(target.absolute)
  ).catch(() => null)
  if (resolved === null) return { ...target, root }
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) return null
  return {
    root,
    relative: target.relative,
    absolute: isDirectory ? resolved : join(resolved, basename(target.absolute))
  }
}
