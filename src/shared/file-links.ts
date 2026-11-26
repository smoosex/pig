/**
 * Parses Markdown link destinations in chat and Bot replies so local filesystem references
 * (`正文/002.md`, `/Users/.../a.ts#L12`, `file:///...`, `~/...`, `src/a.ts:42`) can show file hover
 * cards and open in a workspace file tab (or via the OS default app when outside open workspaces),
 * while external URLs stay external and unsafe schemes stay inert.
 */

export type ParsedFileTarget = {
  /** Normalized `/`-separated path: worktree-relative when `relativeToCwd` is true, else absolute or `~/...`. */
  path: string
  relativeToCwd: boolean
  /** 1-based line number extracted from `#L12`, `#L12-L20`, `#L12C5`, `#12`, or trailing `:12` / `:12:5`. */
  line: number | null
}

export type ParsedMarkdownLink =
  | { kind: 'external'; href: string }
  | { kind: 'anchor'; href: string }
  | ({ kind: 'file' } & ParsedFileTarget)
  | { kind: 'blocked' }

export interface WorkspaceCandidate {
  cwd: string
  worktrees?: readonly { cwd: string; missing: boolean }[]
}

const EXTERNAL_SCHEME = /^(https?:|mailto:)/i
const FILE_SCHEME = /^file:/i
const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/
const SCHEME_PREFIX = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/
const FILE_EXT_BEFORE_COLON = /\.[a-zA-Z0-9]+$/
const LINE_COLON_REST = /^\d+(?:[:-]\d+)?(?:[?#].*)?$/

const INLINE_CODE_FORBIDDEN_CHARS = /[\0\r\n\t<>|;&$*`"'(){}[\]=!?]/
const EXPLICIT_POSIX_ROOT =
  /^\/(?:Users|home|tmp|private|var|opt|etc|Volumes|Applications|System|Library|mnt|root|usr|nix)\//
const API_ROUTE_PREFIX = /^\/(?:api|v\d+|oauth|auth|graphql|ws|webhooks?|healthz?|readyz?|metrics)(?:\/|$)/i

const KNOWN_FILE_EXTENSIONS = new Set([
  'md', 'markdown', 'mdx', 'txt', 'rst', 'adoc', 'org', 'tex', 'bib', 'rtf', 'pdf', 'epub',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'tsv',
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs',
  'json', 'jsonc', 'json5', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties',
  'xml', 'plist', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'svg',
  'vue', 'svelte', 'astro', 'mdx', 'graphql', 'gql', 'prisma', 'proto', 'sql',
  'py', 'pyi', 'ipynb', 'rs', 'go', 'mod', 'sum', 'java', 'kt', 'kts', 'scala', 'groovy', 'gradle',
  'swift', 'mm', 'cpp', 'hpp', 'cc', 'cxx', 'hxx', 'cs', 'fs', 'vb', 'rb', 'erb', 'php', 'lua', 'zig', 'nim', 'ex', 'exs', 'erl', 'clj', 'dart',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'lock', 'patch', 'diff', 'log', 'wasm',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'tiff',
  'mp3', 'wav', 'ogg', 'flac', 'm4a', 'mp4', 'webm', 'mov', 'mkv',
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar'
])
const PATH_ONLY_SINGLE_CHAR_EXTENSIONS = new Set(['c', 'h', 'm', 'r', 's'])
const EXACT_FILENAMES = new Set([
  'Dockerfile', 'Makefile', 'GNUmakefile', 'CMakeLists.txt', 'Containerfile',
  'Procfile', 'Gemfile', 'Rakefile', 'Justfile', 'Vagrantfile', 'Brewfile',
  'LICENSE', 'LICENCE', 'COPYING', 'README', 'CHANGELOG', 'AUTHORS', 'OWNERS', 'CODEOWNERS',
  '.gitignore', '.gitattributes', '.gitmodules', '.editorconfig', '.npmrc', '.nvmrc', '.node-version',
  '.python-version', '.prettierrc', '.prettierignore', '.eslintrc', '.eslintignore', '.dockerignore', '.env'
])
const BARE_FRAMEWORK_JS =
  /^(?:node|next|nuxt|vue|react|angular|solid|svelte|ember|backbone|three|chart|d3|day|moment|highlight|prism|mermaid|katex|electron|nw|bun|deno|express|nest|koa|hapi|fastify|vite|rollup|webpack|gulp|grunt|jest|mocha|ava|sinon|cypress|playwright|alpine|htmx|pixi|babylon|p5|paper|fabric|tone|howler|video|pdf|fuse|zone|core)\.js$/i

/**
 * True for `<a href>` destinations that `react-markdown`'s `defaultUrlTransform` would strip as
 * unknown protocols (`file://...`, `C:/...`, or bare `file.ext:line`), while keeping `javascript:`,
 * `data:`, and every non-anchor attribute sanitized by `defaultUrlTransform`.
 */
export function isChatPassthroughHref(url: string): boolean {
  const trimmed = url.trim()
  if (FILE_SCHEME.test(trimmed) || WINDOWS_DRIVE.test(trimmed)) return true
  const match = SCHEME_PREFIX.exec(trimmed)
  if (!match) return false
  return FILE_EXT_BEFORE_COLON.test(match[1]) && LINE_COLON_REST.test(match[2])
}

export function parseMarkdownFileLink(
  href: string | undefined,
  cwd?: string | null,
  options?: { literalText?: boolean }
): ParsedMarkdownLink {
  const raw = href?.trim() ?? ''
  if (!raw) return { kind: 'blocked' }
  if (raw.startsWith('#') || raw.startsWith('?')) return { kind: 'anchor', href: raw }
  if (raw.startsWith('//')) return { kind: 'blocked' }
  if (EXTERNAL_SCHEME.test(raw)) return { kind: 'external', href: raw }
  if (FILE_SCHEME.test(raw)) return parseFileSchemeUrl(raw)

  if (!WINDOWS_DRIVE.test(raw)) {
    const scheme = SCHEME_PREFIX.exec(raw)
    if (scheme && !(FILE_EXT_BEFORE_COLON.test(scheme[1]) && LINE_COLON_REST.test(scheme[2]))) {
      return { kind: 'blocked' }
    }
  }

  const { location, hash } = splitHrefLocation(raw, options?.literalText)
  if (!location) return hash === null ? { kind: 'blocked' } : { kind: 'anchor', href: raw }
  const decoded = options?.literalText ? location : decodePercent(location)
  if (!decoded || decoded.includes('\0')) return { kind: 'blocked' }

  const hashLine = parseLineAnchor(hash)
  const extracted = hashLine === null ? extractTrailingLine(decoded) : { path: decoded, line: hashLine }
  const target = extracted.path
  const line = extracted.line
  if (!target) return { kind: 'blocked' }

  if (target === '~' || target.startsWith('~/') || target.startsWith('~\\')) {
    const home = normalizeHomePath(target)
    return home ? { kind: 'file', path: home, relativeToCwd: false, line } : { kind: 'blocked' }
  }

  if (target.startsWith('/') || WINDOWS_DRIVE.test(target)) {
    const absolute = normalizeAbsolutePath(target)
    return absolute ? { kind: 'file', path: absolute, relativeToCwd: false, line } : { kind: 'blocked' }
  }

  if (!cwd) return { kind: 'blocked' }
  const relative = normalizeRelativeSegments(target)
  if (relative !== null) {
    if (relative === '') {
      const root = normalizeAbsolutePath(cwd)
      return root ? { kind: 'file', path: root, relativeToCwd: false, line } : { kind: 'blocked' }
    }
    return { kind: 'file', path: relative, relativeToCwd: true, line }
  }

  const resolved = resolveAgainstBase(cwd, target)
  return resolved ? { kind: 'file', path: resolved, relativeToCwd: false, line } : { kind: 'blocked' }
}

/**
 * Classifies an inline backtick `<code>` span when models emit paths like
 * `` `/Users/.../红线啦啦啦.md` ``, `` `正文/002.md` ``, or `` `src/main/window.ts:67` `` instead of
 * Markdown links, while rejecting commands, API routes (`/models`), scoped packages, and JS expressions.
 */
export function parseInlineCodeFileLink(
  rawText: string,
  cwd?: string | null,
  projects: readonly WorkspaceCandidate[] = []
): ParsedFileTarget | null {
  if (!rawText || rawText.length > 512 || rawText !== rawText.trim()) return null
  if (INLINE_CODE_FORBIDDEN_CHARS.test(rawText) || /^[-@#?]/.test(rawText)) return null
  if (/\s+-/.test(rawText)) return null

  const startsWithWorkspaceRoot = isWithinCandidateRoots(rawText, cwd, projects)
  const hasExplicitPrefix =
    /^file:\/\/(?:localhost)?\//i.test(rawText) ||
    rawText.startsWith('~/') ||
    rawText.startsWith('~\\') ||
    /^\.\.?[\\/]/.test(rawText) ||
    WINDOWS_DRIVE.test(rawText) ||
    EXPLICIT_POSIX_ROOT.test(rawText) ||
    startsWithWorkspaceRoot

  if (!hasExplicitPrefix && /\s/.test(rawText)) return null

  if (rawText.startsWith('/') && !hasExplicitPrefix) {
    if (API_ROUTE_PREFIX.test(rawText)) return null
    const withoutAnchor = stripInlineAnchorAndLine(rawText)
    const segments = withoutAnchor.split('/').filter(Boolean)
    if (segments.length < 2 || !hasRecognizedFileName(withoutAnchor)) return null
  } else if (!hasExplicitPrefix) {
    if (!cwd) return null
    const withoutAnchor = stripInlineAnchorAndLine(rawText)
    if (!hasRecognizedFileName(withoutAnchor)) return null
  }

  const parsed = parseMarkdownFileLink(rawText, cwd, { literalText: true })
  return parsed.kind === 'file' ? { path: parsed.path, relativeToCwd: parsed.relativeToCwd, line: parsed.line } : null
}

function isWithinCandidateRoots(
  rawText: string,
  cwd: string | null | undefined,
  projects: readonly WorkspaceCandidate[]
): boolean {
  const normalized = rawText.replace(/\\/g, '/')
  const matches = (root: string | null | undefined): boolean => {
    if (!root) return false
    const clean = root.replace(/[\\/]+$/, '').replace(/\\/g, '/')
    return Boolean(clean) && normalized.startsWith(`${clean}/`) && normalized.length > clean.length + 1
  }
  if (matches(cwd)) return true
  for (const proj of projects) {
    if (matches(proj.cwd)) return true
    for (const wt of proj.worktrees ?? []) {
      if (!wt.missing && matches(wt.cwd)) return true
    }
  }
  return false
}

function stripInlineAnchorAndLine(rawText: string): string {
  const hash = rawText.indexOf('#')
  const beforeHash = hash < 0 ? rawText : rawText.slice(0, hash)
  return extractTrailingLine(beforeHash).path.replace(/[\\/]+$/, '')
}

function hasRecognizedFileName(cleanPath: string): boolean {
  if (!cleanPath || /^v?\d+(?:\.\d+)+$/i.test(cleanPath)) return false
  if (/^(?:window\.)?console\.log$/i.test(cleanPath)) return false
  const normalized = cleanPath.replace(/\\/g, '/')
  const hasSlash = normalized.includes('/')
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  if (!base) return false
  if (EXACT_FILENAMES.has(base) || base.startsWith('.env.')) return true
  if (!hasSlash && BARE_FRAMEWORK_JS.test(base)) return false
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return false
  const ext = base.slice(dot + 1).toLowerCase()
  if (PATH_ONLY_SINGLE_CHAR_EXTENSIONS.has(ext)) return hasSlash
  return KNOWN_FILE_EXTENSIONS.has(ext)
}

/**
 * Maps an absolute path to the most specific opened workspace (`cwd` or project/worktree),
 * returning null when the path lies outside every candidate root.
 */
export function matchOpenedWorkspaceFile(
  filePath: string,
  preferredCwds: readonly (string | null | undefined)[],
  projects: readonly WorkspaceCandidate[]
): { cwd: string; relativePath: string } | null {
  const candidates: string[] = []
  const seen = new Set<string>()
  const push = (cwd: string | null | undefined) => {
    if (!cwd) return
    const trimmed = cwd.replace(/[\\/]+$/, '')
    if (!trimmed || seen.has(trimmed)) return
    seen.add(trimmed)
    candidates.push(trimmed)
  }

  for (const cwd of preferredCwds) push(cwd)
  for (const proj of projects) {
    push(proj.cwd)
    for (const wt of proj.worktrees ?? []) {
      if (!wt.missing) push(wt.cwd)
    }
  }

  const normalizedFile = filePath.replace(/\\/g, '/')
  let best: { cwd: string; relativePath: string; rootLen: number } | null = null
  for (const cwd of candidates) {
    const normalizedRoot = cwd.replace(/\\/g, '/')
    const prefix = normalizedRoot === '' ? '/' : `${normalizedRoot}/`
    if (normalizedFile.startsWith(prefix) && normalizedFile.length > prefix.length) {
      if (!best || normalizedRoot.length > best.rootLen) {
        best = {
          cwd,
          relativePath: normalizedFile.slice(prefix.length),
          rootLen: normalizedRoot.length
        }
      }
    }
  }
  return best ? { cwd: best.cwd, relativePath: best.relativePath } : null
}

function parseFileSchemeUrl(raw: string): ParsedMarkdownLink {
  const { location, hash } = splitHrefLocation(raw)
  const rest = location.slice('file:'.length)
  let rawPath: string
  if (rest.startsWith('//')) {
    const afterSlashes = rest.slice(2)
    const slash = afterSlashes.indexOf('/')
    if (slash < 0) return { kind: 'blocked' }
    const host = afterSlashes.slice(0, slash).toLowerCase()
    if (host !== '' && host !== 'localhost') return { kind: 'blocked' }
    rawPath = afterSlashes.slice(slash)
  } else if (rest.startsWith('/')) {
    rawPath = rest
  } else {
    return { kind: 'blocked' }
  }

  const decoded = decodePercent(rawPath)
  if (!decoded || decoded.includes('\0')) return { kind: 'blocked' }
  const normalizedDrive = /^\/[a-zA-Z]:[\\/]/.test(decoded) ? decoded.slice(1) : decoded
  const hashLine = parseLineAnchor(hash)
  const extracted = hashLine === null ? extractTrailingLine(normalizedDrive) : { path: normalizedDrive, line: hashLine }
  const absolute = normalizeAbsolutePath(extracted.path)
  return absolute ? { kind: 'file', path: absolute, relativeToCwd: false, line: extracted.line } : { kind: 'blocked' }
}

function splitHrefLocation(href: string, literalText = false): { location: string; hash: string | null } {
  const hashIndex = href.indexOf('#')
  const hash = hashIndex < 0 ? null : href.slice(hashIndex + 1)
  const beforeHash = hashIndex < 0 ? href : href.slice(0, hashIndex)
  if (literalText) return { location: beforeHash, hash }
  const queryIndex = beforeHash.indexOf('?')
  const location = queryIndex < 0 ? beforeHash : beforeHash.slice(0, queryIndex)
  return { location, hash }
}

function parseLineAnchor(hash: string | null): number | null {
  if (!hash) return null
  const decoded = decodePercent(hash) ?? hash
  const match = /^L?(\d+)(?:C\d+)?(?:[-:]L?\d+(?:C\d+)?)?$/i.exec(decoded.trim())
  if (!match) return null
  const line = Number.parseInt(match[1], 10)
  return Number.isSafeInteger(line) && line >= 1 ? line : null
}

function extractTrailingLine(path: string): { path: string; line: number | null } {
  const match = /^(.*?):(\d+)(?:[:-]\d+)?$/.exec(path)
  if (!match) return { path, line: null }
  const base = match[1]
  // Never mistake a bare Windows drive (`C:`) for a filename before `:line`.
  if (!base || /^[a-zA-Z]$/.test(base)) return { path, line: null }
  const line = Number.parseInt(match[2], 10)
  if (!Number.isSafeInteger(line) || line < 1) return { path, line: null }
  return { path: base, line }
}

function normalizeHomePath(input: string): string | null {
  if (input === '~') return '~'
  const rest = input.slice(2).replace(/\\/g, '/')
  const segments: string[] = []
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (!segments.length) return null
      segments.pop()
    } else {
      segments.push(segment)
    }
  }
  return segments.length ? `~/${segments.join('/')}` : '~'
}

function normalizeAbsolutePath(input: string): string | null {
  const slashes = input.replace(/\\/g, '/')
  let prefix = ''
  let rest = slashes
  if (WINDOWS_DRIVE.test(slashes)) {
    prefix = `${slashes.slice(0, 2)}/`
    rest = slashes.slice(3)
  } else if (slashes.startsWith('/')) {
    prefix = '/'
    rest = slashes.slice(1)
  } else {
    return null
  }
  const segments: string[] = []
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      segments.pop()
    } else {
      segments.push(segment)
    }
  }
  return segments.length ? `${prefix}${segments.join('/')}` : prefix
}

/** Returns normalized `/`-separated path when it stays within the base directory, or null if `..` escapes. */
function normalizeRelativeSegments(input: string): string | null {
  const segments: string[] = []
  for (const segment of input.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (!segments.length) return null
      segments.pop()
    } else {
      segments.push(segment)
    }
  }
  return segments.join('/')
}

function resolveAgainstBase(base: string, relative: string): string | null {
  const normalizedBase = normalizeAbsolutePath(base)
  if (!normalizedBase) return null
  const combined = normalizedBase.endsWith('/') ? `${normalizedBase}${relative}` : `${normalizedBase}/${relative}`
  return normalizeAbsolutePath(combined)
}

/** Decodes valid `%XX` escapes while preserving literal `%` characters in unencoded filenames (e.g. `50%完成.md`). */
function decodePercent(value: string): string | null {
  try {
    return decodeURIComponent(value.replace(/%(?![0-9a-fA-F]{2})/g, '%25'))
  } catch (error) {
    if (error instanceof URIError) return null
    throw error
  }
}
