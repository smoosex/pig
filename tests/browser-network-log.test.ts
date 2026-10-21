import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { Session, WebContents, OnBeforeRequestListenerDetails } from 'electron'
import { attachBrowserNetwork, type BrowserNetworkLog } from '../src/main/browser/network-log'

type Details = Pick<OnBeforeRequestListenerDetails, 'id' | 'webContentsId' | 'url' | 'method' | 'resourceType' | 'timestamp'> & {
  statusCode?: number
  error?: string
  redirectURL?: string
}
function fixture() {
  const installed = { before: 0, completed: 0, error: 0, redirect: 0 }
  let before!: (details: Details, callback: (response: object) => void) => void
  let completed!: (details: Details) => void
  let error!: (details: Details) => void
  let redirect!: (details: Details) => void
  const session = { webRequest: {
    onBeforeRequest(listener: typeof before) { installed.before++; before = listener },
    onCompleted(listener: typeof completed) { installed.completed++; completed = listener },
    onErrorOccurred(listener: typeof error) { installed.error++; error = listener },
    onBeforeRedirect(listener: typeof redirect) { installed.redirect++; redirect = listener }
  } } as unknown as Session
  const contents = (id: number) => Object.assign(new EventEmitter(), {
    id, session, dead: false, isDestroyed() { return this.dead }
  })
  const first = contents(1)
  const second = contents(2)
  const attach = (wc = first) => attachBrowserNetwork(wc as unknown as WebContents)
  const details = (overrides: Partial<Details> = {}): Details => ({
    id: 1, webContentsId: 1, url: 'https://example.test/path', method: 'GET', resourceType: 'xhr', timestamp: 1000, ...overrides
  })
  const begin = (value = details()) => {
    const callbacks: object[] = []
    before(value, response => callbacks.push(response))
    expect(callbacks).toEqual([{}])
  }
  return { installed, first, second, attach, details, begin,
    rawBegin: (value: Details, callback: (response: object) => void) => before(value, callback),
    completed: (value: Details) => completed(value),
    error: (value: Details) => error(value),
    redirect: (value: Details) => redirect(value) }
}
const pendingSize = (log: BrowserNetworkLog): number => (log as unknown as { pending: Map<number, unknown> }).pending.size

