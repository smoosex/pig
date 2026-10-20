import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { BrowserWindow, WebContentsView, IpcMainInvokeEvent } from 'electron'
import { BrowserHost } from '../src/main/browser/host'
import { assertBrowserSender, browserDipBounds, isBrowserElement, normalizeBrowserUrl } from '../src/main/browser/validation'
import { BROWSER_CLOSE_TAB_CHANNEL, BROWSER_MARKER_REMOVE_CHANNEL, BROWSER_MARKER_UPDATE_CHANNEL, BROWSER_SELECTION_CHANNEL } from '../src/shared/browser'

class FakeContents extends EventEmitter {
  dead = false
  url = ''
  loading = false
  mainFrame = {}
  sent: Array<[string, unknown]> = []
  devTools: unknown[] = []
  session = Object.assign(new EventEmitter(), {
    setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {}, setDevicePermissionHandler: () => {}
  })
  navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack: () => {}, goForward: () => {} }
  isDestroyed() { return this.dead }
  getZoomFactor() { return 1.5 }
  getURL() { return this.url }
  isLoading() { return this.loading }
  setWindowOpenHandler() {}
  openDevTools(options: unknown) { this.devTools.push(options); this.devToolsOpen = true }
  devToolsHost: unknown = null
  devToolsOpen = false
  setDevToolsWebContents(contents: unknown) { this.devToolsHost = contents }
  isDevToolsOpened() { return this.devToolsOpen }
  closeDevTools() { this.devToolsOpen = false; this.emit('devtools-closed') }
  send(channel: string, payload: unknown) { this.sent.push([channel, payload]) }
  close() { this.dead = true; this.emit('destroyed') }
  async loadURL(url: string) {
    this.emit('did-start-navigation', {}, url, false, true)
    this.url = url
    this.emit('did-navigate', {}, url)
  }
  async capturePage() { return { isEmpty: () => false, toPNG: () => Buffer.from('png'), toJPEG: () => Buffer.from('jpg') } }
  debuggerAttached = false
  debuggerCommands: unknown[] = []
  debugger = {
    isAttached: () => this.debuggerAttached,
    attach: () => { this.debuggerAttached = true },
    detach: () => { this.debuggerAttached = false },
    sendCommand: async (method: string, params: unknown) => {
      this.debuggerCommands.push([method, params])
      return { data: Buffer.from('png').toString('base64') }
    }
  }
  throttling = true
  setBackgroundThrottling(value: boolean) { this.throttling = value }
  evaluated: Array<[number, string]> = []
  evaluation: () => Promise<unknown> = async () => 'result'
  executeJavaScriptInIsolatedWorld(world: number, scripts: Array<{ code: string }>) {
    this.evaluated.push([world, scripts[0]!.code])
    return this.evaluation().then(value => ({ ok: true, value }))
  }
}
class FakeView {
  webContents = new FakeContents()
  visible = false
  bounds: unknown
  setVisible(value: boolean) { this.visible = value }
  getVisible() { return this.visible }
  setBounds(value: unknown) { this.bounds = value }
}
function fixture(live: (sessionId: string) => boolean = () => true) {
  const views: FakeView[] = []
  const removed: unknown[] = []
  const win = Object.assign(new EventEmitter(), {
    webContents: new FakeContents(), dead: false,
    isDestroyed() { return this.dead },
    getContentSize: () => [600, 400],
    contentView: { addChildView: () => {}, removeChildView: (view: unknown) => { removed.push(view) } }
  })
  const host = new BrowserHost(() => {
    const view = new FakeView()
    views.push(view)
    return view as unknown as WebContentsView
  }, live)
  return { host, win, owner: win as unknown as BrowserWindow, views, removed }
}
const bounds = { x: 10, y: 20, width: 300, height: 200 }
const element = { selector: '#x', tagName: 'button', role: 'button', name: 'X', text: 'X', bounds, styles: {} }

