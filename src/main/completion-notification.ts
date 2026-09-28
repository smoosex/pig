/** Desktop notifications belong to main; the renderer only receives a click target. */
import { Notification, type BrowserWindow } from 'electron'
import { t } from './i18n'
import { loadPigSettings } from './pig-settings'

// Keep native notifications alive until dismissed; macOS removes them when the object is collected.
const activeNotifications = new Set<Notification>()

export async function sendCompletionNotification(
  sessionId: string,
  win: BrowserWindow,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted || win.isDestroyed() || win.isFocused() || !Notification.isSupported()) return
  if (!(await loadPigSettings()).completionNotifications) return
  if (signal.aborted || win.isDestroyed() || win.webContents.isDestroyed() || win.isFocused()) return

  const notification = new Notification({ title: 'Pig', body: t('notification.replyReady') })
  if (activeNotifications.size >= 32) {
    const oldest = activeNotifications.values().next().value
    if (oldest) activeNotifications.delete(oldest)
  }
  activeNotifications.add(notification)
  notification.once('failed', (_event, error) => {
    activeNotifications.delete(notification)
    console.error('Could not show completion notification:', error)
  })
  notification.once('close', () => activeNotifications.delete(notification))
  notification.once('click', () => {
    activeNotifications.delete(notification)
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send('notification:click', sessionId)
  })
  notification.show()
}
