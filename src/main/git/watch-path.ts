import { isAbsolute, relative, resolve } from 'node:path'

/**
 * Whether a worktree event says nothing about the working tree.
 *
 * Two kinds of write are noise: Pig's own data directory (in development it lives at `<repo>/.pig`,
 * so reviewing the repository Pig is built from would refresh on every preference write) and git
 * lock files, which other git processes take and release in a loop — reacting to those turns one
 * poller into an endless refresh cycle.
 */
export function isIgnoredWatchPath(cwd: string, filename: string, dataDir: string): boolean {
  if (isInside(dataDir, resolve(cwd, filename))) return true
  return /(^|[/\\])\.git[/\\].*\.lock$/.test(filename)
}

/** A watch target for the paths git writes outside the worktree, which the recursive tree watch misses. */
export interface GitWatchTarget {
  path: string
  /** Directory watches report lock traffic by name; the index is watched as a file and reports its own. */
  filterLocks: boolean
}

/**
 * The git paths a linked worktree keeps outside itself.
 *
 * A linked worktree's `.git` is a pointer file: its index, HEAD and reflogs live in the main
 * repository's `.git/worktrees/<name>` and its branch refs in the main repository's `.git/refs`, so a
 * recursive watch of the worktree sees neither `git add` nor `git commit`. A normal repository keeps
 * all of them inside the worktree, and the tree watch already covers those, so nothing is added here.
 */
export function gitWatchTargets(
  cwd: string,
  paths: { gitDir: string; index: string; refsDir: string }
): GitWatchTarget[] {
  const candidates: GitWatchTarget[] = [
    // macOS reports the rename that lands the index only to a watch on the file itself.
    { path: paths.index, filterLocks: false },
    { path: paths.gitDir, filterLocks: true },
    { path: paths.refsDir, filterLocks: true }
  ]
  const seen = new Set<string>()
  const targets: GitWatchTarget[] = []
  for (const candidate of candidates) {
    const path = resolve(cwd, candidate.path)
    if (isInside(cwd, path) || seen.has(path)) continue
    seen.add(path)
    targets.push({ path, filterLocks: candidate.filterLocks })
  }
  return targets
}

/** Whether a name from a git directory watch is lock traffic, which says nothing on its own. */
export function isGitLockEvent(filename: string): boolean {
  return /(^|[/\\])[^/\\]*\.lock$/.test(filename)
}

function isInside(parent: string, target: string): boolean {
  const path = relative(parent, target)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}
