import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { createMainWindow } from './window'
import { registerIpc } from './ipc'
import { disposeAll } from './pi/session-registry'
import { startModelRuntime } from './pi/model-settings'
import { worktrees } from './project-worktrees'
import { handleSessionImages, registerSessionImageScheme } from './session-image-protocol'

// The renderer loads persisted images through this scheme, so it must be granted before ready.
registerSessionImageScheme()

app.whenReady().then(() => {
  electronApp.setAppUserModelId('dev.pig.desktop')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  handleSessionImages()
  void startModelRuntime().catch((error) => console.error('Model runtime initialization failed:', error))
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
  void worktrees.shutdown()
    .finally(() => disposeAll())
    .catch(() => {})
    .finally(() => app.quit())
})