describe('browser host', () => {
  test('control IPC rejects guests and subframes', () => {
    const { owner, win } = fixture()
    const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame } as unknown as IpcMainInvokeEvent
    expect(() => assertBrowserSender(event, owner)).not.toThrow()
    expect(() => assertBrowserSender({ ...event, senderFrame: {} } as IpcMainInvokeEvent, owner)).toThrow()
    expect(() => assertBrowserSender({ ...event, sender: new FakeContents() } as unknown as IpcMainInvokeEvent, owner)).toThrow()
    win.dead = true
    expect(() => assertBrowserSender(event, owner)).toThrow()
  })

  test('Cmd+W in the page or docked DevTools cancels window closing and requests its owning tab', async () => {
    const { host, owner, win, views } = fixture()
    host.setBounds(owner, 'browser:owned', bounds)
    await host.navigate(owner, 'browser:owned', 'https://example.test')
    host.inspect(owner, 'browser:owned')
    const input = { type: 'keyDown', key: 'w', meta: true, control: false, alt: false, shift: false, isAutoRepeat: false }
    const requested = () => win.webContents.sent.filter(([channel]) => channel === BROWSER_CLOSE_TAB_CHANNEL)
    const press = (contents: FakeContents, overrides: Partial<typeof input> = {}) => {
      let prevented = false
      contents.emit('before-input-event', { preventDefault() { prevented = true } }, { ...input, ...overrides })
      return prevented
    }
    for (const view of views) {
      expect(press(view.webContents)).toBe(true)
      const count = requested().length
      expect(press(view.webContents, { isAutoRepeat: true })).toBe(true)
      expect(requested()).toHaveLength(count)
      for (const other of [
        { type: 'keyUp' }, { shift: true }, { alt: true }, { control: true },
        { meta: false }, { key: 'r' }, { meta: false, control: true }
      ]) expect(press(view.webContents, other)).toBe(false)
      expect(requested()).toHaveLength(count)
    }
    expect(requested()).toEqual([
      [BROWSER_CLOSE_TAB_CHANNEL, 'browser:owned'], [BROWSER_CLOSE_TAB_CHANNEL, 'browser:owned']
    ])
    host.inspect(owner, 'browser:owned')
    expect(press(views[1].webContents)).toBe(false)
    host.closeWindow(owner)
    expect(press(views[0].webContents)).toBe(false)
    expect(requested()).toHaveLength(2)
  })

  test('URL and guest input validation, zoom and clipping', () => {
    expect(normalizeBrowserUrl('localhost:3000/a')).toBe('http://localhost:3000/a')
    expect(normalizeBrowserUrl('example.com')).toBe('https://example.com/')
    expect(normalizeBrowserUrl('example.com:8080/a')).toBe('https://example.com:8080/a')
    expect(normalizeBrowserUrl('https://example.com')).toBe('https://example.com/')
    for (const value of ['file:///tmp/a', 'javascript:alert(1)', 'https://a:b@example.com', 'data:text/html,x']) {
      expect(() => normalizeBrowserUrl(value)).toThrow()
    }
    expect(browserDipBounds({ x: -10, y: 10, width: 1000, height: 20 }, 2, 600, 400)).toEqual({ x: 0, y: 20, width: 600, height: 40 })
    expect(isBrowserElement(element)).toBe(true)
    expect(isBrowserElement({ ...element, bounds: { ...bounds, x: NaN } })).toBe(false)
  })

  test('null bounds never create; hidden LRU eviction and window cleanup', () => {
    const { host, owner, win, views } = fixture()
    host.setBounds(owner, 'absent', null)
    host.getState(owner, 'absent')
    expect(views).toHaveLength(0)
    for (const id of ['a', 'b', 'c', 'd']) {
      host.setBounds(owner, id, bounds)
      if (id !== 'd') host.setBounds(owner, id, null)
    }
    expect(views.filter(v => v.visible)).toHaveLength(1)
    expect(views[3].bounds).toEqual({ x: 15, y: 30, width: 450, height: 300 })
    host.setBounds(owner, 'e', bounds)
    expect(views[0].webContents.dead).toBe(true)
    expect(views.filter(v => v.visible && !v.webContents.dead)).toHaveLength(2)
    win.dead = true
    win.emit('closed')
    expect(views.every(v => v.webContents.dead)).toBe(true)
    expect(() => host.getState(owner, 'e')).toThrow()
  })

  test('window reset disposes visible and cached pages, DevTools and in-flight captures without retaining UI state', async () => {
    const { host, owner, win, views, removed } = fixture()
    host.setBounds(owner, 'a', bounds)
    await host.navigate(owner, 'a', 'https://example.test/a')
    host.setSelecting(owner, 'a', true)
    const wc = views[0].webContents
    wc.emit('ipc-message', { sender: wc, senderFrame: wc.mainFrame }, BROWSER_SELECTION_CHANNEL, {
      documentId: host.getState(owner, 'a').documentId, element, comment: 'old document'
    })
    expect(host.getState(owner, 'a').annotations).toHaveLength(1)
    host.inspect(owner, 'a')
    host.setBounds(owner, 'cached', bounds)
    await host.navigate(owner, 'cached', 'https://example.test/cached')
    host.setBounds(owner, 'cached', null)
    const image = await wc.capturePage()
    let finish!: (value: typeof image) => void
    const waiting = new Promise<typeof image>(resolve => { finish = resolve })
    wc.capturePage = () => waiting
    const capture = host.capture(owner, 'a')
    const snapshot = host.snapshot(owner, 'a')
    const pushes = win.webContents.sent.length
    host.closeWindow(owner)
    expect(views).toHaveLength(3)
    expect(views.every(view => view.webContents.dead)).toBe(true)
    expect(removed).toHaveLength(3)
    expect(win.webContents.sent).toHaveLength(pushes)
    host.closeWindow(owner)
    expect(removed).toHaveLength(3)
    finish(image)
    await expect(capture).rejects.toThrow('Browser page changed during capture')
    expect(await snapshot).toBeNull()
    for (const id of ['a', 'cached']) {
      expect(host.getState(owner, id)).toMatchObject({ url: '', documentId: '', annotations: [], devtools: false })
    }
    host.setBounds(owner, 'fresh', bounds)
    await host.navigate(owner, 'fresh', 'https://example.test/new')
    const fresh = views.at(-1)!
    expect(fresh.visible).toBe(true)
    expect(fresh.webContents.dead).toBe(false)
    expect(win.listenerCount('resize')).toBe(1)
    expect(win.listenerCount('closed')).toBe(1)
    fresh.bounds = undefined
    win.emit('resize')
    expect(fresh.bounds).toEqual({ x: 15, y: 30, width: 450, height: 300 })
    win.emit('closed')
    expect(fresh.webContents.dead).toBe(true)
  })

  test('only current-document main-frame selections accepted; navigation cancels picking', async () => {
    const { host, owner, win, views } = fixture()
    host.setBounds(owner, 'a', bounds)
    await host.navigate(owner, 'a', 'localhost:3000')
    host.setSelecting(owner, 'a', true)
    const wc = views[0].webContents
    const documentId = host.getState(owner, 'a').documentId
    const send = (frame: unknown, token: string) => wc.emit('ipc-message', { sender: wc, senderFrame: frame }, BROWSER_SELECTION_CHANNEL, { documentId: token, element, comment: '' })
    send({}, documentId)
    send(wc.mainFrame, 'stale')
    expect(win.webContents.sent.filter(([c]) => c === 'browser:selection')).toHaveLength(0)
    send(wc.mainFrame, documentId)
    expect(host.getState(owner, 'a').selecting).toBe(true)
    const selections = win.webContents.sent.filter(([c]) => c === 'browser:selection')
    expect(selections).toHaveLength(1)
    expect(selections[0][1]).toMatchObject({ browserId: 'a', url: 'http://localhost:3000/', documentId, element })
    host.setSelecting(owner, 'a', true)
    await host.navigate(owner, 'a', 'https://example.com')
    expect(host.getState(owner, 'a').documentId).not.toBe(documentId)
    expect(host.getState(owner, 'a').selecting).toBe(false)
    expect(wc.sent.at(-1)).toEqual(['browser:picker', expect.objectContaining({ active: false, documentId })])
    let prevented = false
    wc.emit('will-frame-navigate', { url: 'file:///tmp/a', preventDefault() { prevented = true } })
    expect(prevented).toBe(true)
  })

  test('multiple markers commit continuously, survive native eviction and remove only selected ids', async () => {
    const { host, owner, views } = fixture()
    await host.navigate(owner, 'a', 'localhost:3000')
    host.setBounds(owner, 'a', bounds)
    host.setSelecting(owner, 'a', true)
    const wc = views[0].webContents
    const documentId = host.getState(owner, 'a').documentId
    const commit = (comment: string) => wc.emit('ipc-message', { sender: wc, senderFrame: wc.mainFrame }, BROWSER_SELECTION_CHANNEL, { documentId, element, comment })
    commit('Fix alignment')
    const first = host.getState(owner, 'a').annotations[0]
    commit('')
    expect(host.getState(owner, 'a').annotations.map(item => item.ordinal)).toEqual([1, 2])
    expect(host.getState(owner, 'a').selecting).toBe(true)
    host.removeAnnotations(owner, 'a', [first.id])
    expect(host.getState(owner, 'a').annotations.map(item => item.ordinal)).toEqual([2])
    host.setSelecting(owner, 'a', false)
    const second = host.getState(owner, 'a').annotations[0]
    const update = (payload: object) => wc.emit('ipc-message', { sender: wc, senderFrame: wc.mainFrame }, BROWSER_MARKER_UPDATE_CHANNEL, payload)
    update({ documentId: 'stale', id: second.id, comment: 'stale' })
    update({ documentId, id: second.id, comment: 'x'.repeat(4001) })
    expect(host.getState(owner, 'a').annotations[0].comment).toBe('')
    update({ documentId, id: second.id, comment: '  Updated  ' })
    expect(host.getState(owner, 'a').annotations[0]).toEqual({ ...second, comment: 'Updated' })
    wc.emit('ipc-message', { sender: wc, senderFrame: wc.mainFrame }, BROWSER_MARKER_REMOVE_CHANNEL, { documentId: 'stale', id: second.id })
    expect(host.getState(owner, 'a').annotations).toHaveLength(1)
    wc.emit('ipc-message', { sender: wc, senderFrame: wc.mainFrame }, BROWSER_MARKER_REMOVE_CHANNEL, { documentId, id: second.id })
    expect(host.getState(owner, 'a').annotations).toHaveLength(0)
    host.setSelecting(owner, 'a', true)
    commit('Preserve this note')
    host.setBounds(owner, 'a', null)
    for (const id of ['b', 'c', 'd', 'e']) host.setBounds(owner, id, bounds)
    expect(wc.dead).toBe(true)
    const pending = host.getState(owner, 'a').annotations
    expect(pending).toHaveLength(1)
    expect(pending[0].comment).toBe('Preserve this note')
    host.removeAnnotations(owner, 'a', [pending[0].id])
    expect(host.getState(owner, 'a').annotations).toHaveLength(0)
  })

  test('evicted tabs retain their URL and reload only when visible again', async () => {
    const { host, owner, views } = fixture()
    await host.navigate(owner, 'a', 'https://example.com/a')
    const originalDocument = host.getState(owner, 'a').documentId
    const restoredUrl = 'https://example.com/a#section'
    views[0].webContents.emit('did-navigate-in-page', {}, restoredUrl, true)
    for (const id of ['b', 'c', 'd', 'e']) {
      await host.navigate(owner, id, `https://example.com/${id}`)
    }
    expect(views[0].webContents.dead).toBe(true)
    expect(host.getState(owner, 'a').url).toBe(restoredUrl)
    host.setBounds(owner, 'a', null)
    expect(views, 'hiding and reading an evicted tab cannot recreate it').toHaveLength(5)
    host.setBounds(owner, 'a', bounds)
    expect(views).toHaveLength(6)
    expect(views[5].webContents.getURL()).toBe(restoredUrl)
    expect(views[5].visible).toBe(true)
    expect(host.getState(owner, 'a').documentId).not.toBe(originalDocument)
    expect(host.getState(owner, 'a').url).toBe(restoredUrl)
    host.close(owner, 'a')
    expect(host.getState(owner, 'a').url).toBe('')
  })

  test('independent browser panes can remain visible together and close independently', () => {
    const { host, owner, win, views } = fixture()
    host.setBounds(owner, 'a', bounds)
    host.setBounds(owner, 'b', bounds)
    expect(views.filter(view => view.visible)).toHaveLength(2)
    views[0].webContents.emit('focus')
    expect(win.webContents.sent.at(-1)).toEqual(['browser:state', expect.objectContaining({ browserId: 'a', focused: true })])
    host.close(owner, 'a')
    expect(views[0].webContents.dead).toBe(true)
    expect(views[1].webContents.dead).toBe(false)
    expect(host.getState(owner, 'a').url).toBe('')
  })

  test('inspect docks the page DevTools below it in the same pane and toggles them off', async () => {
    const { host, owner, views } = fixture()
    expect(() => host.inspect(owner, 'a')).toThrow()
    await host.navigate(owner, 'a', 'localhost:3000')
    host.setBounds(owner, 'a', bounds)
    host.inspect(owner, 'a')
    const [page, tools] = views
    expect(page.webContents.devToolsHost).toBe(tools.webContents)
    expect(page.webContents.devTools, 'docked mode keeps the DevTools close button').toEqual([{ mode: 'bottom', activate: false }])
    expect(host.getState(owner, 'a').devtools).toBe(true)
    const pageBox = page.bounds as { y: number; height: number }
    const toolsBox = tools.bounds as { y: number; height: number }
    expect(pageBox.y + pageBox.height).toBe(toolsBox.y)
    expect(tools.visible).toBe(true)
    host.setBounds(owner, 'a', null)
    expect(tools.visible).toBe(false)
    host.setBounds(owner, 'a', bounds)
    tools.webContents.close()
    expect(() => { (tools as { webContents?: unknown }).webContents = undefined; page.webContents.emit('devtools-closed') }, 'Electron drops webContents after destruction').not.toThrow()
    expect(host.getState(owner, 'a').devtools, 'the DevTools close button destroys their WebContents').toBe(false)
    host.inspect(owner, 'a')
    page.webContents.closeDevTools()
    expect(views[2].webContents.dead, 'closing from DevTools releases the docked view').toBe(true)
    expect(host.getState(owner, 'a').devtools).toBe(false)
    expect((page.bounds as { height: number }).height).toBeGreaterThan(pageBox.height)
    host.inspect(owner, 'a')
    host.inspect(owner, 'a')
    expect(views[3].webContents.dead).toBe(true)
    expect(page.webContents.isDevToolsOpened()).toBe(false)
  })

  test('agent control keeps hidden pages sized, unthrottled and pinned while the session lives', async () => {
    const live = new Set(['session-1'])
    const { host, owner, win, views } = fixture((id) => live.has(id))
    host.setAgent(owner, 'browser:agent', 'session-1')
    const agentView = views[0]!
    expect(agentView.bounds).toEqual({ x: 0, y: 0, width: 1280, height: 800 })
    expect(agentView.visible).toBe(false)
    expect(agentView.webContents.throttling).toBe(false)
    expect(host.getState(owner, 'browser:agent').agentSessionId).toBe('session-1')
    expect(win.webContents.sent.at(-1)).toEqual(['browser:state', expect.objectContaining({ browserId: 'browser:agent', agentSessionId: 'session-1' })])
    for (const id of ['browser:b', 'browser:c', 'browser:d']) await host.navigate(owner, id, 'https://example.test')
    await host.navigate(owner, 'browser:e', 'https://example.test')
    expect(agentView.webContents.dead).toBe(false)
    expect(views[1]!.webContents.dead).toBe(true)
    live.delete('session-1')
    await host.navigate(owner, 'browser:f', 'https://example.test')
    expect(agentView.webContents.dead).toBe(true)
    expect(host.agentOf(owner, 'browser:agent')).toBe('session-1')
    live.add('session-1')
    await host.navigate(owner, 'browser:agent', 'https://example.test')
    const recreated = views.at(-1)!
    expect(recreated.webContents.throttling).toBe(false)
    expect(host.getState(owner, 'browser:agent').agentSessionId).toBe('session-1')
    host.setAgent(owner, 'browser:agent', null)
    expect(recreated.webContents.throttling).toBe(true)
    expect(host.getState(owner, 'browser:agent').agentSessionId).toBeNull()
    host.setAgent(owner, 'browser:agent', 'session-1')
    host.close(owner, 'browser:agent')
    expect(host.agentOf(owner, 'browser:agent')).toBeNull()
  })

  test('agent reads: console per document, isolated evaluation and load waiting', async () => {
    const { host, owner, views } = fixture()
    host.setAgent(owner, 'browser:a', 'session-1')
    const contents = views[0]!.webContents
    await expect(host.evaluate(owner, 'browser:a', 7, 'code')).rejects.toThrow('No HTTP(S) page')
    await host.navigate(owner, 'browser:a', 'https://example.test')
    for (let index = 0; index < 205; index++) contents.emit('console-message', { level: 'error', message: `m${index}`, sourceId: 'app.js', lineNumber: index })
    expect(host.consoleEntries(owner, 'browser:a')).toHaveLength(200)
    expect(host.consoleEntries(owner, 'browser:a')[0]).toEqual({ level: 'error', message: 'm5', source: 'app.js:5' })
    contents.emit('did-start-navigation', {}, 'https://example.test/#x', true, true)
    expect(host.consoleEntries(owner, 'browser:a')).toHaveLength(200)
    contents.emit('did-start-navigation', {}, 'https://example.test/next', false, false)
    expect(host.consoleEntries(owner, 'browser:a')).toHaveLength(200)
    contents.emit('did-start-navigation', {}, 'https://example.test/next', false, true)
    expect(host.consoleEntries(owner, 'browser:a')).toHaveLength(0)

    expect(await host.evaluate(owner, 'browser:a', 7, 'code')).toBe('result')
    expect(contents.evaluated[0]![0]).toBe(7)
    expect(contents.evaluated[0]![1]).toContain('value: await (code)')
    contents.evaluation = async () => { contents.emit('did-start-navigation', {}, 'https://example.test/other', false, true); return 'stale' }
    await expect(host.evaluate(owner, 'browser:a', 7, 'code')).rejects.toThrow('navigated')

    contents.loading = true
    const waiting = host.waitForLoad(owner, 'browser:a', 1000)
    contents.emit('did-stop-loading')
    expect(await waiting).toBe(true)
    expect(await host.waitForLoad(owner, 'browser:a', 5)).toBe(false)
    contents.loading = false
    expect(await host.waitForLoad(owner, 'browser:a', 5)).toBe(true)
    expect(() => host.waitForLoad(owner, 'browser:missing', 5)).toThrow('not open')
  })

  test('page interaction stops before input if control or the document changes during preparation', async () => {
    const { host, owner, views } = fixture()
    host.setAgent(owner, 'browser:a', 'session-1')
    await host.navigate(owner, 'browser:a', 'https://example.test')
    const contents = views[0]!.webContents
    const click = { action: 'click' as const, ref: 'e1' }
    await expect(host.interact(owner, 'browser:a', 'session-2', click)).rejects.toThrow('released')
    expect(contents.evaluated).toHaveLength(0)
    contents.evaluation = async () => {
      host.setAgent(owner, 'browser:a', null)
      return { x: 10, y: 10 }
    }
    await expect(host.interact(owner, 'browser:a', 'session-1', click)).rejects.toThrow('released')
    expect(contents.debuggerCommands).toHaveLength(0)
    host.setAgent(owner, 'browser:a', 'session-1')
    contents.evaluation = async () => {
      contents.emit('did-start-navigation', {}, 'https://example.test/next', false, true)
      return { x: 10, y: 10 }
    }
    await expect(host.interact(owner, 'browser:a', 'session-1', click)).rejects.toThrow('page changed')
    expect(contents.debuggerCommands).toHaveLength(0)
    contents.evaluation = async () => ({ x: 10, y: 10 })
    await host.interact(owner, 'browser:a', 'session-1', click)
    expect(contents.debuggerCommands).toEqual([
      ['Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 10 }],
      ['Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 10, button: 'left', clickCount: 1 }],
      ['Input.dispatchMouseEvent', { type: 'mouseReleased', x: 10, y: 10, button: 'left', clickCount: 1 }]
    ])
    expect(views[0]!.visible).toBe(false)
    expect(contents.debuggerAttached).toBe(false)
  })

  test('agent takeover reloads the saved URL of an evicted tab without waiting for it to become visible', async () => {
    const { host, owner, views } = fixture()
    await host.navigate(owner, 'browser:a', 'https://example.test/saved')
    const oldDocument = host.getState(owner, 'browser:a').documentId
    for (const id of ['b', 'c', 'd', 'e']) await host.navigate(owner, `browser:${id}`, 'https://example.test/other')
    expect(views[0]!.webContents.dead).toBe(true)
    host.setAgent(owner, 'browser:a', 'session-1')
    const restored = views.at(-1)!
    expect(restored.webContents.url).toBe('https://example.test/saved')
    expect(host.getState(owner, 'browser:a').documentId).not.toBe(oldDocument)
    expect(restored.visible).toBe(false)
    expect(restored.webContents.throttling).toBe(false)
    expect(await host.evaluate(owner, 'browser:a', 1207, 'snapshot')).toBe('result')
    expect(await host.capture(owner, 'browser:a')).toMatchObject({ mimeType: 'image/png' })
    let reloads = 0
    restored.webContents.loadURL = async () => { reloads++ }
    host.setAgent(owner, 'browser:a', 'session-1')
    host.setBounds(owner, 'browser:a', bounds)
    expect(reloads).toBe(0)
  })

  test('never-shown pages request a CDP frame without showing or selecting their view', async () => {
    const { host, owner, views } = fixture()
    host.setAgent(owner, 'browser:hidden', 'session-1')
    await host.navigate(owner, 'browser:hidden', 'https://example.test')
    const view = views[0]!
    view.webContents.capturePage = async () => { throw new Error('Current display surface not available for capture') }
    expect(await host.capture(owner, 'browser:hidden')).toEqual({ mimeType: 'image/png', data: Buffer.from('png').toString('base64') })
    expect(view.visible).toBe(false)
    expect(view.webContents.debuggerAttached).toBe(false)
    expect(view.webContents.debuggerCommands).toEqual([['Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }]])
  })

  test('capture rejects blank/loading pages and returns PNG; capture race rejects', async () => {
    const { host, owner, views } = fixture()
    await expect(host.capture(owner, 'a')).rejects.toThrow()
    host.setBounds(owner, 'a', bounds)
    await expect(host.capture(owner, 'a')).rejects.toThrow()
    await host.navigate(owner, 'a', 'https://example.com')
    views[0].webContents.loading = true
    await expect(host.capture(owner, 'a')).rejects.toThrow()
    views[0].webContents.loading = false
    expect(await host.capture(owner, 'a')).toEqual({ mimeType: 'image/png', data: Buffer.from('png').toString('base64') })
    const capture = host.capture(owner, 'a')
    host.close(owner, 'a')
    await expect(capture).rejects.toThrow()
    expect(await host.snapshot(owner, 'a')).toBeNull()
  })
})
