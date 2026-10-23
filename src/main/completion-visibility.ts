/** Per-window visible sessions; discard renderer snapshots when its document goes away. */
import type { BrowserWindow } from 'electron'

const visibleSessions = new WeakMap<BrowserWindow, Set<string>>()

export function setVisibleNotificationSessions(win: BrowserWindow, sessionIds: string[]): void {
  if (!visibleSessions.has(win)) {
    const clear = () => visibleSessions.get(win)?.clear()
    win.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) clear()
    })
    win.webContents.on('render-process-gone', clear)
  }
  visibleSessions.set(win, new Set(sessionIds))
}

export function isNotificationSessionVisible(win: BrowserWindow, sessionId: string): boolean {
  return win.isFocused() && (visibleSessions.get(win)?.has(sessionId) ?? false)
}
