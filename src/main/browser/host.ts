/** Native previews belong to a window, not the agent runtime. Hidden views are LRU cached;
 * document tokens invalidate delayed guest selections on every main-frame navigation. */
import { randomUUID } from 'node:crypto'
import type { View, WebContentsView, BrowserWindow, IpcMainEvent, Session } from 'electron'
import {
  BROWSER_SHORTCUT_CHANNEL, BROWSER_CLOSE_TAB_CHANNEL, BROWSER_PICKER_CHANNEL, BROWSER_SELECTION_CHANNEL, BROWSER_PICKER_CANCEL_CHANNEL, BROWSER_MARKER_REMOVE_CHANNEL, BROWSER_MARKER_UPDATE_CHANNEL,
  type BrowserBounds, type BrowserState, type BrowserScreenshot, type BrowserAnnotation, type BrowserPickerOptions
} from '../../shared/browser'
import { captureHiddenPage } from './hidden-screenshot'
import { executeBrowserScript } from './browser-script'
import { attachBrowserNetwork, type BrowserNetworkLog, type BrowserNetworkEntry } from './network-log'
import { uploadBrowserFiles } from './agent-upload'
import { interactWithPage, type BrowserInteraction } from './agent-interaction'
import { browserDipBounds, isBrowserElement, isBrowserUrl, normalizeBrowserUrl, validateBounds, validatePickerOptions } from './validation'

interface Page {
  view: WebContentsView
  devtools?: WebContentsView
  clip?: View
  state: BrowserState
  bounds: BrowserBounds | null
  used: number
  disposed: boolean
  pickerOptions?: BrowserPickerOptions
  annotationLimitReached?: boolean
  /** Latest console messages of the current document, for the agent's browser_console tool. */
  console: BrowserConsoleEntry[]
  network: BrowserNetworkLog
}
export interface BrowserConsoleEntry {
  level: 'debug' | 'info' | 'warning' | 'error'
  message: string
  source: string
}
const CONSOLE_LIMIT = 200
// A hidden page that was never laid out has no size; agent snapshots and captures need a viewport.
const AGENT_VIEWPORT = { x: 0, y: 0, width: 1280, height: 800 }
interface WindowPages {
  win: BrowserWindow
  pages: Map<string, Page>
  urls: Map<string, string>
  annotations: Map<string, BrowserAnnotation[]>
  ordinals: Map<string, number>
  /** browserId → controlling Pi session; survives LRU eviction like the retained URL. */
  agents: Map<string, string>
  disposed: boolean
}
const securedSessions = new WeakSet<Session>()

function secureSession(session: Session): void {
  if (securedSessions.has(session)) return
  securedSessions.add(session)
  session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  session.setPermissionCheckHandler(() => false)
  session.setDevicePermissionHandler(() => false)
  session.on('will-download', event => event.preventDefault())
}

/** Electron drops `view.webContents` once it is destroyed, including inside its own 'destroyed' listeners. */
function liveContents(view: WebContentsView): Electron.WebContents | null {
  const contents = view.webContents as Electron.WebContents | undefined
  return contents && !contents.isDestroyed() ? contents : null
}

export function emptyBrowserState(browserId: string): BrowserState {
  return { browserId, documentId: '', url: '', title: '', loading: false, canGoBack: false, canGoForward: false, selecting: false, devtools: false, annotations: [], error: null, agentSessionId: null }
}

export class BrowserHost {
  private windows = new Map<BrowserWindow, WindowPages>()
  private watched = new WeakSet<BrowserWindow>()
  private clock = 0

  /** `isAgentLive` lets a closed session's control lapse: its page is no longer pinned against eviction. */
  constructor(
    private createView: (kind: 'page' | 'devtools') => WebContentsView,
    private isAgentLive: (sessionId: string) => boolean,
    private createClip: () => View
  ) {}

