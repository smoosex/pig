import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { attachBrowserNetworkCapture } from '../src/main/browser/network-capture'
import { withBrowserDebugger } from '../src/main/browser/browser-debugger'

function fixture(external = false) {
  let attached = external
  const commands: string[] = []
  let handler = async (_method: string): Promise<unknown> => ({ body: '{"ok":true}', base64Encoded: false })
  const api = Object.assign(new EventEmitter(), {
    isAttached: () => attached,
    attach: () => { attached = true; commands.push('attach') },
    detach: () => { attached = false; commands.push('detach'); api.emit('detach', {}, 'target closed') },
    sendCommand: async (method: string) => { commands.push(method); return handler(method) }
  })
  const wc = Object.assign(new EventEmitter(), { debugger: api, isDestroyed: () => false })
  const contents = wc as unknown as WebContents
  const capture = attachBrowserNetworkCapture(contents)
  const emit = (method: string, params: object) => api.emit('message', {}, `Network.${method}`, params)
  const begin = (id = '1', url = 'https://example.test/', extra: object = {}, timestamp = 1) => emit('requestWillBeSent', {
    requestId: id, timestamp, type: 'Fetch', request: { url, method: 'POST', ...extra }
  })
  const response = (id = '1', mimeType = 'application/json', extra: object = {}) => emit('responseReceived', {
    requestId: id, timestamp: 2, response: { status: 200, mimeType, ...extra }
  })
  const finish = (id = '1', encodedDataLength = 10) => emit('loadingFinished', { requestId: id, timestamp: 3, encodedDataLength })
  return { capture, api, wc, contents, commands, emit, begin, response, finish, setHandler(next: typeof handler) { handler = next } }
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const deferred = () => {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>(done => { resolve = done })
  return { promise, resolve }
}

describe('on-demand browser network capture', () => {
  test('opt-in, filters, cross-navigation, body only after completion, stop retains and start resets', async () => {
    const f = fixture()
    f.begin(); expect(f.capture.entries()).toEqual([])
    await f.capture.start({ urlIncludes: '/api', resourceTypes: ['Fetch'] })
    f.begin('skip'); f.begin('file', 'file:///api'); f.begin('1', 'https://example.test/api')
    f.response()
    expect(f.commands).not.toContain('Network.getResponseBody')
    f.wc.emit('did-start-navigation')
    f.finish(); await flush()
    expect(f.capture.entries()).toHaveLength(1)
    expect(f.capture.detail('1').responseBody).toEqual({ state: 'available', text: '{"ok":true}' })
    const copy = f.capture.detail('1'); copy.requestHeaders.changed = 'x'
    expect(f.capture.detail('1').requestHeaders.changed).toBeUndefined()
    await f.capture.stop()
    f.begin('2', 'https://example.test/api')
    expect(f.capture.active).toBe(false); expect(f.capture.entries()).toHaveLength(1)
    await f.capture.start(); expect(f.capture.entries()).toEqual([])
    f.capture.dispose(); await flush()
    expect(f.api.listenerCount('message')).toBe(0)
    expect(f.commands.at(-1)).toBe('detach')
  })

  test('redacts credentials, common query/headers/nested JSON and form keys without returning raw failures', async () => {
    const f = fixture()
    await f.capture.start()
    f.begin('1', 'https://userSecret:passSecret@example.test/api?api-key=querySecret&ok=yes#secret', {
      headers: { Authorization: 'authSecret', Cookie: 'cookieSecret', 'X-Api-Key': 'keySecret', 'Content-Type': 'application/json' },
      postData: '{"password":"postSecret","nested":{"access_token":"nestedSecret"},"ok":1}'
    })
    f.response('1', 'application/json', { headers: { 'Set-Cookie': 'responseSecret', Location: 'https://u:p@example.test/?token=locationSecret', Accept: 'json' } })
    f.setHandler(async () => ({ body: '{"secret":"bodySecret","list":[{"api_key":"listSecret"}],"ok":true}' }))
    f.finish(); await flush()
    const detail = f.capture.detail('1')
    expect(JSON.stringify(detail)).not.toContain('Secret')
    expect(detail.query).toEqual([['api-key', '[REDACTED]'], ['ok', 'yes']])
    expect(detail.responseBody.text).toContain('[REDACTED]')
    f.begin('2', 'https://example.test/', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, postData: 'password=formSecret&ok=yes' })
    expect(f.capture.detail('2').postData?.text).not.toContain('formSecret')
    f.response('2'); f.setHandler(async () => { throw new Error('Authorization=rawSecret') }); f.finish('2'); await flush()
    expect(f.capture.detail('2').responseBody).toEqual({ state: 'unavailable' })
    f.setHandler(async () => ({}))
    await f.capture.stop()
    f.setHandler(async () => { throw new Error('cookie=rawSecret') })
    await expect(f.capture.start()).rejects.toThrow('Network capture could not start')
    expect(f.capture.error).not.toContain('rawSecret')
    f.capture.dispose()
  })

  test('JSON sent or served as text/plain is redacted; plain text and JSON-labelled garbage stay explicit', async () => {
    const f = fixture(); await f.capture.start()
    f.begin('1', 'https://example.test/', { headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, postData: '{"password":"postSecret","ok":1}' })
    expect(f.capture.detail('1').postData).toEqual({ state: 'available', text: '{"password":"[REDACTED]","ok":1}' })
    f.response('1', 'text/html'); f.setHandler(async () => ({ body: '[{"token":"bodySecret"}]' })); f.finish(); await flush()
    expect(f.capture.detail('1').responseBody).toEqual({ state: 'available', text: '[{"token":"[REDACTED]"}]' })
    f.begin('2'); f.response('2', 'text/plain'); f.setHandler(async () => ({ body: 'hello {' })); f.finish('2'); await flush()
    expect(f.capture.detail('2').responseBody).toEqual({ state: 'available', text: 'hello {' })
    f.capture.dispose(); await flush()
  })

  test('bodies beyond the CDP buffers are too-large without asking Chromium for them', async () => {
    const f = fixture(); await f.capture.start()
    f.begin('1', 'https://example.test/', { hasPostData: true })
    expect(f.capture.detail('1').postData).toEqual({ state: 'too-large' })
    f.response('1', 'application/json')
    f.emit('dataReceived', { requestId: '1', timestamp: 2, dataLength: 40000, encodedDataLength: 2000 })
    f.emit('dataReceived', { requestId: '1', timestamp: 2, dataLength: 40000, encodedDataLength: 2000 })
    f.finish('1', 4000); await flush()
    expect(f.capture.detail('1').responseBody).toEqual({ state: 'too-large' })
    expect(f.commands).not.toContain('Network.getResponseBody')
    f.capture.dispose(); await flush()
  })

  test('bounded rows and text budgets, explicit binary/oversize states, serialized body fetch', async () => {
    const f = fixture(); await f.capture.start()
    for (let i = 0; i < 240; i++) f.begin(String(i))
    expect(f.capture.entries()).toHaveLength(200)
    expect(() => f.capture.detail('1')).toThrow('not found')
    f.response('239', 'image/png'); f.finish('239'); expect(f.capture.entries().at(-1)?.bodyState).toBe('binary')
    f.begin('large'); f.response('large'); f.finish('large', 65537)
    expect(f.capture.entries().at(-1)?.bodyState).toBe('too-large')
    const wait = deferred()
    f.setHandler(async method => method === 'Network.getResponseBody' ? wait.promise : {})
    f.begin('a'); f.response('a', 'text/plain'); f.finish('a')
    f.begin('b'); f.response('b', 'text/plain'); f.finish('b')
    await flush(); expect(f.commands.filter(x => x === 'Network.getResponseBody')).toHaveLength(1)
    wait.resolve({ body: 'x'.repeat(65537) }); await flush()
    expect(f.commands.filter(x => x === 'Network.getResponseBody')).toHaveLength(2)
    expect(f.capture.entries().at(-1)?.bodyState).toBe('too-large')
    f.begin('both', 'https://example.test/', { headers: { 'Content-Type': 'text/plain' }, postData: 'x'.repeat(40000) })
    f.response('both', 'text/plain'); f.setHandler(async () => ({ body: 'x'.repeat(30000) })); f.finish('both'); await flush()
    expect(f.capture.entries().at(-1)?.bodyState).toBe('too-large')
    f.capture.clear(); expect(f.capture.entries()).toEqual([])
    f.capture.dispose(); await flush()
  })

  test('redirect hops are distinct, stale timestamps and late body results never mutate restarted history', async () => {
    const f = fixture(); await f.capture.start()
    f.begin()
    f.emit('requestWillBeSent', { requestId: '1', timestamp: 2, type: 'Fetch', request: { url: 'https://next.test/', method: 'GET' }, redirectResponse: { status: 302, headers: { 'Set-Cookie': 'secret' } } })
    f.emit('responseReceived', { requestId: '1', timestamp: 1.5, response: { status: 500 } })
    expect(f.capture.entries().map(row => row.status)).toEqual([302, undefined])
    expect(f.capture.detail('1').responseBody.state).toBe('redirected')
    const wait = deferred()
    f.setHandler(async method => method === 'Network.getResponseBody' ? wait.promise : {})
    f.response(); f.finish(); await flush()
    await f.capture.stop(); await f.capture.start()
    f.begin('new')
    wait.resolve({ body: '{"old":true}' }); await flush()
    expect(f.capture.entries()).toHaveLength(1)
    expect(f.capture.entries()[0]?.bodyState).toBe('pending')
    f.capture.dispose(); await flush()
    expect(f.capture.active).toBe(false)
  })

  test('capture and temporary operations share owned leases but never detach external connections', async () => {
    for (const external of [false, true]) {
      const f = fixture(external)
      await f.capture.start()
      await withBrowserDebugger(f.contents, async () => {})
      expect(f.commands).not.toContain('detach')
      const wait = deferred()
      const operation = withBrowserDebugger(f.contents, () => wait.promise)
      await f.capture.stop()
      expect(f.commands).not.toContain('detach')
      wait.resolve(undefined); await operation
      expect(f.commands.filter(x => x === 'detach')).toHaveLength(external ? 0 : 1)
      f.capture.dispose(); await flush()
    }
  })

  test('clear, redirect reuse and dispose discard in-flight bodies; a replacement observer survives old cleanup', async () => {
    const f = fixture(); await f.capture.start()
    const wait = deferred()
    f.setHandler(async method => method === 'Network.getResponseBody' ? wait.promise : {})
    f.begin(); f.response(); f.finish(); await flush()
    f.emit('requestWillBeSent', { requestId: '1', timestamp: 4, type: 'Fetch', request: { url: 'https://next.test/', method: 'GET' }, redirectResponse: { status: 302 } })
    wait.resolve({ body: '{"late":true}' }); await flush()
    expect(f.capture.detail('1').responseBody.state).toBe('redirected')
    expect(f.capture.detail('2').responseBody.state).toBe('pending')
    f.capture.clear(); f.finish(); expect(f.capture.entries()).toEqual([])
    f.capture.dispose()
    const replacement = attachBrowserNetworkCapture(f.contents)
    await replacement.start(); await flush()
    expect(replacement.active).toBe(true)
    expect(f.commands).not.toContain('Network.disable')
    await replacement.stop(); replacement.dispose(); await flush()
  })

  test('binary/base64, malformed JSON, failed requests and stop failures are explicit sanitized states', async () => {
    const f = fixture(); await f.capture.start()
    for (const [index, result] of [{ body: 'opaqueSecret', base64Encoded: true }, { body: '{brokenSecret' }, { invalid: 'rawSecret' }].entries()) {
      f.begin(String(index)); f.response(String(index)); f.setHandler(async () => result); f.finish(String(index)); await flush()
    }
    expect(f.capture.entries().map(row => row.bodyState)).toEqual(['binary', 'unavailable', 'unavailable'])
    expect(JSON.stringify(f.capture.entries())).not.toContain('Secret')
    f.begin('failed'); f.emit('loadingFailed', { requestId: 'failed', timestamp: 2, errorText: 'Cookie=rawSecret' })
    expect(f.capture.entries().at(-1)?.bodyState).toBe('failed')
    f.setHandler(async () => { throw new Error('password=rawSecret') })
    await expect(f.capture.stop()).rejects.toThrow('Network capture could not stop')
    expect(f.commands.at(-1)).toBe('detach')
    expect(f.capture.error).not.toContain('rawSecret')
    f.capture.dispose(); await flush()
  })

  test('overlapping start/stop and disposed setup isolate late enable results; detach is explicit', async () => {
    const f = fixture(); const wait = deferred()
    f.setHandler(async method => method === 'Network.enable' ? wait.promise : {})
    const start = f.capture.start(); await flush()
    const stop = f.capture.stop(); wait.resolve({}); await start; await stop
    expect(f.capture.active).toBe(false)
    f.setHandler(async () => ({})); await f.capture.start()
    f.api.detach()
    expect(f.capture.active).toBe(false)
    expect(f.capture.error).toBe('Network capture debugger disconnected')
    f.capture.dispose(); await flush()
    await expect(f.capture.start()).rejects.toThrow('disposed')
  })
})
