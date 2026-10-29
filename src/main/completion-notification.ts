/** Desktop notifications belong to main; the renderer only receives a click target. */
import { Notification, type BrowserWindow } from 'electron'
import { t } from './i18n'
import { loadPigSettings } from './pig-settings'
import { focusNotifiedSession, isNotificationSessionVisible } from './completion-visibility'

// Keep native notifications alive until dismissed; macOS removes them when the object is collected.
const activeNotifications = new Set<Notification>()

export async function sendCompletionNotification(
  sessionId: string,
  win: BrowserWindow,
  signal: AbortSignal,
  content: { title: string; reply: string }
): Promise<void> {
  if (signal.aborted || win.isDestroyed() || isNotificationSessionVisible(win, sessionId) || !Notification.isSupported()) return
  if (!(await loadPigSettings()).completionNotifications) return
  if (signal.aborted || win.isDestroyed() || win.webContents.isDestroyed() || isNotificationSessionVisible(win, sessionId)) return

  const body = content.reply.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 2).join('\n')
  const notification = new Notification({ title: content.title, body: body || t('notification.replyReady') })
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
    focusNotifiedSession(win, sessionId)
  })
  notification.show()
}
