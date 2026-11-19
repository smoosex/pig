/** Conservative normalization and redaction for telemetry fields. Never returns raw errors or placeholder tokens. */
export const MAX_TELEMETRY_QUERY_BYTES = 120

const CONTROL_CHARS = /[\x00-\x1f\x7f]/
const PRIVATE_KEY_RE = /-----BEGIN [^-]*PRIVATE KEY-----/i
const SECRET_PREFIX_RE = /\b(?:sk-|rk-|pk-|github_pat_|gh[pousr]_|xox[baprs]-|AIza[0-9A-Za-z_-]{20,}|AKIA[A-Z0-9]{16})\S*/
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/
const AUTH_SCHEME_RE = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}=*/i
const KEY_ASSIGN_RE = /\b(?:password|passwd|pwd|api[_-]?key|secret|token|auth[_-]?token|credential|private[_-]?key)\s*[:=]/i
const URL_CREDS_RE = /[a-z][a-z0-9+.-]*:\/\/[^/\s]*:[^/\s]*@/i
const URL_SECRET_QUERY_RE = /[?&](?:token|key|api[_-]?key|secret|password|auth|sig|signature|access_token)=/i
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/
const LONG_DIGITS_RE = /\d{7,}/
const PHONE_RE = /(?:\+?\d{1,3}[-.\s])?(?:\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4})\b/
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/
const ABS_PATH_RE = /(?:^|\s)(?:\/(?:Users|home|var|tmp|etc|opt|private|Volumes)\/|[A-Za-z]:\\|~\/)/
const HEX_TOKEN_RE = /\b[a-f0-9]{32,}\b/i
const BASE64_PAD_RE = /[A-Za-z0-9+/]{20,}={1,2}(?:\s|$)/

function looksSensitive(text: string): boolean {
  if (PRIVATE_KEY_RE.test(text) || SECRET_PREFIX_RE.test(text) || JWT_RE.test(text)) return true
  if (AUTH_SCHEME_RE.test(text) || KEY_ASSIGN_RE.test(text) || URL_CREDS_RE.test(text) || URL_SECRET_QUERY_RE.test(text)) return true
  if (EMAIL_RE.test(text) || LONG_DIGITS_RE.test(text) || PHONE_RE.test(text) || IPV4_RE.test(text)) return true
  if (ABS_PATH_RE.test(text) || HEX_TOKEN_RE.test(text) || BASE64_PAD_RE.test(text)) return true
  for (const token of text.split(/\s+/)) {
    if (token.length >= 24 && /[0-9]/.test(token) && /[A-Za-z]/.test(token) && /^[A-Za-z0-9_./+-]+$/.test(token)) {
      return true
    }
  }
  return false
}

/** Keep only short, normalized, low-risk search queries; omit rather than replacing with placeholders. */
export function sanitizeTelemetryQuery(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  if (CONTROL_CHARS.test(raw)) return undefined
  const normalized = raw.trim().replace(/\s+/g, ' ')
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > MAX_TELEMETRY_QUERY_BYTES) return undefined
  if (!/^[\p{L}\p{M}\p{N} _.-]+$/u.test(normalized) || looksSensitive(normalized)) return undefined
  return normalized
}

/** Validate a scope-relative Markdown path before copying it into telemetry logs. */
export function sanitizeTelemetryPath(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw || raw.length > 500 || CONTROL_CHARS.test(raw)) return undefined
  if (raw.startsWith('/') || /[\\:<>|?*%']/.test(raw) || !raw.endsWith('.md')) return undefined
  const parts = raw.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) return undefined
  if (looksSensitive(raw)) return undefined
  return raw
}

const ERRNO_CODES = new Set([
  'ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'EISDIR', 'ENOTDIR', 'EBUSY',
  'EMFILE', 'ENFILE', 'ENOSPC', 'EROFS', 'EIO', 'ENAMETOOLONG'
])

const MEMORY_CODES = new Set([
  'MEMORY_DISABLED', 'MEMORY_ALREADY_EXISTS', 'MEMORY_REVISION_CONFLICT',
  'MEMORY_LINK_OUTSIDE_SCOPE', 'MEMORY_DEPTH_LIMIT', 'MEMORY_FILE_LIMIT',
  'MEMORY_SCAN_LIMIT', 'MEMORY_CLEANUP_FAILED', 'READ_ONLY', 'NO_PROJECT_SCOPE',
  'CREDENTIAL_REJECTED', 'WRITER_BUSY', 'INVALID_FILE', 'CONTENT_LIMIT', 'INVALID_ARGS'
])

/** Map errors to bounded fixed codes without leaking messages or disk paths. */
export function telemetryErrorCode(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted) return 'ABORTED'
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && (MEMORY_CODES.has(code) || ERRNO_CODES.has(code))) return code
    if (error instanceof Error && error.name === 'AbortError') return 'ABORTED'
  }
  return 'UNKNOWN_ERROR'
}
