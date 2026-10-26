/** Opt-in CDP capture. Redaction is best-effort, not a general secret detector: paths,
 * free text and application-specific fields can still contain sensitive information.
 * Returned details are data; callers must render them in an untrusted JSON fence. */
import type { WebContents } from 'electron'
import { acquireBrowserDebugger, withBrowserDebugger, type BrowserDebuggerLease } from './browser-debugger'
import type { BrowserNetworkCaptureOptions } from '../plugins/pig-browser-host'

const LIMIT = 200
const BYTES = 64 * 1024
const REDACTED = '[REDACTED]'
const sensitive = (key: string): boolean => /password|passwd|pwd|token|secret|authorization|cookie|apikey|session|credential|csrf|xsrf|privatekey|accesskey|signingkey|signature|bearer|jwt|^(key|auth|code)$/i.test(key.replace(/[^a-z0-9]/gi, ''))
export type CaptureBodyState = 'pending' | 'available' | 'binary' | 'too-large' | 'unavailable' | 'stopped' | 'redirected' | 'failed'
export interface CaptureBody { state: CaptureBodyState; text?: string }
export interface BrowserNetworkCaptureMetadata {
  id: string
  url: string
  method: string
  resourceType: string
  status?: number
  bodyState: CaptureBodyState
}
export interface BrowserNetworkCaptureDetail extends BrowserNetworkCaptureMetadata {
  query: [string, string][]
  requestHeaders: Record<string, string>
  postData?: CaptureBody
  responseHeaders?: Record<string, string>
  responseBody: CaptureBody
}
export interface BrowserNetworkCapture {
  readonly active: boolean
  /** Sanitized asynchronous detach/cleanup failures (never raw Chromium errors). */
  readonly error: string | undefined
  start(options?: BrowserNetworkCaptureOptions): Promise<void>
  stop(): Promise<void>
  clear(): void
  dispose(): void
  entries(): BrowserNetworkCaptureMetadata[]
  detail(id: string): BrowserNetworkCaptureDetail
}
interface RequestEvent {
  requestId: string; timestamp: number; type?: string
  request: { url: string; method: string; headers?: Record<string, unknown>; postData?: string; hasPostData?: boolean }
  redirectResponse?: { status: number; headers?: Record<string, unknown> }
}
interface ResponseEvent {
  requestId: string; timestamp: number
  response: { status: number; headers?: Record<string, unknown>; mimeType?: string }
}
interface CompletionEvent { requestId: string; timestamp: number; encodedDataLength?: number }
interface DataEvent { requestId: string; timestamp: number; dataLength?: number }
interface Row { detail: BrowserNetworkCaptureDetail; requestId: string; timestamp: number; epoch: number; mime: string; finished: boolean; superseded: boolean; decoded: number }
const captures = new WeakMap<WebContents, PageCapture>()
const size = (text: string): number => Buffer.byteLength(text, 'utf8')