describe('browser network log', () => {
  test('one listener per session routes pages independently and always allows unowned requests', () => {
    const f = fixture()
    const a = f.attach()
    const b = f.attach(f.second)
    expect(f.installed).toEqual({ before: 1, completed: 1, error: 1, redirect: 1 })
    f.begin()
    f.begin(f.details({ id: 2, webContentsId: 2 }))
    f.begin(f.details({ id: 3, webContentsId: 999 }))
    f.begin(f.details({ id: 4, webContentsId: undefined }))
    f.completed(f.details({ statusCode: 200, timestamp: 1042 }))
    expect(a.entries()).toEqual([{ id: '1:1', url: 'https://example.test/path', method: 'GET', resourceType: 'xhr', statusCode: 200, durationMs: 42 }])
    expect(b.entries()).toHaveLength(1)
    expect(b.entries()[0]!.durationMs).toBeUndefined()
    expect(fixture().attach().entries()).toEqual([])
  })

  test('only HTTP metadata survives; credentials/query/hash/headers/body and unsafe errors never escape', () => {
    const f = fixture()
    const log = f.attach()
    const raw = { ...f.details({ url: 'https://userSecret:passwordSecret@example.test:8443/path?querySecret=1#hashSecret' }),
      requestHeaders: { Authorization: 'headerSecret' }, responseHeaders: { 'Set-Cookie': ['cookieSecret'] }, uploadData: [{ bytes: Buffer.from('bodySecret') }] }
    f.begin(raw)
    f.redirect({ ...raw, timestamp: 1008, statusCode: 302, redirectURL: 'http://userSecret:passwordSecret@next.test/end?querySecret#hashSecret' })
    expect(log.entries()).toEqual([{ id: '1:1', method: 'GET', resourceType: 'xhr', url: 'https://example.test:8443/path', statusCode: 302, durationMs: 8, redirectedTo: 'http://next.test/end' }])
    expect(JSON.stringify(log.entries())).not.toContain('Secret')
    for (const [index, error] of ['net::ERR_FAILED https://secret.test', 'secret', 'net::ERR_FAILED\n', 'net::err_failed', 'net::ERR_'].entries()) {
      f.begin(f.details({ id: index + 10 }))
      f.error(f.details({ id: index + 10, timestamp: 1002, error }))
      expect(log.entries().at(-1)!.error).toBeUndefined()
      expect(log.entries().at(-1)!.failed).toBe(true)
      expect(pendingSize(log)).toBe(0)
    }
    f.begin(f.details({ id: 20 }))
    f.error(f.details({ id: 20, timestamp: 1010, error: 'net::ERR_CONNECTION_REFUSED' }))
    expect(log.entries().at(-1)).toMatchObject({ error: 'net::ERR_CONNECTION_REFUSED', durationMs: 10 })
  })

  test('invalid/non-HTTP URLs and redirect targets are skipped without blocking', () => {
    const f = fixture()
    const log = f.attach()
    for (const url of ['not a URL', 'http://[invalid', 'file:///secret', 'data:text/plain,secret', 'ws://example.test', 'about:blank']) f.begin(f.details({ url }))
    expect(log.entries()).toEqual([])
    expect(pendingSize(log)).toBe(0)
    f.begin()
    f.redirect(f.details({ timestamp: 1005, statusCode: 302, redirectURL: 'file:///secret' }))
    expect(log.entries()[0]).toMatchObject({ statusCode: 302, durationMs: 5 })
    expect(log.entries()[0]!.redirectedTo).toBeUndefined()
  })

  test('redirect hops reuse Electron IDs but have distinct records and independent durations', () => {
    const f = fixture()
    const log = f.attach()
    f.begin()
    f.redirect(f.details({ statusCode: 301, timestamp: 1010, redirectURL: 'https://next.test/' }))
    f.begin(f.details({ url: 'https://next.test/', timestamp: 1012 }))
    f.completed(f.details({ timestamp: 1011, statusCode: 301 }))
    f.completed(f.details({ url: 'https://next.test/', timestamp: 1030, statusCode: 200 }))
    expect(log.entries()).toEqual([
      { id: '1:1', url: 'https://example.test/path', method: 'GET', resourceType: 'xhr', statusCode: 301, durationMs: 10, redirectedTo: 'https://next.test/' },
      { id: '1:2', url: 'https://next.test/', method: 'GET', resourceType: 'xhr', statusCode: 200, durationMs: 18 }
    ])
    expect(pendingSize(log)).toBe(0)
  })

  test('clear isolates old results and stale same-ID events cannot finish newer requests', () => {
    const f = fixture()
    const log = f.attach()
    f.begin()
    log.clear()
    f.completed(f.details({ timestamp: 1010, statusCode: 200 }))
    f.error(f.details({ timestamp: 1011, error: 'net::ERR_ABORTED' }))
    f.redirect(f.details({ timestamp: 1012, statusCode: 302, redirectURL: 'https://old.test' }))
    expect(log.entries()).toEqual([])
    f.begin(f.details({ timestamp: 1100 }))
    f.completed(f.details({ timestamp: 1013, statusCode: 500 }))
    f.error(f.details({ timestamp: 1014, error: 'net::ERR_ABORTED' }))
    f.redirect(f.details({ timestamp: 1015, statusCode: 302, redirectURL: 'https://old.test' }))
    expect(log.entries()[0]!.statusCode).toBeUndefined()
    expect(pendingSize(log)).toBe(1)
    f.completed(f.details({ timestamp: 1120, statusCode: 204 }))
    expect(log.entries()[0]).toMatchObject({ id: '1:2', statusCode: 204, durationMs: 20 })
  })

  test('history and pending remain bounded even when requests never complete', () => {
    const f = fixture()
    const log = f.attach()
    for (let id = 1; id <= 1000; id++) {
      f.begin(f.details({ id }))
      expect(log.entries().length).toBeLessThanOrEqual(200)
      expect(pendingSize(log)).toBeLessThanOrEqual(200)
    }
    expect(log.entries()).toHaveLength(200)
    expect(log.entries()[0]!.id).toBe('801:801')
    for (let id = 1; id <= 1000; id++) f.completed(f.details({ id, timestamp: 1100, statusCode: 200 }))
    expect(pendingSize(log)).toBe(0)
    expect(log.entries()).toHaveLength(200)
    expect(log.entries().every(entry => entry.statusCode === 200)).toBe(true)
    log.clear()
    expect(log.entries()).toEqual([])
    expect(pendingSize(log)).toBe(0)
  })

  test('entries are defensive copies, timestamp fallback is finite, duplicate results do not mutate records', () => {
    const f = fixture()
    const log = f.attach()
    f.begin(f.details({ timestamp: NaN }))
    f.completed(f.details({ timestamp: NaN, statusCode: 200 }))
    const copy = log.entries()
    expect(Number.isFinite(copy[0]!.durationMs)).toBe(true)
    expect(copy[0]!.durationMs).toBeGreaterThanOrEqual(0)
    copy[0]!.url = 'changed'
    copy.length = 0
    f.error(f.details({ timestamp: 1100, error: 'net::ERR_FAILED' }))
    expect(log.entries()[0]!.url).toBe('https://example.test/path')
    expect(log.entries()[0]!.error).toBeUndefined()
  })

  test('duplicate attach fails fast; dispose/destroy remove only their owner without replacing listeners', () => {
    const f = fixture()
    const old = f.attach()
    const other = f.attach(f.second)
    expect(() => f.attach()).toThrow('already attached')
    f.begin()
    old.dispose()
    f.completed(f.details({ timestamp: 1010, statusCode: 200 }))
    expect(old.entries()).toEqual([])
    const fresh = f.attach()
    old.dispose()
    f.begin(f.details({ timestamp: 1100 }))
    f.completed(f.details({ timestamp: 1010, statusCode: 500 }))
    expect(fresh.entries()[0]!.statusCode).toBeUndefined()
    f.completed(f.details({ timestamp: 1120, statusCode: 201 }))
    expect(fresh.entries()[0]!.statusCode).toBe(201)
    f.first.dead = true
    f.first.emit('destroyed')
    f.begin()
    expect(fresh.entries()).toEqual([])
    expect(() => f.attach()).toThrow('destroyed')
    f.begin(f.details({ webContentsId: 2, id: 2 }))
    expect(other.entries()).toHaveLength(1)
    expect(f.installed).toEqual({ before: 1, completed: 1, error: 1, redirect: 1 })
  })

  test('unexpected observer exceptions propagate while callback still runs', () => {
    const f = fixture()
    f.attach()
    const callbacks: object[] = []
    const malformed = f.details()
    Object.defineProperty(malformed, 'url', { get() { throw new Error('unexpected') } })
    expect(() => f.rawBegin(malformed, response => callbacks.push(response))).toThrow('unexpected')
    expect(callbacks).toEqual([{}])
  })
})
