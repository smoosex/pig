import { BrowserWindow } from 'electron'
import { onSessionNamesResolved } from './pi/session-loader'

/**
 * A session's name can sit megabytes past the prefix its listing reads, so it is found after that
 * listing was answered. Every window that already rendered the row gets the name as soon as it is
 * known; a session no window lists is simply ignored there.
 */
export function forwardSessionNames(): void {
  onSessionNamesResolved((updates) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('session:names', updates)
      }
    }
  })
}
