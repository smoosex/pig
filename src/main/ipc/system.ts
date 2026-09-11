import { dialog, ipcMain } from 'electron'
import { loadSidebarPrefs, saveSidebarPrefs, type SidebarPrefs } from '../sidebar-prefs'
import { windowForEvent } from './window'

export function registerSystemIpc(): void {
  ipcMain.handle('system:get-sidebar-prefs', async () => loadSidebarPrefs())
  ipcMain.handle('system:set-sidebar-prefs', async (_event, patch: Partial<SidebarPrefs>) =>
    saveSidebarPrefs(patch ?? {})
  )

  ipcMain.handle('system:pick-directory', async (event) => {
    const win = windowForEvent(event)
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}
