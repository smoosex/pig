/**
 * Safe main-to-renderer broadcast helpers that check both `WebContents` and `mainFrame` liveness.
 * During reload or window teardown, `webContents.isDestroyed()` can still be false while `mainFrame`
 * has already been disposed (`null` or `isDestroyed()`), where `webContents.send()` would throw.
 */
import * as electron from 'electron'

export function canSendToWindow(win: electron.BrowserWindow | null | undefined): win is electron.BrowserWindow {
  if (!win || win.isDestroyed()) return false
  const contents = win.webContents
  if (!contents || contents.isDestroyed()) return false
  if ('mainFrame' in contents) {
    const frame = contents.mainFrame
    if (!frame || frame.isDestroyed()) return false
  }
  return true
}

export function sendToAllWindows(channel: string, ...args: unknown[]): void {
  for (const win of electron.BrowserWindow?.getAllWindows?.() ?? []) {
    if (canSendToWindow(win)) {
      win.webContents.send(channel, ...args)
    }
  }
}
