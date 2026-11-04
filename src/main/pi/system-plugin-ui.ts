import { randomUUID } from 'node:crypto'
import type { BrowserWindow, WebContents } from 'electron'
import type { ReviewOption, ReviewStep, SystemUIEvent } from '../../shared/api'
import { registerSystemUI, reviewUI, type SystemNotifier } from '../plugins/pig-ui'

interface ReviewWaiter {
  sessionId: string
  sender: WebContents
  finish(value: string | null): void
}
const waiters = new Map<string, ReviewWaiter>()
const resetters = new Map<string, () => void>()

/** Pi emits command and hook errors through the host; keep Review failures out of global toasts. */
export function reportReviewError(sessionId: string, extensionPath: string, message: string, reviewPath?: string): boolean {
  if (extensionPath !== 'command:review' && extensionPath !== 'command:end-review' && extensionPath !== reviewPath) return false
  reviewUI({ sessionManager: { getSessionId: () => sessionId } }).setFeedback({ level: 'error', message })
  return true
}

export function replyReviewUI(sender: WebContents, id: string, value: string | null): void {
  const waiter = waiters.get(id)
  if (waiter?.sender === sender) waiter.finish(value)
}

export function cancelSystemPrompts(sessionId: string): void {
  for (const waiter of waiters.values()) {
    if (waiter.sessionId === sessionId) waiter.finish(null)
  }
}

export function attachSystemUI(sessionId: string, win: BrowserWindow): SystemNotifier {
  let hasState = false
  let returning = false
  const send = (event: SystemUIEvent): void => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    if (event.kind !== 'dismiss' && event.kind !== 'reset') hasState = true
    win.webContents.send('system-plugins:ui', event)
  }
  resetters.set(sessionId, () => {
    returning = false
    if (hasState) send({ kind: 'reset', sessionId })
    hasState = false
  })
  const notifier = (plugin: 'memory' | 'host'): SystemNotifier => ({
    notify: (message, level = 'info') => send({ kind: 'notify', sessionId, plugin, message, level })
  })
  const prompt = (step: ReviewStep, options?: ReviewOption[], prefill?: string, error?: string): Promise<string | undefined> => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return Promise.resolve(undefined)
    const id = randomUUID()
    return new Promise((resolve) => {
      const finish = (value: string | null) => {
        if (!waiters.delete(id)) return
        send({ kind: 'dismiss', id, sessionId })
        resolve(value !== null && (!options || options.some((option) => option.value === value)) ? value : undefined)
      }
      waiters.set(id, { sessionId, sender: win.webContents, finish })
      send({ kind: 'review-prompt', id, sessionId, method: options ? 'choose' : 'edit', step, options, prefill, error })
    })
  }
  registerSystemUI(sessionId, {
    send,
    memory: notifier('memory'),
    review: {
      available: true,
      get returning() { return returning },
      choose: (step, options) => prompt(step, options),
      edit: (step, prefill, error) => prompt(step, undefined, prefill, error),
      setFeedback: (feedback) => send({ kind: 'review-feedback', sessionId, feedback }),
      setActive: (active) => send({ kind: 'review-state', sessionId, active }),
      setReturning: (value, phase) => {
        returning = value
        send({ kind: 'review-returning', sessionId, returning, ...(returning && phase ? { phase } : {}) })
      }
    }
  })
  return notifier('host')
}

export function resetSystemUI(sessionId: string): void {
  cancelSystemPrompts(sessionId)
  resetters.get(sessionId)?.()
}

export function detachSystemUI(sessionId: string): void {
  resetSystemUI(sessionId)
  registerSystemUI(sessionId)
  resetters.delete(sessionId)
}
