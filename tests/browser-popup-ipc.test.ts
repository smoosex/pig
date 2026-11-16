/** Popup adoption preserves the source window/scope and cannot outlive pending UI ownership. */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { runSelf } from './helpers/subprocess.ts'
import type { BrowserPopupRequest } from '../src/shared/browser'

async function fixture(): Promise<void> {
  const handlers = new Map<string, (...args: any[]) => any>()
  const calls: unknown[][] = []
  let onSend: ((channel: string, request: BrowserPopupRequest) => void) | undefined
  const makeWindow = () => {
    const sent: [string, BrowserPopupRequest][] = []
    return Object.assign(new EventEmitter(), {
      sent,
      webContents: Object.assign(new EventEmitter(), {
        mainFrame: {},
        isDestroyed: () => false,
        send: (channel: string, request: BrowserPopupRequest) => {
          sent.push([channel, request])
          onSend?.(channel, request)
        }
      }),
      isDestroyed: () => false
    })
  }
  const win = makeWindow()
  const other = makeWindow()
  type Window = ReturnType<typeof makeWindow>
  let popup!: (win: Window, sourceId: string, browserId: string, background: boolean) => void
  let closeNative!: (win: Window, id: string) => void
  const state = (id: string) => ({ browserId: id, url: '', title: '' })
  mock.module('electron', () => ({
    app: { isPackaged: false, getAppPath: () => process.cwd() },
    View: class {},
    WebContentsView: class {},
    session: { fromPartition: () => ({ cookies: {} }) },
    clipboard: { writeText: () => {} },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) },
    BrowserWindow: { fromWebContents: (sender: unknown) => sender === win.webContents ? win : sender === other.webContents ? other : undefined }
  }))
  mock.module('../src/main/browser/favicon', () => ({ fetchFavicon: async () => null }))
  mock.module('../src/main/open-project-sessions', () => ({ saveBrowserTabUrl: async () => {}, forgetBrowserTabUrl: async () => {} }))
  mock.module('../src/main/browser/host', () => ({
    BrowserHost: class {
      constructor(factory: () => unknown, _live: unknown, _container: unknown, _save: unknown, _visits: unknown, options: { opened: typeof popup; closed: typeof closeNative; webPreferences: Record<string, unknown> }) {
        popup = options.opened
        closeNative = options.closed
        assert.equal(options.webPreferences.sandbox, true)
        assert.equal(options.webPreferences.contextIsolation, true)
        assert.equal(options.webPreferences.nodeIntegration, false)
        assert.equal(options.webPreferences.partition, 'persist:pig-browser')
        factory()
      }
      getState(_win: unknown, id: string) { return state(id) }
      acceptPopup(win: unknown, id: string) { calls.push(['accept', win, id]); return state(id) }
      close(win: unknown, id: string) { calls.push(['close', win, id]) }
      closeWindow(win: unknown) { calls.push(['closeWindow', win]) }
    }
  }))
  const { registerBrowserIpc } = await import('../src/main/ipc/browser')
  registerBrowserIpc()
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
  const foreign = { sender: other.webContents, senderFrame: other.webContents.mainFrame }
  const subframe = { sender: win.webContents, senderFrame: {} }
  const create = handlers.get('browser:create')!
  const get = handlers.get('browser:get-state')!
  const accept = handlers.get('browser:accept-popup')!
  const close = handlers.get('browser:close')!
  const accepts = () => calls.filter(([kind]) => kind === 'accept')
  const closed = (id: string) => calls.filter(([kind, , browserId]) => kind === 'close' && browserId === id).length

  create(event, 'browser:source', '/repo')
  create(event, 'browser:wrong-source', '/repo')
  create(foreign, 'browser:foreign-source', '/other')
  onSend = (channel, request) => {
    assert.equal(channel, 'browser:popup-request')
    assert.deepEqual(get(event, request.browserId), state(request.browserId), 'ownership is registered before sending to UI')
    assert.throws(() => create(event, request.browserId, '/other'), /another worktree scope/, 'scope is inherited before UI can create the tab')
  }
  popup(win, 'browser:source', 'browser:accepted', true)
  onSend = undefined
  assert.deepEqual(win.sent, [['browser:popup-request', {
    browserId: 'browser:accepted', sourceBrowserId: 'browser:source', background: true
  }]])
  assert.deepEqual(other.sent, [], 'only the source window receives the popup')
  assert.throws(() => get(foreign, 'browser:accepted'), /does not belong/)
  assert.throws(() => create(foreign, 'browser:accepted', '/repo'), /another window/)
  assert.throws(() => accept(foreign, 'browser:accepted', 'browser:source'), /does not belong/)
  assert.throws(() => accept(subframe, 'browser:accepted', 'browser:source'), /UI main frame/)
  for (const source of ['browser:wrong-source', 'browser:foreign-source', 'browser:missing']) {
    assert.throws(() => accept(event, 'browser:accepted', source), /no longer available/)
  }
  assert.equal(accepts().length, 0, 'invalid replies never reach the host')
  assert.deepEqual(accept(event, 'browser:accepted', 'browser:source'), state('browser:accepted'), 'invalid replies do not consume pending adoption')
  assert.deepEqual(accepts(), [['accept', win, 'browser:accepted']])
  assert.throws(() => accept(event, 'browser:accepted', 'browser:source'), /no longer available/, 'acceptance is single-use')
  assert.equal(accepts().length, 1)
  assert.throws(() => create(event, 'browser:accepted', '/other'), /another worktree scope/)

  popup(win, 'browser:source', 'browser:pending', false)
  assert.deepEqual(win.sent.at(-1), ['browser:popup-request', {
    browserId: 'browser:pending', sourceBrowserId: 'browser:source', background: false
  }])
  popup(other, 'browser:foreign-source', 'browser:foreign-popup', false)
  assert.deepEqual(other.sent.at(-1), ['browser:popup-request', {
    browserId: 'browser:foreign-popup', sourceBrowserId: 'browser:foreign-source', background: false
  }])
  close(event, 'browser:source')
  assert.equal(closed('browser:pending'), 1, 'closing the source discards its pending popup')
  assert.throws(() => accept(event, 'browser:pending', 'browser:source'), /does not belong/)
  assert.throws(() => get(event, 'browser:pending'), /does not belong/)
  assert.equal(closed('browser:accepted'), 0, 'source closure does not discard an adopted popup')
  assert.deepEqual(get(event, 'browser:accepted'), state('browser:accepted'))
  closeNative(win, 'browser:accepted')
  assert.throws(() => get(event, 'browser:accepted'), /does not belong/, 'window.close removes main ownership, not only its native view')
  assert.deepEqual(win.sent.at(-1), ['browser:close-tab-requested', 'browser:accepted'])
  assert.throws(() => popup(win, 'browser:source', 'browser:late', false), /source is no longer available/)
  assert.throws(() => get(event, 'browser:late'), /does not belong/)

  for (const lifecycle of ['reload', 'gone', 'closed'] as const) {
    const sourceId = `browser:source-${lifecycle}`
    const popupId = `browser:popup-${lifecycle}`
    create(event, sourceId, '/repo')
    popup(win, sourceId, popupId, false)
    const before = calls.length
    if (lifecycle === 'reload') win.webContents.emit('did-start-navigation', {}, 'https://ui.test/', false, true)
    else if (lifecycle === 'gone') win.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    else win.emit('closed')
    assert.ok(calls.slice(before).some(([kind, owner]) => kind === 'closeWindow' && owner === win), `${lifecycle} cleans up the host`)
    assert.equal(closed(popupId), 1, `${lifecycle} discards pending popups`)
    assert.throws(() => accept(event, popupId, sourceId), /reloading|does not belong/, `${lifecycle} rejects a late adoption`)
    if (lifecycle !== 'closed') {
      win.webContents.emit('dom-ready')
      assert.throws(() => accept(event, popupId, sourceId), /does not belong/, 'a new UI document cannot adopt an old popup')
    }
    assert.deepEqual(get(foreign, 'browser:foreign-popup'), state('browser:foreign-popup'), 'another window keeps its pending popup')
  }
  assert.deepEqual(accept(foreign, 'browser:foreign-popup', 'browser:foreign-source'), state('browser:foreign-popup'))
  assert.deepEqual(accepts(), [['accept', win, 'browser:accepted'], ['accept', other, 'browser:foreign-popup']])
  other.emit('closed')
}

if (process.argv.includes('--browser-popup-ipc-fixture')) await fixture()
else test('popup IPC enforces window/scope ownership, single adoption and teardown cleanup', async () => {
  const { exitCode: code, stdout: out, stderr: err } = await runSelf(import.meta.path, ['--browser-popup-ipc-fixture'], { timeoutMs: 10_000 })
  assert.equal(code, 0, err || out)
})
