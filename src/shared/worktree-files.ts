/**
 * URL scheme and MIME mapping for image files inside an opened worktree, shared by file tabs and
 * Markdown image previews.
 *
 * The renderer has no direct filesystem access, so image previews address worktree files through
 * `pig-file://` URLs and main serves the bytes through the same worktree path and symlink guards as
 * `files:read`.
 */
export const WORKTREE_FILE_SCHEME = 'pig-file'

export const MAX_WORKTREE_IMAGE_BYTES = 100 * 1024 * 1024

const WORKTREE_IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  apng: 'image/apng',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml'
}

export function worktreeImageMimeType(path: string): string | null {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const dot = path.lastIndexOf('.')
  if (dot <= slash + 1) return null
  return WORKTREE_IMAGE_TYPES[path.slice(dot + 1).toLowerCase()] ?? null
}

export interface WorktreeFileTarget {
  cwd: string
  /** Worktree-relative and `/`-separated, like every other path the renderer holds. */
  path: string
}

/** `pig-file://worktree/<cwd>/<path>`, each part escaped whole so neither can bleed into the other. */
export function worktreeFileUrl(cwd: string, path: string, revision?: number): string {
  const base = `${WORKTREE_FILE_SCHEME}://worktree/${encodeURIComponent(cwd)}/${encodeURIComponent(path)}`
  return revision === undefined ? base : `${base}?r=${revision}`
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
