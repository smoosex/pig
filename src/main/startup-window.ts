/**
 * The startup screen is a sandboxed, API-free view layered over the main window itself, so the
 * window opens at its real size and the app is revealed in place. The view stays until the
 * renderer reports its workspace restore settled (`window:startup-ready`), then fades out.
 */
import { WebContentsView, type BrowserWindow } from 'electron'
import { STARTUP_EXIT_MS, STARTUP_EXIT_SCRIPT, startupScreenHtml } from './startup-screen'

/** Bounds a renderer that never reports ready; the screen must not cover the app for good. */
const READY_TIMEOUT_MS = 10_000

export interface StartupScreen {
  /** Settles once the screen has loaded, so the window can be shown without an empty frame. */
  ready: Promise<void>
  dismiss: () => void
}

export function attachStartupScreen(window: BrowserWindow): StartupScreen {
  const html = startupScreenHtml()
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false }
  })
  // The view drops its `webContents` getter once they are destroyed; keep the reference.
  const contents = view.webContents
  view.setBackgroundColor('#00000000')
  const fit = () => {
    const [width, height] = window.getContentSize()
    view.setBounds({ x: 0, y: 0, width, height })
  }
  fit()
  window.on('resize', fit)
  window.contentView.addChildView(view)

  let dismissed = false
  let timeout: NodeJS.Timeout | undefined
  const closeContents = () => {
    dismissed = true
    clearTimeout(timeout)
    if (!contents.isDestroyed()) contents.close()
  }
  const remove = () => {
    clearTimeout(timeout)
    window.off('resize', fit)
    window.off('closed', closeContents)
    if (!window.isDestroyed()) window.contentView.removeChildView(view)
    if (!contents.isDestroyed()) contents.close()
  }
  const dismiss = () => {
    if (dismissed) return
    dismissed = true
    // Focus moves while the screen still covers the app, so any focus restyle is hidden by it.
    if (!window.isDestroyed()) window.webContents.focus()
    void contents.executeJavaScript(STARTUP_EXIT_SCRIPT)
      .catch((error: unknown) => console.error('Startup screen exit failed:', error))
      .finally(() => setTimeout(remove, STARTUP_EXIT_MS))
  }

  window.webContents.ipc.on('window:startup-ready', (event) => {
    if (event.senderFrame === window.webContents.mainFrame) dismiss()
  })
  window.webContents.once('did-finish-load', () => {
    timeout = setTimeout(dismiss, READY_TIMEOUT_MS)
  })
  // A failed app load never reports ready nor finishes loading; uncover its error page instead.
  // ERR_ABORTED (-3) is a navigation replaced by another, not a failure.
  window.webContents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) dismiss()
  })
  window.once('closed', closeContents)

  const ready = new Promise<void>((resolve, reject) => {
    contents.once('did-finish-load', () => resolve())
    window.once('closed', () => reject(new Error('Main window closed before the startup screen loaded')))
    void contents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(reject)
  })
  return { ready, dismiss }
}
