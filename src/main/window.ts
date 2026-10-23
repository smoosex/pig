import { BrowserWindow, shell } from 'electron'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { is } from '@electron-toolkit/utils'
import { createAppUrlCheck, installNavigationGuard } from './app-url'
import { supportsGlass } from './surface-support'
import { windowSurfaceOptions } from './window-surface'
import { GLASS_SURFACE_ARGUMENT } from '../shared/surface-style'

const mainDirectory = dirname(fileURLToPath(import.meta.url))

/** External links belong in the user's browser; anything else would run outside the app's UI. */
const EXTERNAL_PROTOCOLS = ['http:', 'https:', 'mailto:']

function resolvePreload(): string {
  const preloadDir = join(mainDirectory, '../preload')
  for (const ext of ['.js', '.mjs', '.cjs']) {
    const candidate = join(preloadDir, 'index' + ext)
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`preload entry not found under ${preloadDir}`)
}

export function createMainWindow(): BrowserWindow {
  const rendererHtml = join(mainDirectory, '../renderer/index.html')
  const devServer = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
  const isAppUrl = createAppUrlCheck({ devServer, rendererHtml })
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    // The header tab strip reserves 256px per side (inset-x-64); below 800px less than one full tab would remain.
    minWidth: 800,
    show: false,
    autoHideMenuBar: true,
    title: 'Pig',
    icon: process.platform === 'linux'
      ? is.dev ? join(mainDirectory, '../../build/icon.png') : join(process.resourcesPath, 'icon.png')
      : undefined,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 14 },
    ...windowSurfaceOptions(),
    webPreferences: {
      preload: resolvePreload(),
      additionalArguments: supportsGlass ? [GLASS_SURFACE_ARGUMENT] : [],
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
