import { BrowserWindow, dialog, ipcMain } from 'electron'

export function registerSystemIpc(): void {
  ipcMain.handle('system:pick-directory', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('No window attached to sender')
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}