function safeUrl(value: string): URL | undefined {
  if (value.length > 8192) return undefined
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return undefined
    url.username = ''; url.password = ''; url.hash = ''
    const pairs = [...url.searchParams].map(([key, val]) => [key, sensitive(key) ? REDACTED : val] as const)
    url.search = ''
    for (const [key, val] of pairs) url.searchParams.append(key, val)
    return url
  } catch { return undefined }
}
function headers(input: Record<string, unknown> = {}): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>
  let budget = 8192
  for (const [key, value] of Object.entries(input)) {
    if (sensitive(key) || typeof value !== 'string') continue
    const clean = /^(location|referer|referrer)$/i.test(key) ? safeUrl(value)?.href ?? '[omitted]' : value
    const cost = size(key) + size(clean)
    if (cost > budget) continue
    result[key] = clean; budget -= cost
    if (Object.keys(result).length >= 100) break
  }
  return result
}
function redactJson(value: unknown, depth = 0): unknown {
  if (depth > 32) return '[depth limit]'
  if (Array.isArray(value)) return value.map(item => redactJson(item, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitive(key) ? REDACTED : redactJson(item, depth + 1)]))
  return value
}
function body(text: string, mime: string, budget = BYTES): CaptureBody {
  if (size(text) > budget) return { state: 'too-large' }
  let clean = text
  if (/application\/x-www-form-urlencoded/i.test(mime)) {
    const form = new URLSearchParams(text)
    clean = [...form].map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(sensitive(key) ? REDACTED : value)}`).join('&')
  } else {
    // fetch() sends JSON.stringify bodies as text/plain by default, and some servers mislabel JSON;
    // any parseable text is redacted as JSON. Non-JSON text is an expected outcome, not a failure,
    // except under a JSON mime, where an unredactable body must not be returned raw.
    let parsed: unknown
    try { parsed = JSON.parse(text) }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      if (/json/i.test(mime)) return { state: 'unavailable' }
    }
    if (parsed !== null && typeof parsed === 'object') clean = JSON.stringify(redactJson(parsed))
  }
  return size(clean) > budget ? { state: 'too-large' } : { state: 'available', text: clean }
}
const textual = (mime: string): boolean => /^(text\/|application\/(?:[\w.+-]*json|[\w.+-]*xml|javascript|x-www-form-urlencoded)(?:;|$))/i.test(mime)
function metadata(row: Row): BrowserNetworkCaptureMetadata {
  const { id, url, method, resourceType, status, responseBody } = row.detail
  return { id, url, method, resourceType, ...(status === undefined ? {} : { status }), bodyState: responseBody.state }
}

class PageCapture implements BrowserNetworkCapture {
  active = false
  error: string | undefined
  private disposed = false
  private epoch = 0
  private sequence = 0
  private rows = new Map<string, Row>()
  private pending = new Map<string, Row>()
  private options: BrowserNetworkCaptureOptions = {}
  private lease?: BrowserDebuggerLease
  private lifecycle: Promise<void> = Promise.resolve()
  private reading = false
  private queue: Row[] = []
  private readonly destroyed = (): void => this.dispose()
  private readonly detached = (): void => {
    if (!this.active) return
    this.error = 'Network capture debugger disconnected'
    this.invalidate()
    this.release()
  }
  private readonly message = (_event: unknown, method: string, params: unknown): void => {
    if (!this.active || !params || typeof params !== 'object') return
    if (method === 'Network.requestWillBeSent') this.begin(params as RequestEvent)
    else if (method === 'Network.responseReceived') this.respond(params as ResponseEvent)
    else if (method === 'Network.dataReceived') this.received(params as DataEvent)
    else if (method === 'Network.loadingFinished') this.finish(params as CompletionEvent)
    else if (method === 'Network.loadingFailed') {
      const row = this.current(params as CompletionEvent)
      if (row) { row.finished = true; row.detail.responseBody = { state: 'failed' }; this.pending.delete(row.requestId) }
    }
  }
  constructor(private contents: WebContents) {
    contents.once('destroyed', this.destroyed)
    contents.debugger.on('message', this.message)
    contents.debugger.on('detach', this.detached)
  }
  private release(): void {
    const lease = this.lease; this.lease = undefined
    try { lease?.release() } catch { this.error = 'Network capture debugger release failed' }
  }
  private invalidate(): number {
    this.active = false
    for (const row of this.rows.values()) if (row.detail.responseBody.state === 'pending') row.detail.responseBody = { state: 'stopped' }
    this.pending.clear(); this.queue = []
    return ++this.epoch
  }
  private serial(work: () => Promise<void>): Promise<void> {
    const result = this.lifecycle.then(work)
    this.lifecycle = result.catch(() => {}) // Public result retains the sanitized failure.
    return result
  }
  start(options: BrowserNetworkCaptureOptions = {}): Promise<void> {
    if ((options.urlIncludes?.length ?? 0) > 8192 || (options.resourceTypes?.length ?? 0) > 64 || options.resourceTypes?.some(type => type.length > 64)) {
      return Promise.reject(new Error('Network capture filters exceed limits'))
    }
    const epoch = this.invalidate()
    const snapshot = { urlIncludes: options.urlIncludes, resourceTypes: options.resourceTypes?.slice() }
    return this.serial(async () => {
      if (this.disposed) throw new Error('Network capture is disposed')
      if (epoch !== this.epoch) return
      this.clear(); this.error = undefined; this.options = snapshot
      try {
        this.lease ??= acquireBrowserDebugger(this.contents)
        await this.lease.api.sendCommand('Network.enable', { maxTotalBufferSize: LIMIT * BYTES, maxResourceBufferSize: BYTES, maxPostDataSize: BYTES })
        if (epoch === this.epoch && !this.disposed) this.active = true
      } catch {
        this.error = 'Network capture could not start'; this.release()
        throw new Error(this.error)
      }
    })
  }
  stop(): Promise<void> {
    this.invalidate()
    return this.serial(async () => {
      const lease = this.lease
      if (!lease) return
      try {
        if (!captures.has(this.contents) || captures.get(this.contents) === this) await lease.api.sendCommand('Network.disable')
      }
      catch { this.error = 'Network capture could not stop'; throw new Error(this.error) }
      finally { this.release() }
    })
  }
  clear(): void { this.rows.clear(); this.pending.clear(); this.queue = [] }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.invalidate(); this.clear()
    this.contents.removeListener('destroyed', this.destroyed)
    this.contents.debugger.removeListener('message', this.message)
    this.contents.debugger.removeListener('detach', this.detached)
    captures.delete(this.contents)
    // Keep the lease through disable; a simultaneous temporary operation holds its own lease.
    void this.serial(async () => {
      try {
        if (this.lease && !this.contents.isDestroyed() && !captures.has(this.contents)) await this.lease.api.sendCommand('Network.disable')
      }
      catch { this.error = 'Network capture cleanup failed' }
      finally { this.release() }
    })
  }
  entries(): BrowserNetworkCaptureMetadata[] { return [...this.rows.values()].map(metadata) }
  detail(id: string): BrowserNetworkCaptureDetail {
    const row = this.rows.get(id)
    if (!row) throw new Error('Network capture entry not found')
    return structuredClone({ ...row.detail, ...metadata(row) })
  }
  private begin(event: RequestEvent): void {
    if (typeof event.requestId !== 'string' || !event.request || typeof event.request.url !== 'string') return
    let previous: Row | undefined
    for (const row of this.rows.values()) if (row.requestId === event.requestId) previous = row
    if (previous && event.timestamp < previous.timestamp) return
    if (previous) {
      previous.superseded = true
      previous.finished = true
      previous.detail.responseBody = { state: event.redirectResponse ? 'redirected' : 'unavailable' }
      if (event.redirectResponse) {
        previous.detail.status = event.redirectResponse.status
        previous.detail.responseHeaders = headers(event.redirectResponse.headers)
      }
      this.pending.delete(event.requestId)
    }
    const url = safeUrl(event.request.url)
    if (!url || (this.options.urlIncludes && !event.request.url.includes(this.options.urlIncludes)) ||
      (this.options.resourceTypes?.length && !this.options.resourceTypes.includes(event.type ?? 'Other'))) return
    const requestHeaders = headers(event.request.headers)
    const mime = Object.entries(requestHeaders).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? ''
    const detail: BrowserNetworkCaptureDetail = {
      id: `${++this.sequence}`, url: url.href, method: event.request.method.slice(0, 64), resourceType: (event.type ?? 'Other').slice(0, 64),
      query: [...url.searchParams], requestHeaders, bodyState: 'pending', responseBody: { state: 'pending' }
    }
    if (event.request.postData !== undefined) detail.postData = textual(mime) ? body(event.request.postData, mime) : { state: 'binary' }
    // CDP omits postData when it exceeds maxPostDataSize (Network.enable above).
    else if (event.request.hasPostData) detail.postData = { state: 'too-large' }
    const row: Row = { detail, requestId: event.requestId, timestamp: event.timestamp, epoch: this.epoch, mime: '', finished: false, superseded: false, decoded: 0 }
    this.rows.set(detail.id, row); this.pending.set(event.requestId, row)
    if (this.rows.size > LIMIT) {
      const oldest = this.rows.values().next().value!
      this.rows.delete(oldest.detail.id)
      if (this.pending.get(oldest.requestId) === oldest) this.pending.delete(oldest.requestId)
      this.queue = this.queue.filter(item => item !== oldest)
    }
  }
  private current(event: CompletionEvent): Row | undefined {
    const row = this.pending.get(event.requestId)
    return row && event.timestamp >= row.timestamp ? row : undefined
  }
  private respond(event: ResponseEvent): void {
    const row = this.current(event)
    if (!row || !event.response) return
    row.detail.status = event.response.status
    row.detail.responseHeaders = headers(event.response.headers)
    row.mime = (event.response.mimeType ?? '').slice(0, 256)
  }
  private received(event: DataEvent): void {
    const row = this.current(event)
    if (row && Number.isFinite(event.dataLength)) row.decoded += event.dataLength!
  }
  private finish(event: CompletionEvent): void {
    const row = this.current(event)
    if (!row || row.finished) return
    row.finished = true; this.pending.delete(row.requestId)
    if (!textual(row.mime)) row.detail.responseBody = { state: 'binary' }
    // Chromium does not buffer a resource whose decoded size exceeds maxResourceBufferSize, so
    // getResponseBody would fail; decide by size rather than by its error text.
    else if ((event.encodedDataLength ?? 0) > BYTES || row.decoded > BYTES) row.detail.responseBody = { state: 'too-large' }
    else { this.queue.push(row); void this.pump() }
  }
  private valid(row: Row): boolean { return this.active && !row.superseded && row.epoch === this.epoch && this.rows.get(row.detail.id) === row }
  private async pump(): Promise<void> {
    if (this.reading) return
    this.reading = true
    try {
      while (this.queue.length) {
        const row = this.queue.shift()!
        if (!this.valid(row)) continue
        try {
          const result: unknown = await withBrowserDebugger(this.contents, async api => {
            if (!this.valid(row)) return undefined
            return api.sendCommand('Network.getResponseBody', { requestId: row.requestId }) as Promise<unknown>
          })
          if (!this.valid(row)) continue
          if (!result || typeof result !== 'object' || !('body' in result) || typeof result.body !== 'string') throw new Error('Invalid body')
          // Never decode opaque/base64 payloads or truncate a secret-bearing structured body.
          row.detail.responseBody = 'base64Encoded' in result && result.base64Encoded === true ? { state: 'binary' }
            : body(result.body, row.mime, BYTES - size(row.detail.postData?.text ?? ''))
        } catch {
          // Boundary: Chromium errors (evicted buffer, closed target) may echo page data, so the
          // record gets an explicit state instead of the raw message.
          if (this.valid(row)) row.detail.responseBody = { state: 'unavailable' }
        }
      }
    } finally { this.reading = false }
  }
}

export function attachBrowserNetworkCapture(contents: WebContents): BrowserNetworkCapture {
  if (contents.isDestroyed()) throw new Error('Cannot attach network capture to closed page')
  if (captures.has(contents)) throw new Error('Network capture already attached')
  const capture = new PageCapture(contents)
  captures.set(contents, capture)
  return capture
}
