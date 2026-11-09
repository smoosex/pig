/** Only fixed diagnostics cross the notification/log boundary; provider errors may contain secrets. */
import { t } from '../../../i18n'
import type { MemoryFailureCode } from '../../../../shared/long-term-memory'

export const REVIEW_FAILURES = {
  configuration: { stage: 'configuration', shared: true },
  model: { stage: 'model', shared: true },
  authentication: { stage: 'authentication', shared: true },
  request: { stage: 'request', shared: true },
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
  constructor(readonly code: ReviewFailureCode, message: string = t(`longTerm.reviewReasons.${code}`)) {
    super(message)
    this.name = 'MemoryReviewError'
  }
}

export function providerFailure(error: unknown): MemoryReviewError {
  const status = error && typeof error === 'object' ? (error as { status?: unknown }).status : undefined
  return new MemoryReviewError(status === 401 || status === 403 ? 'authentication' : status === 429 ? 'rateLimit' : 'request')
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
