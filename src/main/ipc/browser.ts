/** Independent browser panes belong to the creating UI window, never to a Pi session or page guest. */
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clipboard, shell, ipcMain, session, WebContentsView, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { BrowserHost } from '../browser/host'
import { BrowserCookieImporter } from '../browser/cookies/importer'
import { BrowserAgentController } from '../browser/agent'
import { registerBrowserAgentHost } from '../plugins/pig-browser-host'
import { assertBrowserSender, isBrowserUrl } from '../browser/validation'
import { windowForEvent } from './window'
import type { BrowserBounds, BrowserPickerOptions, BrowserCookieScope, BrowserAgentOpenRequest } from '../../shared/browser'

/** Live Pi sessions, for agent browser control. Without it the browser tools report the browser unavailable. */
export interface BrowserSessions {
  sessionWindow(sessionId: string): BrowserWindow | undefined
  isSessionLive(sessionId: string): boolean
}

interface PendingOpen {
  win: BrowserWindow
  sessionId: string
  action?: 'open' | 'activate' | 'close'
  browserId?: string
  settle(result: { browserId: string } | { error: string }): void
  fail(error: Error): void
}

export function registerBrowserIpc(sessions?: BrowserSessions): void {
  const owners = new Map<string, BrowserWindow>()
  const pendingOpens = new Map<string, PendingOpen>()
  const watched = new WeakSet<BrowserWindow>()
  const reloading = new WeakSet<BrowserWindow>()
  const cookies = new BrowserCookieImporter(session.fromPartition('persist:pig-browser').cookies)
  // DevTools front-end gets a default sandboxed view; only the inspected page uses the guest preload.
  const host = new BrowserHost((kind) => kind === 'devtools' ? new WebContentsView() : new WebContentsView({ webPreferences: {
    preload: join(dirname(fileURLToPath(import.meta.url)), '../preload/browser-guest.cjs'),
    partition: 'persist:pig-browser', sandbox: true, contextIsolation: true,
    nodeIntegration: false, webSecurity: true, webviewTag: false
  } }), (sessionId) => sessions?.isSessionLive(sessionId) ?? false)
  function requestTab(win: BrowserWindow, sessionId: string, signal?: AbortSignal, change?: { action: 'activate' | 'close'; browserId: string }): Promise<string> {
    if (reloading.has(win) || win.isDestroyed() || win.webContents.isDestroyed()) throw new Error('Browser UI is reloading')
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      const requestId = randomUUID()
      const finish = (settle: () => void) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        pendingOpens.delete(requestId)
        settle()
      }
      const abort = () => finish(() => reject(signal!.reason))
      const timer = setTimeout(() => finish(() => reject(new Error('The window did not open a browser tab in time'))), 15_000)
      signal?.addEventListener('abort', abort, { once: true })
      pendingOpens.set(requestId, {
        win, sessionId, ...change,
        settle: (result) => finish(() => 'error' in result ? reject(new Error(result.error)) : resolve(result.browserId)),
        fail: (error) => finish(() => reject(error))
      })
      const request: BrowserAgentOpenRequest = change ? { requestId, sessionId, ...change } : { requestId, sessionId }
      win.webContents.send('browser:agent-open-request', request)
    })
  }
  if (sessions) {
    registerBrowserAgentHost(new BrowserAgentController({
      host, requestTab,
      activateTab: async (win, sessionId, browserId, signal) => { await requestTab(win, sessionId, signal, { action: 'activate', browserId }) },
      closeTab: async (win, sessionId, browserId, signal) => {
        signal?.throwIfAborted()
        // Retire main ownership before asking UI to remove the tab: no other agent can acquire it
        // while the renderer round-trip is pending. A late UI close remains idempotent.
        host.close(win, browserId)
        owners.delete(browserId)
        await requestTab(win, sessionId, signal, { action: 'close', browserId })
      },
      sessionWindow: sessions.sessionWindow,
      isSessionLive: sessions.isSessionLive,
      browsers: (win) => [...owners].filter(([, owner]) => owner === win).map(([id]) => id)
    }))
  }
  function ui(event: IpcMainInvokeEvent, id: string): BrowserWindow {
    const win = windowForEvent(event)
    assertBrowserSender(event, win)
    if (reloading.has(win)) throw new Error('Browser UI is reloading')
    if (typeof id !== 'string' || !/^browser:[a-z\d-]{1,128}$/i.test(id)) throw new Error('Invalid browser id')
    return win
  }
  function owner(event: IpcMainInvokeEvent, id: string): BrowserWindow {
    const win = ui(event, id)
    if (owners.get(id) !== win) throw new Error('Browser pane does not belong to this window')
    return win
  }
  ipcMain.handle('browser:create', (event, id: string) => {
    const win = ui(event, id)
    if (owners.has(id) && owners.get(id) !== win) throw new Error('Browser pane belongs to another window')
    owners.set(id, win)
    if (!watched.has(win)) {
      watched.add(win)
      const clear = () => {
        for (const [id, owner] of owners) if (owner === win) owners.delete(id)
        for (const pending of [...pendingOpens.values()]) if (pending.win === win) pending.fail(new Error('Browser UI was reloaded or closed'))
        host.closeWindow(win)
      }
      // Renderer teardown cannot reliably run React cleanup. Native panes must not outlive
      // their owning UI document, including DevTools and previews hidden in the LRU cache.
      win.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        if (!isMainFrame || isInPlace) return
        reloading.add(win)
        clear()
      })
      win.webContents.on('render-process-gone', () => {
        reloading.add(win)
        clear()
      })
      win.webContents.on('dom-ready', () => reloading.delete(win))
      win.once('closed', clear)
    }
    return host.getState(win, id)
  })
  function cookieContext(event: IpcMainInvokeEvent, id: string): () => string {
    owner(event, id)
    // Revalidate after every asynchronous read/write so a reload/close cannot authorize late imports.
    return () => host.getState(owner(event, id), id).url
  }
  ipcMain.handle('browser:list-cookie-sources', (event, id: string) => cookies.list(cookieContext(event, id)))
  ipcMain.handle('browser:preview-cookies', (event, id: string, sourceId: string, scope: BrowserCookieScope) => cookies.preview(cookieContext(event, id), sourceId, scope))
  ipcMain.handle('browser:import-cookies', (event, id: string, sourceId: string, scope: BrowserCookieScope, expectedSite: string | null) => cookies.import(cookieContext(event, id), sourceId, scope, expectedSite))
  ipcMain.handle('browser:clear-site-cookies', (event, id: string, expectedSite: string) => cookies.clear(cookieContext(event, id), expectedSite))
  ipcMain.handle('browser:get-state', (event, id: string) => host.getState(owner(event, id), id))
  ipcMain.handle('browser:navigate', (event, id: string, url: string) => host.navigate(owner(event, id), id, url))
  ipcMain.handle('browser:back', (event, id: string) => host.history(owner(event, id), id, 'back'))
  ipcMain.handle('browser:forward', (event, id: string) => host.history(owner(event, id), id, 'forward'))
  ipcMain.handle('browser:reload', (event, id: string) => host.history(owner(event, id), id, 'reload'))
  ipcMain.handle('browser:set-bounds', (event, id: string, bounds: BrowserBounds | null) => {
    // Cleanup can arrive after the tab closed; hiding never creates a page or crosses windows.
    if (bounds === null) {
      const win = ui(event, id)
      if (owners.has(id) && owners.get(id) !== win) throw new Error('Browser pane belongs to another window')
      return host.setBounds(win, id, null)
    }
    return host.setBounds(owner(event, id), id, bounds)
  })
  ipcMain.handle('browser:set-selecting', (event, id: string, selecting: boolean, options?: BrowserPickerOptions) => host.setSelecting(owner(event, id), id, selecting, options))
  ipcMain.handle('browser:remove-annotations', (event, id: string, ids: string[]) => host.removeAnnotations(owner(event, id), id, ids))
  ipcMain.handle('browser:capture', (event, id: string) => host.capture(owner(event, id), id))
  ipcMain.handle('browser:snapshot', (event, id: string) => host.snapshot(owner(event, id), id))
  function currentUrl(event: IpcMainInvokeEvent, id: string): string {
    const url = host.getState(owner(event, id), id).url
    if (!isBrowserUrl(url)) throw new Error('No HTTP(S) page is open')
    return url
  }
  ipcMain.handle('browser:copy-url', (event, id: string) => clipboard.writeText(currentUrl(event, id)))
  ipcMain.handle('browser:open-external', (event, id: string) => shell.openExternal(currentUrl(event, id)))
  ipcMain.handle('browser:release-agent', (event, id: string) => host.setAgent(owner(event, id), id, null))
  ipcMain.handle('browser:agent-open-answer', (event, requestId: string, result: { browserId: string } | { error: string }) => {
    const win = windowForEvent(event)
    assertBrowserSender(event, win)
    const pending = typeof requestId === 'string' ? pendingOpens.get(requestId) : undefined
    if (!pending || pending.win !== win) throw new Error('Unknown browser open request')
    if (result && typeof result === 'object' && 'error' in result && typeof result.error === 'string') {
      pending.settle({ error: result.error.slice(0, 1000) })
    } else if (result && typeof result === 'object' && 'browserId' in result && typeof result.browserId === 'string'
      && (pending.browserId === undefined || result.browserId === pending.browserId)
      && (owners.get(result.browserId) === win || (pending.action === 'close' && !owners.has(result.browserId)))) {
      if (!sessions?.isSessionLive(pending.sessionId) || sessions.sessionWindow(pending.sessionId) !== win) {
        pending.fail(new Error('The requesting session is no longer open'))
      } else if (pending.action === 'activate' && host.agentOf(win, result.browserId) !== pending.sessionId) {
        pending.fail(new Error('Browser control was released or transferred'))
      } else {
        pending.settle({ browserId: result.browserId })
      }
    } else {
      pending.fail(new Error('Invalid browser open answer'))
      throw new Error('Invalid browser open answer')
    }
  })
  ipcMain.handle('browser:inspect', (event, id: string) => host.inspect(owner(event, id), id))
  ipcMain.handle('browser:close', (event, id: string) => {
    const win = ui(event, id)
    if (owners.has(id) && owners.get(id) !== win) throw new Error('Browser pane belongs to another window')
    host.close(win, id)
    owners.delete(id)
  })
}
