/** Shared request lifetime only; callers retain ownership and reply validation. */
import { randomUUID } from 'node:crypto'

export interface PendingReply<T> {
  settle(value: T): void
  fail(error: unknown): void
}

export function requestReply<T, Owner>(
  pending: Map<string, Owner & PendingReply<T>>,
  owner: Owner,
  send: (requestId: string) => void,
  options: { signal?: AbortSignal; timeoutMs: number; timeoutMessage: string; cancelError?: Error }
): Promise<T> {
  const { signal, timeoutMs, timeoutMessage, cancelError } = options
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const requestId = randomUUID()
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (settle: () => void) => {
      if (!pending.delete(requestId)) return
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      settle()
    }
    const reply: PendingReply<T> = {
      settle: value => finish(() => resolve(value)),
      fail: error => finish(() => reject(error))
    }
    const abort = () => reply.fail(cancelError ?? signal!.reason)
    pending.set(requestId, { ...owner, ...reply })
    timer = setTimeout(() => reply.fail(new Error(timeoutMessage)), timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) { abort(); return }
    try { send(requestId) } catch (error) { reply.fail(error) }
  })
}
