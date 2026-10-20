/** Shared per-page CDP ownership. Cancellation stops waiting, not the underlying Chromium work;
 * keep the queue locked until that work (including input cleanup) has actually settled. */
import type { Debugger, WebContents } from 'electron'

const operations = new WeakMap<WebContents, Promise<unknown>>()

export function waitForBrowserOperation<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort)
    const abort = () => { cleanup(); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    work.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
    if (signal.aborted) abort()
  })
}

export function withBrowserDebugger<T>(
  contents: WebContents,
  operation: (debuggerApi: Debugger) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const run = async () => {
    signal?.throwIfAborted()
    if (contents.isDestroyed()) throw new Error('Browser page is closed')
    const api = contents.debugger
    const attachedHere = !api.isAttached()
    if (attachedHere) api.attach('1.3')
    try { return await operation(api) }
    finally {
      if (attachedHere && !contents.isDestroyed() && api.isAttached()) api.detach()
    }
  }
  const previous = operations.get(contents)
  const result = previous ? previous.then(run, run) : run()
  operations.set(contents, result)
  const cleanup = () => { if (operations.get(contents) === result) operations.delete(contents) }
  void result.then(cleanup, cleanup)
  return waitForBrowserOperation(result, signal)
}
