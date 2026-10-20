/** Browser panes are owned by their creating UI window, independently of Pi sessions. */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

async function fixture(): Promise<void> {
  const handlers = new Map<string, (...args: any[]) => any>()
  const calls: unknown[][] = []
  const clipboard: string[] = []
  const external: string[] = []
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
    clipboard: { writeText: (url: string) => { clipboard.push(url) } },
    shell: { openExternal: async (url: string) => { external.push(url) } },
    ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) },
    BrowserWindow: { fromWebContents: (sender: unknown) => sender === other.webContents ? other : win },
    WebContentsView: class { constructor(options: unknown) { viewOptions = options } }
  }))
  mock.module('../src/main/browser/host', () => ({
    BrowserHost: class {
      constructor(factory: () => unknown) { createView = factory }
      getState(_win: unknown, id: string) { calls.push(['state', id]); return { browserId: id, ...(pageUrl !== undefined ? { url: pageUrl } : {}) } }
      inspect(_win: unknown, id: string) { calls.push(['inspect', id]) }
      setBounds(_win: unknown, id: string, bounds: unknown) { calls.push(['bounds', id, bounds]) }
      close(_win: unknown, id: string) { calls.push(['close', id]) }
      closeWindow(win: unknown) { calls.push(['closeWindow', win]) }
    }
  }))
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
  pageUrl = 'https://example.test/current-page'
  create(event, 'browser:owned')
  handlers.get('browser:copy-url')!(event, 'browser:owned')
  await handlers.get('browser:open-external')!(event, 'browser:owned', 'javascript:ignored-input')
  handlers.get('browser:inspect')!(event, 'browser:owned')
  assert.deepEqual(clipboard, [pageUrl])
  assert.deepEqual(external, [pageUrl], 'only the committed HTTP(S) URL can leave Pig')
  assert.deepEqual(calls.at(-1), ['inspect', 'browser:owned'])
  assert.throws(() => handlers.get('browser:open-external')!(foreign, 'browser:owned'), /does not belong/)
  for (const invalid of ['', 'file:///tmp/a', 'javascript:alert(1)', 'https://a:b@example.test']) {
    pageUrl = invalid
    assert.throws(() => handlers.get('browser:open-external')!(event, 'browser:owned'), /No HTTP/)
    assert.throws(() => handlers.get('browser:copy-url')!(event, 'browser:owned'), /No HTTP/)
  }
  assert.equal(external.length, 1)

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
