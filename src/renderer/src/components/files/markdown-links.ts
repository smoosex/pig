/**
 * Where a link or image in a worktree markdown file points. A README is written for a repository
 * browser, so its relative paths are relative to the file itself and a leading `/` means the
 * repository root; neither means anything to the app's own URL.
 */
import { worktreeFileUrl } from '../../../../shared/worktree-files'

export type MarkdownTarget =
  | { kind: 'external' }
  | { kind: 'anchor'; slug: string }
  | { kind: 'file'; path: string; slug: string | null }
  /** A scheme the app does not hand out, a path outside the worktree, or one that does not decode. */
  | { kind: 'blocked' }

const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const EXTERNAL = new Set(['http:', 'https:', 'mailto:'])

export function markdownTarget(filePath: string, href: string): MarkdownTarget {
  if (href.startsWith('#')) return { kind: 'anchor', slug: decode(href.slice(1)) ?? '' }
  const scheme = SCHEME.exec(href)?.[0].toLowerCase()
  if (scheme) return EXTERNAL.has(scheme) ? { kind: 'external' } : { kind: 'blocked' }
  if (href.startsWith('//')) return { kind: 'blocked' }
  const hash = href.indexOf('#')
  const slug = hash < 0 ? null : (decode(href.slice(hash + 1)) ?? '')
  const location = (hash < 0 ? href : href.slice(0, hash)).split('?')[0]
  if (!location) return slug === null ? { kind: 'file', path: filePath, slug: null } : { kind: 'anchor', slug }
  const decoded = decode(location)
  if (decoded === null) return { kind: 'blocked' }
  const path = resolveWorktreePath(filePath, decoded)
  return path === null ? { kind: 'blocked' } : { kind: 'file', path, slug }
}

/** The URL an image should load from: remote and inline images as written, worktree files through main. */
export function markdownImageSrc(cwd: string, filePath: string, src: string): string | undefined {
  if (/^(https?:|data:image\/)/i.test(src)) return src
  const target = markdownTarget(filePath, src)
  return target.kind === 'file' ? worktreeFileUrl(cwd, target.path) : undefined
}

/** GitHub's heading anchors: lower case, punctuation dropped, spaces turned into hyphens. */
export function headingSlug(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-')
}

function resolveWorktreePath(filePath: string, target: string): string | null {
  const segments = target.startsWith('/') ? [] : filePath.split('/').slice(0, -1)
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (!segments.length) return null
      segments.pop()
    } else segments.push(segment)
  }
  return segments.length ? segments.join('/') : null
}

/** Markdown is untrusted text: a malformed escape names no target rather than failing the preview. */
function decode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch (error) {
    if (error instanceof URIError) return null
    throw error
  }
}
