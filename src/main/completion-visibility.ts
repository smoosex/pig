/** Per-window visible sessions; discard renderer snapshots when its document goes away. */
import type { BrowserWindow } from 'electron'

const visibleSessions = new WeakMap<BrowserWindow, Set<string>>()
const listeners = new Set<(win: BrowserWindow) => void>()

export function setVisibleNotificationSessions(win: BrowserWindow, sessionIds: string[]): void {
  if (!visibleSessions.has(win)) {
    const clear = () => visibleSessions.get(win)?.clear()
    win.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) clear()
    })
    win.webContents.on('render-process-gone', clear)
  }
  visibleSessions.set(win, new Set(sessionIds))
  for (const listener of listeners) listener(win)
}

export function isNotificationSessionVisible(win: BrowserWindow, sessionId: string): boolean {
  return win.isFocused() && (visibleSessions.get(win)?.has(sessionId) ?? false)
}

/** Reported tab changes only; window focus is the listener's own concern. */
export function onNotificationVisibilityChange(listener: (win: BrowserWindow) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function focusNotifiedSession(win: BrowserWindow, sessionId: string): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  win.webContents.send('notification:click', sessionId)
}
