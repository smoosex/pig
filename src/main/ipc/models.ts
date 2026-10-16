import { BrowserWindow, ipcMain } from 'electron'
import { getScopedModels, setScopedModels } from '../pi/scoped-models'
import { currentModelCatalog, refreshModelCatalog } from '../pi/model-catalog'

/**
 * The model catalog is app-wide state, not a session's: these handlers are the only way a picker
 * learns about a new provider, and `refreshModelCatalog()` pushes the result to every window
 * including the caller's, so a reply and a push never disagree about which revision is current.
 */
export function registerModelIpc(): void {
  ipcMain.handle('models:get-scoped', () => getScopedModels())
  ipcMain.handle('models:set-scoped', async (_event, patterns: string[]) => {
    await setScopedModels(patterns)
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('models:scope-changed')
      }
    }
  })
  ipcMain.handle('models:get-catalog', () => currentModelCatalog())
  ipcMain.handle('models:refresh-catalog', () => refreshModelCatalog())
}

export { startModelCatalog } from '../pi/model-catalog'
