/** Only fixed diagnostics cross the notification/log boundary; provider errors may contain secrets. */
import { t } from '../../../i18n'
import type { MemoryFailureCode } from '../../../../shared/long-term-memory'

export const REVIEW_FAILURES = {
  configuration: { stage: 'configuration', shared: true },
  model: { stage: 'model', shared: true },
  authentication: { stage: 'authentication', shared: true },
  request: { stage: 'request', shared: true },
  connection: { stage: 'request', shared: true },
  connectionReset: { stage: 'request', shared: true },
  dns: { stage: 'request', shared: true },
  tls: { stage: 'request', shared: true },
  providerTimeout: { stage: 'request', shared: true },
  httpClient: { stage: 'request', shared: true },
  httpServer: { stage: 'request', shared: true },
  rateLimit: { stage: 'request', shared: true },
  timeout: { stage: 'request', shared: false },
  truncated: { stage: 'output', shared: false },
  json: { stage: 'validation', shared: false },
  schema: { stage: 'validation', shared: false },
  evidence: { stage: 'validation', shared: false },
  budget: { stage: 'preparation', shared: false },
  conflict: { stage: 'commit', shared: false },
  storage: { stage: 'storage', shared: true },
} as const satisfies Record<MemoryFailureCode, { stage: string; shared: boolean }>

export type ReviewFailureCode = MemoryFailureCode
export class MemoryReviewError extends Error {
  constructor(readonly code: ReviewFailureCode, message: string = t(`longTerm.reviewReasons.${code}`), readonly httpStatus?: number) {
    super(message)
    this.name = 'MemoryReviewError'
  }
}

function transportFailure(code: string, name?: unknown): ReviewFailureCode | undefined {
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns'
  if (/^(?:ERR_TLS_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|UNABLE_TO_VERIFY_LEAF_SIGNATURE$|ERR_SSL_)/.test(code)) return 'tls'
  if (['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(code)) return 'connectionReset'
  if (code === 'ETIMEDOUT' || /^UND_ERR_.*TIMEOUT$/.test(code)
    || name === 'APIConnectionTimeoutError' || name === 'TimeoutError') return 'providerTimeout'
  if (['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code)) return 'connection'
  return undefined
}

/** SDK streams flatten errors to strings. Recognize only known prefixes; never forward their text. */
export function providerFailure(error: unknown): MemoryReviewError {
  const pending: unknown[] = [error]
  const seen = new Set<unknown>()
  const messages: string[] = []
  const transport: ReviewFailureCode[] = []
  let status: number | undefined
  for (let count = 0; pending.length && count < 8; count++) {
    const item = pending.shift()
    if (seen.has(item)) continue
    seen.add(item)
    if (typeof item === 'string') { messages.push(item.slice(0, 512)); continue }
    if (!item || typeof item !== 'object') continue
    const value = item as { status?: unknown; statusCode?: unknown; response?: { status?: unknown };
      $metadata?: { httpStatusCode?: unknown }; $response?: { statusCode?: unknown };
      code?: unknown; name?: unknown; message?: unknown; cause?: unknown; errors?: unknown[] }
    const rawStatus = [value.statusCode, value.status, value.response?.status,
      value.$metadata?.httpStatusCode, value.$response?.statusCode]
      .find(candidate => typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 400 && candidate <= 599)
    if (status === undefined && typeof rawStatus === 'number') status = rawStatus
    if (typeof value.message === 'string') messages.push(value.message.slice(0, 512))
    const code = typeof value.code === 'string' ? value.code : ''
    const failure = transportFailure(code, value.name)
    if (failure) transport.push(failure)
    if (value.cause !== undefined) pending.push(value.cause)
    if (Array.isArray(value.errors)) pending.push(...value.errors.slice(0, 4))
  }
  if (status === undefined) {
    for (const message of messages) {
      const match = /^(?:Error:\s*)?(?:(?:HTTP(?:\s+error)?|status\s+code)\s*:?\s*([45]\d{2})\b|([45]\d{2})(?=[:\s]|$)|[\w .-]{1,80} API error \(([45]\d{2})\):)/i.exec(message.trim())
      if (match) { status = Number(match[1] ?? match[2] ?? match[3]); break }
    }
  }
  let code: ReviewFailureCode = 'request'
  if (status !== undefined) {
    code = status === 401 || status === 403 ? 'authentication' : status === 429 ? 'rateLimit'
      : status === 408 || status === 504 ? 'providerTimeout' : status >= 500 ? 'httpServer' : 'httpClient'
  } else if (transport.length) code = transport.find(value => value !== 'connection') ?? transport[0]!
  else {
    for (const message of messages) {
      const token = /^(?:Error:\s*)?(?:(?:getaddrinfo|connect|read|write)\s+)?([A-Z][A-Z0-9_]+)\b/.exec(message.trim())?.[1]
      const failure = token ? transportFailure(token) : undefined
      if (failure) { code = failure; break }
      if (/^(?:(?:APIConnectionTimeoutError|TimeoutError):\s*)?(?:request |connection )?timed out\b/i.test(message.trim())) { code = 'providerTimeout'; break }
      if (/^(?:(?:TypeError|APIConnectionError):\s*)?(?:fetch failed|connection error|connection refused)\b/i.test(message.trim())) code = 'connection'
      if (/^Provider finish_reason: network_error$/.test(message.trim())) code = 'connectionReset'
    }
  }
  return new MemoryReviewError(code, undefined, status)
}

export async function reviewPhase<T>(code: ReviewFailureCode, action: () => T | Promise<T>): Promise<T> {
  try { return await action() }
  catch (error) {
    if (error instanceof MemoryReviewError) throw error
    throw code === 'request' ? providerFailure(error) : new MemoryReviewError(code)
  }
}

/** In-memory cooldowns survive task/branch changes, but not a settings-triggered resource reload. */
export class ReviewBackoff {
  private failures = new Map<string, { attempts: number; until: number }>()

  fail(key: string, now = Date.now()): number {
    const attempts = (this.failures.get(key)?.attempts ?? 0) + 1
    const delay = Math.min(30 * 60_000, 60_000 * 2 ** Math.min(attempts - 1, 5))
    this.failures.set(key, { attempts, until: now + delay })
    return delay
  }

  remaining(key: string, now = Date.now()): number {
    return Math.max(0, (this.failures.get(key)?.until ?? 0) - now)
  }

  clear(key: string): void { this.failures.delete(key) }
}

export const REVIEW_TIMEOUT_MS = 60_000
