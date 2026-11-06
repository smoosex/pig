/** UI and Agent configuration writes share cancellation, notifications and idle application. */
import { BrowserWindow } from 'electron'
import { notifyPersonaControlsChanged } from './persona/controls'
import { refreshConversationFeatures } from '../pi/session-registry'

export async function applyConversationFeatures(): Promise<void> {
  notifyPersonaControlsChanged()
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('conversation-features:changed')
  }
  await refreshConversationFeatures()
}
