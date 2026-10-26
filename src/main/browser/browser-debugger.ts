/** Shared per-page CDP ownership. Cancellation stops waiting, not the underlying Chromium work;
 * keep the queue locked until that work (including input cleanup) has actually settled. */
import type { Debugger, WebContents } from 'electron'

const operations = new WeakMap<WebContents, Promise<unknown>>()
const connections = new WeakMap<WebContents, { references: number; owned: boolean; detached: () => void }>()

export interface BrowserDebuggerLease {
  api: Debugger
  release(): void
}

/** Long-lived observers and queued temporary operations share connection ownership. */
export function acquireBrowserDebugger(contents: WebContents): BrowserDebuggerLease {
  if (contents.isDestroyed()) throw new Error('Browser page is closed')
  const api = contents.debugger
  let connection = connections.get(contents)
  if (!connection) {
    const owned = !api.isAttached()
    if (owned) api.attach('1.3')
    connection = { references: 0, owned, detached: () => { if (connection) connection.owned = false } }
    connections.set(contents, connection)
    api.on?.('detach', connection.detached)
  } else if (!api.isAttached()) {
    api.attach('1.3')
    connection.owned = true
  }
  connection.references++
  const held = connection
  let released = false
  return { api, release() {
    if (released) return
    released = true
    if (--held.references !== 0) return
    connections.delete(contents)
    api.removeListener?.('detach', held.detached)
    if (held.owned && !contents.isDestroyed() && api.isAttached()) api.detach()
  } }
}

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
    const lease = acquireBrowserDebugger(contents)
    try { return await operation(lease.api) }
    finally { lease.release() }
  }
  const previous = operations.get(contents)
  const result = previous ? previous.then(run, run) : run()
  operations.set(contents, result)
  const cleanup = () => { if (operations.get(contents) === result) operations.delete(contents) }
  void result.then(cleanup, cleanup)
  return waitForBrowserOperation(result, signal)
}
