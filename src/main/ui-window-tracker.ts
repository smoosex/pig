/**
 * The UI windows that subscribed to a main-initiated request (settings surface handoff, quit prompt).
 * A window drops out when it closes, its renderer dies, or its main frame starts a cross-document
 * navigation: none of those can answer any more, so the owner is told to settle what it still holds.
 */
import type { BrowserWindow } from 'electron'

export class UiWindowTracker {
  private readonly ready = new Set<BrowserWindow>()
  private readonly watched = new WeakSet<BrowserWindow>()

  constructor(private readonly onInvalidate: (win: BrowserWindow) => void) {}

  add(win: BrowserWindow): void {
    this.ready.add(win)
    if (this.watched.has(win)) return
    this.watched.add(win)
    const invalidate = () => this.remove(win)
    win.once('closed', invalidate)
    win.webContents.on('render-process-gone', invalidate)
    win.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) invalidate()
    })
  }

  remove(win: BrowserWindow): void {
    this.ready.delete(win)
    this.onInvalidate(win)
  }

  has(win: BrowserWindow): boolean {
    return this.ready.has(win) && isLive(win)
  }

  windows(): BrowserWindow[] {
    return [...this.ready].filter(isLive)
  }
}

export function isLive(win: BrowserWindow): boolean {
  return !win.isDestroyed() && !win.webContents.isDestroyed()
}
