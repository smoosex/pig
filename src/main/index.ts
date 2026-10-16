import { app, BrowserWindow, nativeTheme } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { createMainWindow } from './window'
import { applyWindowSurfaceStyle } from './window-surface'
import { registerIpc } from './ipc'
import { initLocale } from './i18n'
import { loadPigSettings } from './pig-settings'
import { forwardSessionNames } from './session-names'
import { closeSessionsForCwd, disposeAll } from './pi/session-registry'
import { removeProjectDir } from './pi/session-loader'
import { startModelRuntime } from './pi/model-settings'
import { startModelCatalog } from './pi/model-catalog'
import { worktrees } from './project-worktrees'
import { handleSessionImages, registerSessionImageScheme } from './session-image-protocol'
import { handleMcpIcons, registerMcpIconScheme } from './mcp/icon-protocol'
import { handleWorktreeFiles, registerWorktreeFileScheme } from './worktree-file-protocol'
import { flushOpenProjectSessions, removeOpenProjectWorkspaces } from './open-project-sessions'
import { pruneEmptyChatDirs } from './chats'
import { pigDir } from './pig-dir'
import { importShellEnvironment } from './shell-env'
import { cancelMcpOperations } from './mcp/manager'
import { flushToolMutations } from './mcp/settings'

// Pig-dir resolution needs Electron, but bundled extensions load through a module loader that
// cannot resolve 'electron'. Publish the resolved directory so extensions stay dependency-free.
process.env.PIG_DIR ??= pigDir()

// A GUI launch inherits launchd's minimal environment, so the user's shell PATH and API keys are
// imported before anything reads process.env. Started here to overlap Electron's own boot.
const shellEnvironment = importShellEnvironment()

// The renderer loads persisted images, cached catalog icons and worktree images for the markdown
// preview through these schemes, so all of them must be granted before ready.
registerSessionImageScheme()
registerMcpIconScheme()
registerWorktreeFileScheme()

// Dev keeps its Electron profile and instance lock beside its project data, separate from the
// packaged app's profile. setPath requires the directory to exist and must precede the lock.
if (!app.isPackaged) {
  const userData = join(app.getAppPath(), '.electron-user-data')
  mkdirSync(userData, { recursive: true })
  app.setPath('userData', userData)
}

// A second copy sharing this profile could sweep the first one's unsent chat. Use app.exit rather
// than app.quit: the latter would run teardown against state this process never loaded.
if (!app.requestSingleInstanceLock()) {
  console.warn('Another Pig is already running; this launch exits.')
  app.exit(0)
}

app.whenReady().then(async () => {
  await shellEnvironment
  electronApp.setAppUserModelId('dev.pig.desktop')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  handleSessionImages()
  handleMcpIcons()
  handleWorktreeFiles()
  // Reads the catalog from disk and refreshes it in the background: the first paint must not wait
  // on the network, but whatever the refresh finds is pushed to the window when it lands.
  void startModelRuntime()
    .then(() => startModelCatalog())
    .catch((error) => console.error('Model runtime initialization failed:', error))
  registerIpc()
  const settings = await loadPigSettings()
  nativeTheme.themeSource = settings.appearance
  applyWindowSurfaceStyle(settings.surfaceStyle)
  await initLocale(settings.locale)
  await worktrees.startDeletionWorker(async (cwd) => {
    await closeSessionsForCwd(cwd)
    await removeProjectDir(cwd)
    await removeOpenProjectWorkspaces([cwd])
  })
  await removeOpenProjectWorkspaces((await worktrees.listDeletions()).map((job) => job.cwd))
  // Before the window can make one: a chat the last run left behind is nobody's.
  await pruneEmptyChatDirs().catch(() => {})
  forwardSessionNames()
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
  // Only an initialized process may create another window or reopen its sessions.
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows()
    if (!window) return void createMainWindow()
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })
}).catch((error: unknown) => {
  // Persistent-state initialization can fail on corrupt JSON or unreadable storage. This process
  // boundary reports a fatal startup failure and exits; it must not expose a partially restored UI.
  console.error('Pig startup failed:', error)
  app.exit(1)
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
  const teardown = Promise.allSettled([
    worktrees.shutdown(),
    flushOpenProjectSessions(),
    cancelMcpOperations(),
    flushToolMutations()
  ])
    .then(() => disposeAll())
    .catch(() => {})
  void Promise.race([
    teardown,
    new Promise((resolve) => setTimeout(resolve, QUIT_DEADLINE_MS))
  ]).finally(() => app.exit(0))
})
