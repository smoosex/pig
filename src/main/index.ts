import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { createMainWindow } from './window'
import { registerIpc } from './ipc'
import { disposeAll, startModelRuntime } from './pi/session-registry'

app.whenReady().then(() => {
  electronApp.setAppUserModelId('dev.pig.desktop')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  void startModelRuntime()
  registerIpc()
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let isDisposing = false

app.on('before-quit', (event) => {
  if (isDisposing) return
  event.preventDefault()
  isDisposing = true
  void disposeAll()
    .catch(() => {})
    .finally(() => app.quit())
})
