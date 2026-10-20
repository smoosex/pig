/** Native previews belong to a window, not the agent runtime. Hidden views are LRU cached;
 * document tokens invalidate delayed guest selections on every main-frame navigation. */
import { randomUUID } from 'node:crypto'
import type { WebContentsView, BrowserWindow, IpcMainEvent, Session } from 'electron'
import {
  BROWSER_PICKER_CHANNEL, BROWSER_SELECTION_CHANNEL, BROWSER_PICKER_CANCEL_CHANNEL, BROWSER_MARKER_REMOVE_CHANNEL, BROWSER_MARKER_UPDATE_CHANNEL,
  type BrowserBounds, type BrowserState, type BrowserScreenshot, type BrowserAnnotation, type BrowserPickerOptions
} from '../../shared/browser'
import { browserDipBounds, isBrowserElement, isBrowserUrl, normalizeBrowserUrl, validateBounds, validatePickerOptions } from './validation'

interface Page {
  view: WebContentsView
  devtools?: WebContentsView
  state: BrowserState
  bounds: BrowserBounds | null
  used: number
  disposed: boolean
  pickerOptions?: BrowserPickerOptions
  annotationLimitReached?: boolean
}
interface WindowPages {
  win: BrowserWindow
  pages: Map<string, Page>
  urls: Map<string, string>
  annotations: Map<string, BrowserAnnotation[]>
  ordinals: Map<string, number>
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
  return { browserId, documentId: '', url: '', title: '', loading: false, canGoBack: false, canGoForward: false, selecting: false, devtools: false, annotations: [], error: null }
}

export class BrowserHost {
  private windows = new Map<BrowserWindow, WindowPages>()
  private clock = 0

  constructor(private createView: (kind: 'page' | 'devtools') => WebContentsView) {}

  private owner(win: BrowserWindow): WindowPages {
    if (win.isDestroyed() || win.webContents.isDestroyed()) throw new Error('Browser window is closed')
    let owner = this.windows.get(win)
    if (!owner) {
      owner = { win, pages: new Map(), urls: new Map(), annotations: new Map(), ordinals: new Map(), disposed: false }
      this.windows.set(win, owner)
      const current = owner
      win.once('closed', () => {
        current.disposed = true
        for (const page of current.pages.values()) this.dispose(current, page)
        current.pages.clear()
        current.urls.clear()
        current.annotations.clear()
        current.ordinals.clear()
        this.windows.delete(win)
      })
      win.on('resize', () => {
        if (!current.disposed) for (const page of current.pages.values()) this.layout(current, page)
      })
    }
    return owner
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
      page.view.setVisible(false)
      page.devtools?.setVisible(false)
      return
    }
    const [width, height] = owner.win.getContentSize()
    const bounds = browserDipBounds(page.bounds, owner.win.webContents.getZoomFactor(), width, height)
    // Docked DevTools take the lower part of the pane, leaving the page at least 120 DIP.
    const tools = page.devtools ? Math.max(0, Math.min(Math.max(Math.round(bounds.height * 0.45), 160), bounds.height - 120)) : 0
    page.view.setBounds({ ...bounds, height: bounds.height - tools })
    page.view.setVisible(bounds.width > 0 && bounds.height - tools > 0)
    if (page.devtools) {
      page.devtools.setBounds({ x: bounds.x, y: bounds.y + bounds.height - tools, width: bounds.width, height: tools })
      page.devtools.setVisible(bounds.width > 0 && tools > 0)
    }
  }

  private detachDevTools(owner: WindowPages, page: Page): void {
    const devtools = page.devtools
    if (!devtools) return
    page.devtools = undefined
    page.state.devtools = false
    if (!owner.win.isDestroyed()) owner.win.contentView.removeChildView(devtools)
    liveContents(devtools)?.close({ waitForBeforeUnload: false })
  }

  private dispose(owner: WindowPages, page: Page): void {
    if (page.disposed) return
    page.disposed = true
    this.detachDevTools(owner, page)
    if (!owner.win.isDestroyed()) owner.win.contentView.removeChildView(page.view)
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
        const candidate = [...owner.pages.entries()].filter(([, p]) => !p.bounds).sort((a, b) => a[1].used - b[1].used)[0]
        if (!candidate) throw new Error('No hidden browser preview to evict')
        this.dispose(owner, candidate[1])
        owner.pages.delete(candidate[0])
      }
      const view = this.createView('page')
      page = { view, state: { ...emptyBrowserState(browserId), url: owner.urls.get(browserId) ?? '', documentId: randomUUID() }, bounds: null, used: ++this.clock, disposed: false }
      owner.pages.set(browserId, page)
      secureSession(view.webContents.session)
      view.setVisible(false)
      win.contentView.addChildView(view)
      this.bind(owner, page)
    }
    if (page) page.used = ++this.clock
    return { owner, page }
  }

  private bind(owner: WindowPages, page: Page): void {
    const wc = page.view.webContents
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
    wc.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
      if (!isMainFrame) return
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
    return { ...(page?.state ?? { ...emptyBrowserState(id), url: owner.urls.get(id) ?? '' }), annotations: [...(owner.annotations.get(id) ?? [])] }
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
    if (restoreUrl) {
      // Restoration must not block the bounds queue on network IO. navigate publishes load failures
      // as browser state; this background-entry boundary also reports them to the main log.
      void this.navigate(win, id, restoreUrl).catch(error => console.error('Browser preview restoration failed:', error))
    }
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
    const image = await page.view.webContents.capturePage()
    if (!this.alive(owner, page) || documentId !== page.state.documentId || page.state.loading) throw new Error('Browser page changed during capture')
    if (image.isEmpty()) throw new Error('Browser screenshot is empty')
    return { mimeType: 'image/png', data: image.toPNG().toString('base64') }
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
      owner.win.contentView.addChildView(devtools)
      page.devtools = devtools
      page.state.devtools = true
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

  close(win: BrowserWindow, id: string): void {
    const { owner, page } = this.page(win, id, false)
    if (page) this.dispose(owner, page)
    owner.pages.delete(id)
    owner.urls.delete(id)
    owner.annotations.delete(id)
    owner.ordinals.delete(id)
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('browser:state', emptyBrowserState(id))
  }
}