  private owner(win: BrowserWindow): WindowPages {
    if (win.isDestroyed() || win.webContents.isDestroyed()) throw new Error('Browser window is closed')
    let owner = this.windows.get(win)
    if (!owner) {
      owner = { win, pages: new Map(), urls: new Map(), annotations: new Map(), ordinals: new Map(), agents: new Map(), disposed: false }
      this.windows.set(win, owner)
      if (!this.watched.has(win)) {
        this.watched.add(win)
        win.once('closed', () => this.closeWindow(win))
        win.on('resize', () => {
          const current = this.windows.get(win)
          if (current && !current.disposed) for (const page of current.pages.values()) this.layout(current, page)
        })
      }
    }
    return owner
  }

  /** Invalidate async page work before disposal; a reloaded UI gets a fresh window owner. */
  closeWindow(win: BrowserWindow): void {
    const owner = this.windows.get(win)
    if (!owner) return
    owner.disposed = true
    this.windows.delete(win)
    for (const page of owner.pages.values()) this.dispose(owner, page)
    owner.pages.clear()
    owner.urls.clear()
    owner.annotations.clear()
    owner.ordinals.clear()
    owner.agents.clear()
  }

  private alive(owner: WindowPages, page: Page): boolean {
    return !owner.disposed && !owner.win.isDestroyed() && !owner.win.webContents.isDestroyed() && !page.disposed && !!liveContents(page.view)
  }

  private push(owner: WindowPages, page: Page, focused = false): void {
    if (!this.alive(owner, page)) return
    const wc = page.view.webContents
    page.state.annotations = owner.annotations.get(page.state.browserId) ?? []
    page.state.canGoBack = wc.navigationHistory.canGoBack()
    page.state.canGoForward = wc.navigationHistory.canGoForward()
    owner.win.webContents.send('browser:state', { ...page.state, ...(focused ? { focused: true } : {}) })
  }

  private picker(owner: WindowPages, page: Page, active: boolean): void {
    page.state.selecting = active
    if (this.alive(owner, page)) page.view.webContents.send(BROWSER_PICKER_CHANNEL, {
      active, documentId: page.state.documentId, options: page.pickerOptions,
      markers: (owner.annotations.get(page.state.browserId) ?? []).map(({ id, ordinal, documentId, element, comment }) => ({
        id, ordinal, documentId, selector: element.selector, comment
      }))
    })
  }

  private layout(owner: WindowPages, page: Page): void {
    if (!this.alive(owner, page)) return
    if (!page.bounds) {
      page.clip?.setVisible(false)
      page.view.setVisible(false)
      page.devtools?.setVisible(false)
      return
    }
    const [width, height] = owner.win.getContentSize()
    const bounds = browserDipBounds(page.bounds, owner.win.webContents.getZoomFactor(), width, height)
    // Docked DevTools take the lower part of the pane, leaving the page at least 120 DIP.
    const tools = page.devtools ? Math.max(0, Math.min(Math.max(Math.round(bounds.height * 0.45), 160), bounds.height - 120)) : 0
    const zoom = owner.win.webContents.getZoomFactor()
    const left = Math.min(Math.round((page.bounds.bottomLeftRadius ?? 0) * zoom), Math.floor(bounds.width / 2), Math.floor(bounds.height / 2))
    const right = Math.min(Math.round((page.bounds.bottomRightRadius ?? 0) * zoom), Math.floor(bounds.width / 2), Math.floor(bounds.height / 2))
    const radius = Math.max(left, right)
    if (radius > 0 && !page.clip) {
      const clip = this.createClip()
      // Electron's zero-blur setter creates a transparent compositor layer. Without a layer,
      // View.setBorderRadius only clips ordinary paint, not child WebContentsView layers.
      clip.setBackgroundBlur(0)
      owner.win.contentView.removeChildView(page.view)
      clip.addChildView(page.view)
      if (page.devtools) {
        owner.win.contentView.removeChildView(page.devtools)
        clip.addChildView(page.devtools)
      }
      owner.win.contentView.addChildView(clip)
      page.clip = clip
    }
    // Move the upper corners above the page; extend square split-pane edges past the clip.
    // Only the outer panel's lower corners intersect rendered web content.
    const offsetX = page.clip && !left ? radius : 0
    const offsetY = page.clip ? radius : 0
    if (page.clip) {
      page.clip.setBounds({
        x: bounds.x - offsetX, y: bounds.y - offsetY,
        width: bounds.width + offsetX + (!right ? radius : 0), height: bounds.height + offsetY
      })
      page.clip.setBorderRadius(radius)
      page.clip.setVisible(bounds.width > 0 && bounds.height > 0)
    }
    const child = page.clip ? { ...bounds, x: offsetX, y: offsetY } : bounds
    page.view.setBounds({ ...child, height: bounds.height - tools })
    page.view.setVisible(bounds.width > 0 && bounds.height - tools > 0)
    if (page.devtools) {
      page.devtools.setBounds({ x: child.x, y: child.y + bounds.height - tools, width: bounds.width, height: tools })
      page.devtools.setVisible(bounds.width > 0 && tools > 0)
    }
  }

