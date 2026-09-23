import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { createMainWindow } from './window'
import { registerIpc } from './ipc'
import { initLocale } from './i18n'
import { loadPigSettings } from './pig-settings'
import { forwardSessionNames } from './session-names'
import { disposeAll } from './pi/session-registry'
import { startModelRuntime } from './pi/model-settings'
import { worktrees } from './project-worktrees'
import { handleSessionImages, registerSessionImageScheme } from './session-image-protocol'
import { flushOpenProjectSessions } from './open-project-sessions'

// The renderer loads persisted images through this scheme, so it must be granted before ready.
registerSessionImageScheme()

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('dev.pig.desktop')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  handleSessionImages()
  void startModelRuntime().catch((error) => console.error('Model runtime initialization failed:', error))
  registerIpc()
  await initLocale((await loadPigSettings()).locale)
  forwardSessionNames()
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let isDisposing = false

// Teardown waits on sessions and naming jobs, and any of them can stay pending: a turn that never
// settles, a build still starting, a hook nobody answers. The quit must not inherit that, so the
// chain is raced against a deadline and the process exits on its own terms.
const QUIT_DEADLINE_MS = 5_000

app.on('before-quit', (event) => {
  if (isDisposing) return
  event.preventDefault()
  isDisposing = true
  const teardown = Promise.allSettled([worktrees.shutdown(), flushOpenProjectSessions()])
    .then(() => disposeAll())
    .catch(() => {})
  void Promise.race([teardown, new Promise((resolve) => setTimeout(resolve, QUIT_DEADLINE_MS))])
    .finally(() => app.exit(0))
})
