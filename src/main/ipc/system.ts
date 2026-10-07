import { dialog, ipcMain } from 'electron'
import { loadSidebarPrefs, saveSidebarPrefs, type SidebarPrefs } from '../sidebar-prefs'
import {
  loadOpenProjectSessions,
  saveOpenChatTabs,
  saveOpenProjectChangesTab,
  saveOpenProjectTabOrder,
  selectOpenProjectWorkspace
} from '../open-project-sessions'
import { windowForEvent } from './window'

export function registerSystemIpc(): void {
  ipcMain.handle('system:get-sidebar-prefs', async () => loadSidebarPrefs())
  ipcMain.handle('system:set-sidebar-prefs', async (_event, patch: Partial<SidebarPrefs>) =>
    saveSidebarPrefs(patch ?? {})
  )
  ipcMain.handle('system:get-open-project-sessions', async () => loadOpenProjectSessions())
  ipcMain.handle(
    'system:select-open-project-workspace',
    async (_event, cwd: string, sessionId: string | null, activeTabId: string | null) =>
      selectOpenProjectWorkspace(cwd, sessionId, activeTabId)
  )
  ipcMain.handle(
    'system:save-open-project-changes-tab',
    async (_event, cwd: string, open: boolean, activeTabId: string | null) =>
      saveOpenProjectChangesTab(cwd, open, activeTabId)
  )
  ipcMain.handle(
    'system:save-open-project-tab-order',
    async (_event, cwd: string, tabIds: string[]) => saveOpenProjectTabOrder(cwd, tabIds)
  )
  ipcMain.handle(
    'system:save-open-chat-tabs',
    async (_event, tabIds: string[], activeTabId: string | null) =>
      saveOpenChatTabs(tabIds, activeTabId)
  )
  ipcMain.handle('system:pick-directory', async (event) => {
    const win = windowForEvent(event)
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}