  private detachDevTools(owner: WindowPages, page: Page): void {
    const devtools = page.devtools
    if (!devtools) return
    page.devtools = undefined
    page.state.devtools = false
    if (!owner.win.isDestroyed()) (page.clip ?? owner.win.contentView).removeChildView(devtools)
    liveContents(devtools)?.close({ waitForBeforeUnload: false })
  }

  private dispose(owner: WindowPages, page: Page): void {
    if (page.disposed) return
    page.disposed = true
    page.network.dispose()
    this.detachDevTools(owner, page)
    if (!owner.win.isDestroyed()) {
      (page.clip ?? owner.win.contentView).removeChildView(page.view)
      if (page.clip) owner.win.contentView.removeChildView(page.clip)
    }
    liveContents(page.view)?.close({ waitForBeforeUnload: false })
  }

  private page(win: BrowserWindow, browserId: string, create = true): { owner: WindowPages; page: Page | undefined } {
    const owner = this.owner(win)
    let page = owner.pages.get(browserId)
    if (page && (page.disposed || !liveContents(page.view))) {
      this.dispose(owner, page)
      owner.pages.delete(browserId)
      page = undefined
    }
    if (!page && create) {
      if (owner.pages.size >= 4) {
        const candidate = [...owner.pages.entries()].filter(([id, p]) => !p.bounds && !this.pinned(owner, id)).sort((a, b) => a[1].used - b[1].used)[0]
        if (!candidate) throw new Error('No hidden browser preview to evict')
        this.dispose(owner, candidate[1])
        owner.pages.delete(candidate[0])
      }
      const view = this.createView('page')
      const agentSessionId = owner.agents.get(browserId) ?? null
      page = {
        view, state: { ...emptyBrowserState(browserId), url: owner.urls.get(browserId) ?? '', documentId: randomUUID(), agentSessionId },
        bounds: null, used: ++this.clock, disposed: false, console: [], network: attachBrowserNetwork(view.webContents)
      }
      owner.pages.set(browserId, page)
      secureSession(view.webContents.session)
      view.setBounds(AGENT_VIEWPORT)
      view.setVisible(false)
      if (agentSessionId) view.webContents.setBackgroundThrottling(false)
      win.contentView.addChildView(view)
      this.bind(owner, page)
    }
    if (page) page.used = ++this.clock
    return { owner, page }
  }

  private bindHostShortcuts(owner: WindowPages, page: Page, contents: Electron.WebContents): void {
    // Guest events never reach App's keydown listener. Only Pig's shortcuts cross this boundary;
    // editing and page shortcuts remain with the focused guest.
    contents.on('before-input-event', (event, input) => {
      if (!this.alive(owner, page) || contents.isDestroyed()) return
      if (input.type !== 'keyDown' || !input.meta || input.control || input.alt || input.isComposing) return
      const key = input.key.toLowerCase()
      if (key === 'w' && !input.shift) {
        event.preventDefault()
        if (!input.isAutoRepeat) owner.win.webContents.send(BROWSER_CLOSE_TAB_CHANNEL, page.state.browserId)
        return
      }
      const action = key === 'e'
        ? (input.shift ? 'toggle-workspace' : 'toggle-sidebar')
        : key === ',' && !input.shift
          ? 'toggle-settings'
          : key === 'a' && input.shift
            ? 'open-project'
            : null
      if (!action) return
      event.preventDefault()
      if (!input.isAutoRepeat) owner.win.webContents.send(BROWSER_SHORTCUT_CHANNEL, action)
    })
  }

