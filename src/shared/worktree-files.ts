/**
 * URL scheme that serves local image files to the renderer (`pig-file://worktree/...` for worktree
 * files and `pig-file://local/...` for explicit local image paths in chat replies).
 *
 * The renderer has no direct filesystem access, so image paths are rewritten to `pig-file:` URLs and
 * main serves only verified regular image files without following final-segment symlinks.
 */
export const WORKTREE_FILE_SCHEME = 'pig-file'

export interface WorktreeFileTarget {
  cwd: string
  /** Worktree-relative and `/`-separated, like every other path the renderer holds. */
  path: string
}

/** `pig-file://worktree/<cwd>/<path>`, each part escaped whole so neither can bleed into the other. */
export function worktreeFileUrl(cwd: string, path: string): string {
  return `${WORKTREE_FILE_SCHEME}://worktree/${encodeURIComponent(cwd)}/${encodeURIComponent(path)}`
}

/** `pig-file://local/<path>` for an absolute or `~/` image path outside open worktrees. */
export function localImageFileUrl(path: string): string {
  return `${WORKTREE_FILE_SCHEME}://local/${encodeURIComponent(path)}`
}

export function parseWorktreeFileUrl(url: string): WorktreeFileTarget | null {
  if (!URL.canParse(url)) return null
  const parsed = new URL(url)
  if (parsed.protocol !== `${WORKTREE_FILE_SCHEME}:` || parsed.hostname !== 'worktree') return null
  const parts = parsed.pathname.split('/')
  if (parts.length !== 3 || parts[0] !== '' || !parts[1] || !parts[2]) return null
  const cwd = decodeComponent(parts[1])
  const path = decodeComponent(parts[2])
  return cwd && path ? { cwd, path } : null
}

export function parseLocalImageFileUrl(url: string): string | null {
  if (!URL.canParse(url)) return null
  const parsed = new URL(url)
  if (parsed.protocol !== `${WORKTREE_FILE_SCHEME}:` || parsed.hostname !== 'local') return null
  const parts = parsed.pathname.split('/')
  if (parts.length !== 2 || parts[0] !== '' || !parts[1]) return null
  const path = decodeComponent(parts[1])
  return path && !path.includes('\0') ? path : null
}

/** A malformed escape is a URL that addresses nothing, which the protocol answers with a 404. */
function decodeComponent(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch (error) {
    if (error instanceof URIError) return null
    throw error
  }
}
