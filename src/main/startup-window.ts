/**
 * The startup screen is a sandboxed, API-free view layered over the main window itself, so the
 * window opens at its real size and the app is revealed in place. The view stays until the
 * renderer reports its workspace restore settled (`window:startup-ready`), then fades out.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WebContentsView, type BrowserWindow } from 'electron'
import type { SurfaceStyle } from '../shared/api'
import { parseSurfaceStyle } from '../shared/surface-style'
import { readStartupBlueprintSync } from './startup-blueprint'
import {
  STARTUP_EXIT_MS,
  STARTUP_EXIT_SCRIPT,
  startupScreenHtml,
  startupSurfaceScript,
  type StartupSceneConfig
} from './startup-screen'
import { supportsGlass } from './surface-support'

/** Bounds a renderer that never reports ready; the screen must not cover the app for good. */
const READY_TIMEOUT_MS = 10_000

export interface StartupScreen {
  /** Settles once the screen has loaded, so the window can be shown without an empty frame. */
  ready: Promise<void>
  dismiss: () => void
  setSurfaceStyle?: (style: SurfaceStyle) => void
}

function readJsonHint(dir: string, file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * Best-effort read of persisted layout/surface hints + last-frame geometry blueprint so the startup
 * skeleton opens with 1:1 aligned column geometry, material (`glass` vs `solid`), and placeholder
 * coordinates from frame zero.
 */
function readInitialSceneConfig(): StartupSceneConfig {
  const defaultSurface = parseSurfaceStyle(undefined, supportsGlass)
  const dir = process.env.PIG_DIR
  if (!dir) return { surfaceStyle: defaultSurface }

  const settings = readJsonHint(dir, 'settings.json')
  const sidebar = readJsonHint(dir, 'sidebar.json')
  const sessions = readJsonHint(dir, 'open-project-sessions.json')
  const blueprint = readStartupBlueprintSync(dir)

  const surfaceStyle = parseSurfaceStyle(settings?.surfaceStyle, supportsGlass)
  const lightTheme = settings?.lightTheme === 'everforest' ? 'everforest' : 'pig'
  const darkTheme = settings?.darkTheme === 'everforest' ? 'everforest' : 'pig'
  const sidebarTab = sidebar?.sidebarTab === 'chats' || sidebar?.sidebarTab === 'kanban'
    ? sidebar.sidebarTab
    : 'projects'
  const currentCwd = typeof sessions?.currentCwd === 'string' ? sessions.currentCwd : null
  const hasWorkspace = sidebarTab === 'chats' || (sidebarTab === 'projects' && Boolean(currentCwd && existsSync(currentCwd)))
  const rightOpen = blueprint ? blueprint.rightOpen : Boolean(sidebar?.reviewOpen && hasWorkspace)
  const leftOpen = blueprint ? blueprint.leftOpen : true

  return { surfaceStyle, leftOpen, rightOpen, lightTheme, darkTheme, blueprint }
}

export function attachStartupScreen(window: BrowserWindow): StartupScreen {
  const initialConfig = readInitialSceneConfig()
  let surfaceStyle = initialConfig.surfaceStyle ?? parseSurfaceStyle(undefined, supportsGlass)
  const html = startupScreenHtml({ ...initialConfig, surfaceStyle })
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
  let hiddenCssKey: Promise<string> | undefined

  // Keep `[data-app-surface]` invisible behind the translucent glass skeleton while stores hydrate,
  // and suppress sidebar width transitions so columns settle instantaneously before reveal.
  const hideAppWhileCovered = () => {
    if (dismissed || typeof window.webContents.insertCSS !== 'function') return
    hiddenCssKey = window.webContents.insertCSS(
      '[data-workspace-left-rail],[data-workspace-right-rail],[data-header-leading],[data-content-surface]{transition: none !important;}' +
      '[data-app-surface]{opacity: 0 !important;}'
    ).catch(() => '')
  }
  const revealApp = async () => {
    const pending = hiddenCssKey
    hiddenCssKey = undefined
    if (!pending || window.isDestroyed() || window.webContents.isDestroyed()) return
    const key = await pending
    if (key && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      await window.webContents.removeInsertedCSS(key).catch(() => {})
    }
  }
  window.webContents.on('did-navigate', hideAppWhileCovered)

  const closeContents = () => {
    dismissed = true
    clearTimeout(timeout)
    window.webContents.off('did-navigate', hideAppWhileCovered)
    if (!contents.isDestroyed()) contents.close()
  }
  const remove = () => {
    clearTimeout(timeout)
    window.off('resize', fit)
    window.off('closed', closeContents)
    window.webContents.off('did-navigate', hideAppWhileCovered)
    if (!window.isDestroyed()) window.contentView.removeChildView(view)
    if (!contents.isDestroyed()) contents.close()
  }
  const runExit = () => {
    if (contents.isDestroyed()) {
      remove()
      return
    }
    void contents.executeJavaScript(STARTUP_EXIT_SCRIPT)
      .catch((error: unknown) => console.error('Startup screen exit failed:', error))
      .finally(() => setTimeout(remove, STARTUP_EXIT_MS))
  }
  const dismiss = () => {
    if (dismissed) return
    dismissed = true
    window.webContents.off('did-navigate', hideAppWhileCovered)
    // Focus moves while the screen still covers the app, so any focus restyle is hidden by it.
    if (!window.isDestroyed()) window.webContents.focus()
    if (hiddenCssKey) void revealApp().finally(runExit)
    else runExit()
  }

  const setSurfaceStyle = (next: SurfaceStyle) => {
    const resolved = parseSurfaceStyle(next, supportsGlass)
    if (resolved === surfaceStyle) return
    surfaceStyle = resolved
    if (!dismissed && !contents.isDestroyed()) {
      void contents.executeJavaScript(startupSurfaceScript(resolved)).catch(() => {})
    }
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
  })
  void contents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(reject => {
    if (!dismissed) console.error('Startup screen failed to load:', reject)
  })
  return { ready, dismiss, setSurfaceStyle }
}