  private bind(owner: WindowPages, page: Page): void {
    const wc = page.view.webContents
    this.bindHostShortcuts(owner, page, wc)
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('focus', () => this.push(owner, page, true))
    // Also fires when the user closes DevTools from their own toolbar.
    wc.on('devtools-closed', () => {
      if (!page.devtools) return
      this.detachDevTools(owner, page)
      this.layout(owner, page)
      this.push(owner, page)
    })
    wc.on('dom-ready', () => this.picker(owner, page, page.state.selecting))
    wc.on('will-frame-navigate', event => {
      if (!isBrowserUrl(event.url)) event.preventDefault()
    })
    wc.on('will-navigate', (event, url) => {
      if (!isBrowserUrl(url)) event.preventDefault()
    })
    wc.on('will-redirect', (event, url) => {
      if (!isBrowserUrl(url)) event.preventDefault()
    })
    wc.on('will-attach-webview', event => event.preventDefault())
    wc.on('console-message', (event) => {
      page.console.push({ level: event.level, message: event.message.slice(0, 2000), source: `${event.sourceId}:${event.lineNumber}` })
      if (page.console.length > CONSOLE_LIMIT) page.console.splice(0, page.console.length - CONSOLE_LIMIT)
    })
    wc.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
      if (!isMainFrame) return
      if (!inPlace) {
        page.console = []
        page.network.clear()
      }
      this.picker(owner, page, false)
      page.state.documentId = randomUUID()
      page.annotationLimitReached = false
      page.state.error = null
      this.push(owner, page)
    })
    wc.on('did-start-loading', () => { page.state.loading = true; this.push(owner, page) })
    wc.on('did-stop-loading', () => { page.state.loading = false; this.push(owner, page) })
    wc.on('did-navigate', (_event, url) => {
      page.state.url = url
      owner.urls.set(page.state.browserId, url)
      this.push(owner, page)
    })
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) {
        page.state.url = url
        owner.urls.set(page.state.browserId, url)
        this.push(owner, page)
      }
    })
    wc.on('page-title-updated', (_event, title) => { page.state.title = title; this.push(owner, page) })
    wc.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return // Superseded navigations are not page errors.
      page.annotationLimitReached = false
      page.state.error = description
      page.state.loading = false
      this.picker(owner, page, false)
      this.push(owner, page)
    })
    wc.on('render-process-gone', (_event, details) => {
      page.state.loading = false
      page.annotationLimitReached = false
      page.state.error = `Browser process exited: ${details.reason}`
      this.picker(owner, page, false)
      this.push(owner, page)
    })
    wc.on('ipc-message', (event, channel, ...args) => this.guestMessage(owner, page, event, channel, args[0]))
    wc.once('destroyed', () => {
      if (page.disposed) return
      page.state.loading = false
      page.state.selecting = false
      page.state.error = 'Browser page was destroyed'
      if (!owner.disposed && !owner.win.isDestroyed() && !owner.win.webContents.isDestroyed()) {
        owner.win.webContents.send('browser:state', { ...page.state })
      }
      this.dispose(owner, page)
      owner.pages.delete(page.state.browserId)
    })
  }

  private guestMessage(owner: WindowPages, page: Page, event: IpcMainEvent, channel: string, payload: unknown): void {
    if (!this.alive(owner, page) || event.sender !== page.view.webContents || event.senderFrame !== page.view.webContents.mainFrame) return
    if (!payload || typeof payload !== 'object' || (payload as { documentId?: unknown }).documentId !== page.state.documentId) return
    if (channel === BROWSER_SELECTION_CHANNEL) {
      const { element, comment } = payload as { element?: unknown; comment?: unknown }
      if (!page.state.selecting || !isBrowserElement(element) || typeof comment !== 'string' || comment.length > 4000) return
      const existing = owner.annotations.get(page.state.browserId) ?? []
      if (existing.length >= 100) {
        page.annotationLimitReached = true
        page.state.error = 'Too many browser annotations. Send or clear the existing markers before adding more.'
        this.picker(owner, page, false)
        this.push(owner, page)
        return
      }
      const ordinal = (owner.ordinals.get(page.state.browserId) ?? 0) + 1
      const annotation: BrowserAnnotation = {
        id: randomUUID(), browserId: page.state.browserId, documentId: page.state.documentId,
        url: page.state.url, title: page.state.title, capturedAt: Date.now(), element,
        ordinal, comment: comment.trim()
      }
      owner.ordinals.set(page.state.browserId, ordinal)
      owner.annotations.set(page.state.browserId, [...existing, annotation])
      this.picker(owner, page, true)
      this.push(owner, page)
      owner.win.webContents.send('browser:selection', annotation)
    } else if (channel === BROWSER_MARKER_REMOVE_CHANNEL) {
      const id = (payload as { id?: unknown }).id
      if (typeof id !== 'string') return
      const annotation = owner.annotations.get(page.state.browserId)?.find((item) => item.id === id && item.documentId === page.state.documentId)
      if (annotation) this.removeAnnotations(owner.win, page.state.browserId, [id])
    } else if (channel === BROWSER_MARKER_UPDATE_CHANNEL) {
      const { id, comment } = payload as { id?: unknown; comment?: unknown }
      if (typeof id !== 'string' || typeof comment !== 'string' || comment.length > 4000) return
      const existing = owner.annotations.get(page.state.browserId) ?? []
      if (!existing.some((item) => item.id === id && item.documentId === page.state.documentId)) return
      owner.annotations.set(page.state.browserId, existing.map((item) => item.id === id ? { ...item, comment: comment.trim() } : item))
      this.picker(owner, page, page.state.selecting)
      this.push(owner, page)
    } else if (channel === BROWSER_PICKER_CANCEL_CHANNEL) {
      this.picker(owner, page, false)
      this.push(owner, page)
    }
  }

  getState(win: BrowserWindow, id: string): BrowserState {
    const { owner, page } = this.page(win, id, false)
    return { ...(page?.state ?? { ...emptyBrowserState(id), url: owner.urls.get(id) ?? '', agentSessionId: owner.agents.get(id) ?? null }), annotations: [...(owner.annotations.get(id) ?? [])] }
  }

  async navigate(win: BrowserWindow, id: string, input: unknown): Promise<void> {
    const url = normalizeBrowserUrl(input)
    const { owner, page } = this.page(win, id)
    if (!page) return
    owner.urls.set(id, url)
    page.state.error = null
    try { await page.view.webContents.loadURL(url) } catch (error) {
      if (!this.alive(owner, page)) return
      if ((error as { code?: string }).code === 'ERR_ABORTED') return
      page.state.error = error instanceof Error ? error.message : String(error)
      this.push(owner, page)
      throw error
    }
  }

  history(win: BrowserWindow, id: string, action: 'back' | 'forward' | 'reload'): void {
    const { page } = this.page(win, id, false)
    if (!page) return
    const wc = page.view.webContents
    if (action === 'reload') { if (isBrowserUrl(wc.getURL())) wc.reload() }
    else if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
  }

  setBounds(win: BrowserWindow, id: string, bounds: BrowserBounds | null): void {
    if (bounds !== null) validateBounds(bounds)
    const retained = this.page(win, id, false)
    const restoreUrl = !retained.page && bounds !== null ? retained.owner.urls.get(id) : undefined
    const { owner, page } = bounds === null ? retained : this.page(win, id)
    if (!page) return
    page.bounds = bounds
    if (!bounds) this.picker(owner, page, false)
    this.layout(owner, page)
    this.push(owner, page)
    if (restoreUrl) this.restorePage(win, id, restoreUrl)
  }

  private restorePage(win: BrowserWindow, id: string, url: string): void {
    // Restoration must not block UI bounds or control changes on network IO. navigate publishes
    // failures as browser state; this background-entry boundary also reports them to the main log.
    void this.navigate(win, id, url).catch(error => console.error('Browser preview restoration failed:', error))
  }

  setSelecting(win: BrowserWindow, id: string, selecting: boolean, options?: BrowserPickerOptions): void {
    if (typeof selecting !== 'boolean') throw new Error('Invalid selecting flag')
    if (options !== undefined) validatePickerOptions(options)
    const { owner, page } = this.page(win, id, false)
    if (!page) { if (selecting) throw new Error('No browser page'); return }
    if (selecting && (!page.bounds || page.state.loading || page.state.error || !isBrowserUrl(page.state.url))) throw new Error('Browser page is not ready')
    if (options) page.pickerOptions = options
    this.picker(owner, page, selecting)
    this.push(owner, page)
  }

  removeAnnotations(win: BrowserWindow, id: string, ids: string[]): void {
    if (!Array.isArray(ids) || ids.length > 100 || ids.some(value => typeof value !== 'string' || value.length > 128)) throw new Error('Invalid annotation ids')
    const { owner, page } = this.page(win, id, false)
    const remove = new Set(ids)
    owner.annotations.set(id, (owner.annotations.get(id) ?? []).filter(item => !remove.has(item.id)))
    if (page) {
      if (page.annotationLimitReached && (owner.annotations.get(id)?.length ?? 0) < 100) {
        page.annotationLimitReached = false
        page.state.error = null
      }
      this.picker(owner, page, page.state.selecting)
      this.push(owner, page)
    } else {
      win.webContents.send('browser:state', this.getState(win, id))
    }
  }

  async capture(win: BrowserWindow, id: string): Promise<BrowserScreenshot> {
    const { owner, page } = this.page(win, id, false)
    if (!page || page.state.loading || page.view.webContents.isLoading() || page.state.error || !isBrowserUrl(page.state.url)) throw new Error('Browser page is not ready')
    const documentId = page.state.documentId
    let data: string
    if (page.view.getVisible()) {
      const image = await page.view.webContents.capturePage()
      if (image.isEmpty()) throw new Error('Browser screenshot is empty')
      data = image.toPNG().toString('base64')
    } else {
      data = await captureHiddenPage(page.view.webContents)
    }
    if (!this.alive(owner, page) || documentId !== page.state.documentId || page.state.loading) throw new Error('Browser page changed during capture')
    return { mimeType: 'image/png', data }
  }

  async snapshot(win: BrowserWindow, id: string): Promise<string | null> {
    const { owner, page } = this.page(win, id, false)
    if (!page || !page.view.getVisible() || page.state.error || !isBrowserUrl(page.state.url)) return null
    const image = await page.view.webContents.capturePage()
    if (!this.alive(owner, page) || image.isEmpty()) return null
    return `data:image/jpeg;base64,${image.toJPEG(85).toString('base64')}`
  }

  /** Toggles DevTools docked inside the pane instead of a separate window. */
  inspect(win: BrowserWindow, id: string): void {
    const { owner, page } = this.page(win, id, false)
    if (!page || !isBrowserUrl(page.state.url)) throw new Error('Browser page is not ready')
    const wc = page.view.webContents
    if (page.devtools) {
      if (wc.isDevToolsOpened()) wc.closeDevTools()
      this.detachDevTools(owner, page)
    } else {
      const devtools = this.createView('devtools')
      devtools.setVisible(false)
      const parent = page.clip ?? owner.win.contentView
      parent.addChildView(devtools)
      page.devtools = devtools
      page.state.devtools = true
      this.bindHostShortcuts(owner, page, devtools.webContents)
      // The DevTools × destroys this WebContents; the page then emits devtools-closed.
      devtools.webContents.once('destroyed', () => {
        if (page.devtools !== devtools) return
        this.detachDevTools(owner, page)
        this.layout(owner, page)
        this.push(owner, page)
      })
      // The target must be set before opening and must be a fresh, never-navigated WebContents.
      // With an external target Electron does not move views; a docked mode only makes the
      // frontend show its docked toolbar, including the close button that 'detach' hides.
      wc.setDevToolsWebContents(devtools.webContents)
      wc.openDevTools({ mode: 'bottom', activate: false })
    }
    this.layout(owner, page)
    this.push(owner, page)
  }

  private pinned(owner: WindowPages, id: string): boolean {
    const sessionId = owner.agents.get(id)
    return !!sessionId && this.isAgentLive(sessionId)
  }

  agentOf(win: BrowserWindow, id: string): string | null {
    return this.owner(win).agents.get(id) ?? null
  }

  /** Grants or ends agent control. A controlled page exists even while hidden and keeps running at full speed. */
  setAgent(win: BrowserWindow, id: string, sessionId: string | null): void {
    const retained = this.page(win, id, false)
    const restoreUrl = !retained.page && sessionId !== null ? retained.owner.urls.get(id) : undefined
    const { owner, page } = sessionId === null ? retained : this.page(win, id)
    if (sessionId) owner.agents.set(id, sessionId)
    else owner.agents.delete(id)
    if (!page) return
    page.state.agentSessionId = sessionId
    page.view.webContents.setBackgroundThrottling(!sessionId)
    this.push(owner, page)
    if (restoreUrl) this.restorePage(win, id, restoreUrl)
  }

  private agentPage(win: BrowserWindow, id: string, sessionId: string, signal?: AbortSignal) {
    const { owner, page } = this.page(win, id, false)
    if (!page) throw new Error('Browser page is not open')
    const documentId = page.state.documentId
    const assertCurrent = () => {
      signal?.throwIfAborted()
      if (!this.alive(owner, page) || documentId !== page.state.documentId) throw new Error('Browser page changed during interaction')
      if (owner.agents.get(id) !== sessionId) throw new Error('Browser control was released or transferred')
      if (!isBrowserUrl(page.state.url) || page.state.error) throw new Error('Browser page is not ready')
    }
    assertCurrent()
    return { page, assertCurrent }
  }

  async interact(win: BrowserWindow, id: string, sessionId: string, request: BrowserInteraction, signal?: AbortSignal): Promise<void> {
    const { page, assertCurrent } = this.agentPage(win, id, sessionId, signal)
    await interactWithPage(page.view.webContents, request, signal, assertCurrent)
  }

  async upload(win: BrowserWindow, id: string, sessionId: string, ref: string, files: readonly string[], signal?: AbortSignal): Promise<void> {
    const { page, assertCurrent } = this.agentPage(win, id, sessionId, signal)
    await uploadBrowserFiles(page.view.webContents, ref, files, signal, assertCurrent)
  }

  networkEntries(win: BrowserWindow, id: string): BrowserNetworkEntry[] {
    return this.page(win, id, false).page?.network.entries() ?? []
  }

  /** Resolves true once the main frame stopped loading, false when `timeout` elapsed first. */
  waitForLoad(win: BrowserWindow, id: string, timeout: number): Promise<boolean> {
    const { owner, page } = this.page(win, id, false)
    if (!page || !this.alive(owner, page)) throw new Error('Browser page is not open')
    const wc = page.view.webContents
    if (!wc.isLoading()) return Promise.resolve(true)
    return new Promise((resolve) => {
      const done = (value: boolean) => { clearTimeout(timer); wc.off('did-stop-loading', stopped); wc.off('destroyed', stopped); resolve(value) }
      const stopped = () => done(true)
      const timer = setTimeout(() => done(false), timeout)
      wc.once('did-stop-loading', stopped)
      wc.once('destroyed', stopped)
    })
  }

  /** Runs code in the agent's isolated world of the main frame; a navigation meanwhile fails the call. */
  async evaluate<T>(win: BrowserWindow, id: string, world: number, code: string): Promise<T> {
    const { owner, page } = this.page(win, id, false)
    if (!page || !this.alive(owner, page) || !isBrowserUrl(page.state.url)) throw new Error('No HTTP(S) page is open')
    const documentId = page.state.documentId
    const result = await executeBrowserScript<T>(page.view.webContents, world, code)
    if (!this.alive(owner, page) || documentId !== page.state.documentId) throw new Error('Browser page navigated while it was being read')
    return result
  }

  consoleEntries(win: BrowserWindow, id: string): BrowserConsoleEntry[] {
    return [...(this.page(win, id, false).page?.console ?? [])]
  }

  close(win: BrowserWindow, id: string): void {
    const { owner, page } = this.page(win, id, false)
    if (page) this.dispose(owner, page)
    owner.agents.delete(id)
    owner.pages.delete(id)
    owner.urls.delete(id)
    owner.annotations.delete(id)
    owner.ordinals.delete(id)
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('browser:state', emptyBrowserState(id))
  }
}
