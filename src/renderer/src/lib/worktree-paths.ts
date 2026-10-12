/**
 * How a worktree path reads, shared by the file store and the session store.
 *
 * Paths are worktree-relative and `/`-separated — the spelling the tree, the file tabs and git all agree
 * on — and the two questions asked about them here are the ones a row moving raises: what a path becomes
 * when the row above it is renamed, and whether a path is the row itself or something inside it.
 *
 * They live in their own module rather than in either store because both need them and neither may import
 * the other: the file store is where a document's path prefix matters, the session store is where a tab's
 * does, and the two are updated together by the code that renames a row.
 */

/** Whether a path is the directory itself or something under it. */
export function isUnder(path: string, directory: string): boolean {
  return path.startsWith(`${directory}/`)
}

/**
 * Where a path ends up when `from` is renamed to `to` — null when the rename does not touch it.
 *
 * A row is moved by its own name, and everything under a folder is moved with it: renaming `src` renames
 * `src/main.ts` to `source/main.ts` without anyone naming that row, so the whole subtree has to be
 * re-keyed rather than just the one path the reader was looking at.
 */
export function renamedPath(path: string, from: string, to: string): string | null {
  if (path === from) return to
  return isUnder(path, from) ? `${to}${path.slice(from.length)}` : null
}
