/**
 * URL scheme that serves image files from an opened worktree, for the markdown preview of a file tab.
 *
 * A README names its images relative to itself; the renderer has no file access, so the preview turns
 * each path into one of these URLs and main reads the bytes through the same worktree guards as a file
 * tab does.
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

/** A malformed escape is a URL that addresses nothing, which the protocol answers with a 404. */
function decodeComponent(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch (error) {
    if (error instanceof URIError) return null
    throw error
  }
}
