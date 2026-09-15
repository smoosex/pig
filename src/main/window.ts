import { BrowserWindow, shell } from 'electron'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { is } from '@electron-toolkit/utils'
import { createAppUrlCheck, installNavigationGuard } from './app-url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** External links belong in the user's browser; anything else would run outside the app's UI. */
const EXTERNAL_PROTOCOLS = ['http:', 'https:', 'mailto:']

function resolvePreload(): string {
  const preloadDir = join(__dirname, '../preload')
  for (const ext of ['.js', '.mjs', '.cjs']) {
    const candidate = join(preloadDir, 'index' + ext)
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`preload entry not found under ${preloadDir}`)
}

export function createMainWindow(): BrowserWindow {
  const rendererHtml = join(__dirname, '../renderer/index.html')
  const devServer = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
  const isAppUrl = createAppUrlCheck({ devServer, rendererHtml })
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    autoHideMenuBar: true,
    title: 'Pig',
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 14 },
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: resolvePreload(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('page-title-updated', (event) => event.preventDefault())
  mainWindow.on('ready-to-show', () => mainWindow.show())

  // The preload bridge is attached to whatever document this window shows, so navigation is limited
  // to the app itself.
  installNavigationGuard(mainWindow.webContents, isAppUrl)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (EXTERNAL_PROTOCOLS.includes(new URL(details.url).protocol)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (devServer) {
    void mainWindow.loadURL(devServer)
  } else {
    void mainWindow.loadFile(rendererHtml)
  }

  return mainWindow
}
