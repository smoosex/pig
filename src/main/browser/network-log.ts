/** One observer per Session routes metadata to bounded, independently disposable page logs. */
import type { Session, WebContents, OnBeforeRequestListenerDetails } from 'electron'

export interface BrowserNetworkEntry {
  id: string
  method: string
  url: string
  resourceType: string
  statusCode?: number
  durationMs?: number
  error?: string
  failed?: true
  redirectedTo?: string
}

export interface BrowserNetworkLog {
  entries(): BrowserNetworkEntry[]
  clear(): void
  dispose(): void
}

type RequestDetails = Pick<OnBeforeRequestListenerDetails, 'id' | 'webContentsId' | 'url' | 'method' | 'resourceType' | 'timestamp'>
type ResultDetails = RequestDetails & { statusCode?: number; error?: string; redirectURL?: string }
interface Pending {
  entry: BrowserNetworkEntry
  timestamp: number
  clock: number
}
interface SessionObserver {
  pages: Map<number, PageNetworkLog>
}
const observers = new WeakMap<Session, SessionObserver>()
const LIMIT = 200

function metadataUrl(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    // Invalid external URL metadata is not loggable. Skipping it never cancels the request.
    if (error instanceof TypeError) return undefined
    throw error
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  return url.href
}

function observerFor(session: Session): SessionObserver {
  const existing = observers.get(session)
  if (existing) return existing
  const observer: SessionObserver = { pages: new Map() }
  const owner = (details: RequestDetails): PageNetworkLog | undefined =>
    details.webContentsId === undefined ? undefined : observer.pages.get(details.webContentsId)
  session.webRequest.onBeforeRequest((details, callback) => {
    try {
      owner(details)?.begin(details)
    } finally {
      // Even unowned/invalid requests and observer failures must be allowed through.
      callback({})
    }
  })
  session.webRequest.onCompleted(details => owner(details)?.finish(details))
  session.webRequest.onErrorOccurred(details => owner(details)?.finish(details, true))
  session.webRequest.onBeforeRedirect(details => owner(details)?.finish(details))
  observers.set(session, observer)
  return observer
}

class PageNetworkLog implements BrowserNetworkLog {
  private rows = new Map<string, BrowserNetworkEntry>()
  private pending = new Map<number, Pending>()
  private sequence = 0
  private disposed = false
  private readonly destroyed = (): void => this.dispose()

  constructor(private contents: WebContents, private observer: SessionObserver) {
    contents.once('destroyed', this.destroyed)
  }

  begin(details: RequestDetails): void {
    if (this.disposed) return
    const url = metadataUrl(details.url)
    if (!url) return
    const entry: BrowserNetworkEntry = {
      id: `${details.id}:${++this.sequence}`,
      method: details.method,
      url,
      resourceType: details.resourceType
    }
    this.rows.set(entry.id, entry)
    this.pending.set(details.id, { entry, timestamp: details.timestamp, clock: performance.now() })
    if (this.rows.size > LIMIT) {
      const oldest = this.rows.keys().next().value!
      this.rows.delete(oldest)
      // Eviction must release in-flight references as well as visible history.
      for (const [id, request] of this.pending) {
        if (request.entry.id === oldest) this.pending.delete(id)
      }
    }
  }

  finish(details: ResultDetails, failed = false): void {
    if (this.disposed) return
    const request = this.pending.get(details.id)
    if (!request || metadataUrl(details.url) !== request.entry.url) return
    const timed = Number.isFinite(details.timestamp) && Number.isFinite(request.timestamp)
    // Redirect hops reuse request IDs. An older hop/result must never finish a newer one.
    if (timed && details.timestamp < request.timestamp) return
    this.pending.delete(details.id)
    const entry = request.entry
    entry.durationMs = Math.max(0, timed ? details.timestamp - request.timestamp : performance.now() - request.clock)
    if (details.statusCode !== undefined) entry.statusCode = details.statusCode
    if (failed) entry.failed = true
    if (details.error && /^net::ERR_[A-Z0-9_]+(?![\s\S])/.test(details.error)) entry.error = details.error
    if (details.redirectURL !== undefined) {
      const redirectedTo = metadataUrl(details.redirectURL)
      if (redirectedTo) entry.redirectedTo = redirectedTo
    }
  }

  entries(): BrowserNetworkEntry[] {
    return [...this.rows.values()].map(entry => ({ ...entry }))
  }

  clear(): void {
    this.rows.clear()
    // Results without a current begin are ignored; no tombstones or old document references remain.
    this.pending.clear()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clear()
    this.contents.removeListener('destroyed', this.destroyed)
    if (this.observer.pages.get(this.contents.id) === this) this.observer.pages.delete(this.contents.id)
  }
}

export function attachBrowserNetwork(contents: WebContents): BrowserNetworkLog {
  if (contents.isDestroyed()) throw new Error('Cannot attach network log to destroyed WebContents')
  const observer = observerFor(contents.session)
  if (observer.pages.has(contents.id)) throw new Error('Browser network log already attached')
  const log = new PageNetworkLog(contents, observer)
  observer.pages.set(contents.id, log)
  return log
}
