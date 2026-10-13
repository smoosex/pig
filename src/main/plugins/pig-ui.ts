import type { ReviewOption, ReviewStep, SystemUIEvent } from '../../shared/api'

type SessionIdentity = { sessionManager: { getSessionId(): string } }
export interface SystemNotifier {
  notify(message: string, level?: 'info' | 'warning' | 'error'): void
}
export interface ReviewUI extends SystemNotifier {
  readonly available: boolean
  readonly returning: boolean
  choose(step: ReviewStep, options: ReviewOption[]): Promise<string | undefined>
  edit(step: ReviewStep, prefill?: string): Promise<string | undefined>
  setActive(active: boolean): void
  setReturning(returning: boolean): void
}
export interface SystemUIHost {
  review: ReviewUI
  memory: SystemNotifier
  send(event: SystemUIEvent): void
}

// The SDK loads extensions through jiti; the host and extension must share the same session registry.
const key = Symbol.for('pig:system-plugin-ui')
const hosts = (globalThis as Record<symbol, Map<string, SystemUIHost> | undefined>)[key]
  ?? ((globalThis as Record<symbol, Map<string, SystemUIHost>>)[key] = new Map())

export function registerSystemUI(sessionId: string, host?: SystemUIHost): void {
  if (host) hosts.set(sessionId, host)
  else hosts.delete(sessionId)
}

export function isReviewReturning(sessionId: string): boolean {
  return hosts.get(sessionId)?.review.returning ?? false
}

export function reviewUI(ctx: SessionIdentity): ReviewUI {
  const sessionId = ctx.sessionManager.getSessionId()
  return {
    get available() { return hosts.has(sessionId) },
    get returning() { return isReviewReturning(sessionId) },
    choose: (step, options) => hosts.get(sessionId)?.review.choose(step, options) ?? Promise.resolve(undefined),
    edit: (step, prefill) => hosts.get(sessionId)?.review.edit(step, prefill) ?? Promise.resolve(undefined),
    notify: (message, level) => hosts.get(sessionId)?.review.notify(message, level),
    setActive: (active) => hosts.get(sessionId)?.review.setActive(active),
    setReturning: (returning) => hosts.get(sessionId)?.review.setReturning(returning)
  }
}

export function memoryUI(ctx: SessionIdentity): SystemNotifier {
  const sessionId = ctx.sessionManager.getSessionId()
  return { notify: (message, level) => hosts.get(sessionId)?.memory.notify(message, level) }
}
