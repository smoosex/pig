/** Browser panes are owned by their creating UI window, independently of Pi sessions. */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

async function fixture(): Promise<void> {
  const handlers = new Map<string, (...args: any[]) => any>()
  const calls: unknown[][] = []
  const clipboard: string[] = []
  const external: string[] = []
  const cookieCalls: unknown[][] = []
  const cookieContexts: (() => string)[] = []
  let pageUrl: string | undefined
  let createView!: () => unknown
  let viewOptions: any
  const makeWindow = () => Object.assign(new EventEmitter(), {
    webContents: Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false }), isDestroyed: () => false
  })
  const win = makeWindow()
  const other = makeWindow()
  const ui = win.webContents
  mock.module('electron', () => ({
    app: { isPackaged: false, getAppPath: () => process.cwd() },
    View: class {},
    session: { fromPartition: (partition: string) => {
      assert.equal(partition, 'persist:pig-browser')
      return { cookies: {} }
    } },
    clipboard: { writeText: (url: string) => { clipboard.push(url) } },
    shell: { openExternal: async (url: string) => { external.push(url) } },
    ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) },
    BrowserWindow: { fromWebContents: (sender: unknown) => sender === other.webContents ? other : win },
    WebContentsView: class { constructor(options: unknown) { viewOptions = options } }
  }))
  mock.module('../src/main/browser/favicon', () => ({ fetchFavicon: async () => null }))
  mock.module('../src/main/open-project-sessions', () => ({ saveBrowserTabUrl: async () => {} }))
  mock.module('../src/main/browser/host', () => ({
    BrowserHost: class {
      constructor(factory: () => unknown) { createView = factory }
      retainUrl(_win: unknown, id: string, url: string) { calls.push(['retain', id, url]) }
      getState(_win: unknown, id: string) { calls.push(['state', id]); return { browserId: id, ...(pageUrl !== undefined ? { url: pageUrl } : {}) } }
      inspect(_win: unknown, id: string) { calls.push(['inspect', id]) }
      allowCertificate(_win: unknown, id: string, fingerprint: unknown) { calls.push(['allowCertificate', id, fingerprint]) }
      setBounds(_win: unknown, id: string, bounds: unknown) { calls.push(['bounds', id, bounds]) }
      close(_win: unknown, id: string) { calls.push(['close', id]) }
      closeWindow(win: unknown) { calls.push(['closeWindow', win]) }
    }
  }))
  mock.module('../src/main/browser/cookies/importer', () => ({ BrowserCookieImporter: class {
    list(context: () => string) { cookieCalls.push(['list', context()]); cookieContexts.push(context) }
    preview(context: () => string, sourceId: string, scope: string) { cookieCalls.push(['preview', context(), sourceId, scope]) }
    import(context: () => string, sourceId: string, scope: string, expectedSite: string | null) { cookieCalls.push(['import', context(), sourceId, scope, expectedSite]) }
    clear(context: () => string, expectedSite: string) { cookieCalls.push(['clear', context(), expectedSite]) }
  } }))
  const { registerBrowserIpc } = await import('../src/main/ipc/browser')
  registerBrowserIpc()
  createView()
  assert.ok(viewOptions.webPreferences.preload.endsWith('/preload/browser-guest.cjs'))
  assert.equal(viewOptions.webPreferences.sandbox, true)
  assert.equal(viewOptions.webPreferences.nodeIntegration, false)
  assert.equal(viewOptions.webPreferences.contextIsolation, true)
  assert.equal(viewOptions.webPreferences.webSecurity, true)
  const get = handlers.get('browser:get-state')!
  const create = handlers.get('browser:create')!
  const event = { sender: ui, senderFrame: ui.mainFrame }
  const foreign = { sender: other.webContents, senderFrame: other.webContents.mainFrame }
  assert.throws(() => get(event, 'browser:owned'), /does not belong/)
  assert.deepEqual(create(event, 'browser:owned'), { browserId: 'browser:owned' })
  assert.deepEqual(get(event, 'browser:owned'), { browserId: 'browser:owned' })
  assert.throws(() => create({ sender: {}, senderFrame: ui.mainFrame }, 'browser:owned'), /UI main frame/)
  assert.throws(() => get({ sender: ui, senderFrame: {} }, 'browser:owned'), /UI main frame/)
  assert.throws(() => create(foreign, 'browser:owned'), /another window/)
  assert.throws(() => get(foreign, 'browser:owned'), /does not belong/)
  assert.throws(() => create(event, 'session-id'), /Invalid browser/)
  handlers.get('browser:set-bounds')!(event, 'browser:owned', null)
  handlers.get('browser:close')!(event, 'browser:owned')
  handlers.get('browser:set-bounds')!(event, 'browser:owned', null)
  assert.throws(() => get(event, 'browser:owned'), /does not belong/)
  assert.throws(() => handlers.get('browser:set-bounds')!(event, 'browser:owned', { x: 0, y: 0, width: 100, height: 100 }), /does not belong/)
  assert.deepEqual(calls, [
    ['state', 'browser:owned'], ['state', 'browser:owned'], ['bounds', 'browser:owned', null],
    ['close', 'browser:owned'], ['bounds', 'browser:owned', null]
  ])
  // A restored tab hands its saved page back through create, under the same rule as navigation.
  create(event, 'browser:restored', 'example.test/saved')
  assert.deepEqual(calls.at(-2), ['retain', 'browser:restored', 'https://example.test/saved'])
  assert.throws(() => create(event, 'browser:restored-bad', 'file:///etc/passwd'), /Only HTTP/)
  pageUrl = 'https://example.test/current-page'
  create(event, 'browser:owned')
  handlers.get('browser:copy-url')!(event, 'browser:owned')
  await handlers.get('browser:open-external')!(event, 'browser:owned', 'javascript:ignored-input')
  handlers.get('browser:inspect')!(event, 'browser:owned')
  assert.deepEqual(clipboard, [pageUrl])
  assert.deepEqual(external, [pageUrl], 'only the committed HTTP(S) URL can leave Pig')
  assert.deepEqual(calls.at(-1), ['inspect', 'browser:owned'])
  handlers.get('browser:allow-certificate')!(event, 'browser:owned', 'sha256/A')
  assert.deepEqual(calls.at(-1), ['allowCertificate', 'browser:owned', 'sha256/A'])
  assert.throws(() => handlers.get('browser:allow-certificate')!(foreign, 'browser:owned', 'sha256/A'), /does not belong/)
  assert.throws(() => handlers.get('browser:open-external')!(foreign, 'browser:owned'), /does not belong/)
  for (const invalid of ['', 'file:///tmp/a', 'javascript:alert(1)', 'https://a:b@example.test']) {
    pageUrl = invalid
    assert.throws(() => handlers.get('browser:open-external')!(event, 'browser:owned'), /No HTTP/)
    assert.throws(() => handlers.get('browser:copy-url')!(event, 'browser:owned'), /No HTTP/)
  }
  assert.equal(external.length, 1)
  pageUrl = 'https://example.test/current-page'
  handlers.get('browser:list-cookie-sources')!(event, 'browser:owned')
  handlers.get('browser:preview-cookies')!(event, 'browser:owned', 'chrome:profile', 'site')
  handlers.get('browser:import-cookies')!(event, 'browser:owned', 'chrome:profile', 'all', null)
  handlers.get('browser:clear-site-cookies')!(event, 'browser:owned', 'example.test')
  assert.deepEqual(cookieCalls, [
    ['list', pageUrl], ['preview', pageUrl, 'chrome:profile', 'site'],
    ['import', pageUrl, 'chrome:profile', 'all', null], ['clear', pageUrl, 'example.test']
  ])
  for (const channel of ['browser:list-cookie-sources', 'browser:preview-cookies', 'browser:import-cookies', 'browser:clear-site-cookies']) {
    assert.throws(() => handlers.get(channel)!(foreign, 'browser:owned'), /does not belong/)
    assert.throws(() => handlers.get(channel)!({ sender: ui, senderFrame: {} }, 'browser:owned'), /UI main frame/)
  }

  create(foreign, 'browser:foreign')
  ui.emit('did-start-navigation', {}, 'https://ui.test/frame', false, false)
  ui.emit('did-start-navigation', {}, 'https://ui.test/#hash', true, true)
  assert.equal(get(event, 'browser:owned').browserId, 'browser:owned', 'subframe and same-document navigation keep panes')
  assert.equal(calls.filter(([kind]) => kind === 'closeWindow').length, 0)
  ui.emit('did-start-navigation', {}, 'https://ui.test/', false, true)
  assert.deepEqual(calls.at(-1), ['closeWindow', win])
  assert.throws(() => create(event, 'browser:late'), /reloading/, 'old UI cannot recreate views during reload')
  assert.throws(() => get(event, 'browser:owned'), /reloading/)
  assert.equal(get(foreign, 'browser:foreign').browserId, 'browser:foreign', 'another window is untouched')
  ui.emit('dom-ready')
  assert.throws(() => get(event, 'browser:owned'), /does not belong/, 'old registrations are gone after reload')
  assert.throws(() => cookieContexts[0]!(), /does not belong/, 'late cookie IO loses authorization after UI reload')
  assert.throws(() => handlers.get('browser:set-bounds')!(event, 'browser:owned', { x: 0, y: 0, width: 100, height: 100 }), /does not belong/)
  pageUrl = undefined
  assert.deepEqual(create(event, 'browser:fresh'), { browserId: 'browser:fresh' })
  assert.equal(ui.listenerCount('did-start-navigation'), 1, 'repeated UI documents do not accumulate lifecycle listeners')
  ui.emit('render-process-gone', {}, { reason: 'crashed' })
  assert.deepEqual(calls.at(-1), ['closeWindow', win])
  assert.throws(() => create(event, 'browser:late'), /reloading/)
  ui.emit('dom-ready')
  assert.throws(() => get(event, 'browser:fresh'), /does not belong/)
  create(event, 'browser:recovered')
  win.emit('closed')
  assert.deepEqual(calls.at(-1), ['closeWindow', win])
  assert.throws(() => get(event, 'browser:recovered'), /does not belong/)
}

if (process.argv.includes('--browser-ipc-fixture')) await fixture()
else test('browser IPC validates independent pane ownership, sandboxing and late cleanup', async () => {
  const child = Bun.spawn([process.execPath, import.meta.path, '--browser-ipc-fixture'], { stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => child.kill(), 10_000)
  try {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    assert.equal(code, 0, err || out)
  } finally { clearTimeout(timer) }
})
