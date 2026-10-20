/** Independent browser panes belong to the creating UI window, never to a Pi session or page guest. */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clipboard, shell, ipcMain, session, WebContentsView, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { BrowserHost } from '../browser/host'
import { BrowserCookieImporter } from '../browser/cookies/importer'
import { assertBrowserSender, isBrowserUrl } from '../browser/validation'
import { windowForEvent } from './window'
import type { BrowserBounds, BrowserPickerOptions, BrowserCookieScope } from '../../shared/browser'

export function registerBrowserIpc(): void {
  const owners = new Map<string, BrowserWindow>()
  const watched = new WeakSet<BrowserWindow>()
  const reloading = new WeakSet<BrowserWindow>()
  const cookies = new BrowserCookieImporter(session.fromPartition('persist:pig-browser').cookies)
  // DevTools front-end gets a default sandboxed view; only the inspected page uses the guest preload.
  const host = new BrowserHost((kind) => kind === 'devtools' ? new WebContentsView() : new WebContentsView({ webPreferences: {
    preload: join(dirname(fileURLToPath(import.meta.url)), '../preload/browser-guest.cjs'),
    partition: 'persist:pig-browser', sandbox: true, contextIsolation: true,
    nodeIntegration: false, webSecurity: true, webviewTag: false
  } }))
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
  ipcMain.handle('browser:inspect', (event, id: string) => host.inspect(owner(event, id), id))
  ipcMain.handle('browser:close', (event, id: string) => {
    const win = ui(event, id)
    if (owners.has(id) && owners.get(id) !== win) throw new Error('Browser pane belongs to another window')
    host.close(win, id)
    owners.delete(id)
  })
}
