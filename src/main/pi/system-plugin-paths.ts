/** Shared identity of built-in tools whose source is checked at a permission boundary. */
import * as electron from 'electron'
import { join } from 'node:path'

function appRoot(): string {
  return electron.app?.getAppPath?.() ?? process.cwd()
}

export function sessionToolPath(): string {
  return electron.app?.isPackaged
    ? join(process.resourcesPath, 'system-plugins', 'pig-session', 'index.ts')
    : join(appRoot(), 'src', 'main', 'plugins', 'pig-session', 'index.ts')
}

export function settingsToolPath(): string {
  return electron.app?.isPackaged
    ? join(process.resourcesPath, 'system-plugins', 'pig-settings', 'index.ts')
    : join(appRoot(), 'src', 'main', 'plugins', 'pig-settings', 'index.ts')
}

export function kanbanToolPath(): string {
  return electron.app?.isPackaged
    ? join(process.resourcesPath, 'system-plugins', 'pig-kanban', 'index.ts')
    : join(appRoot(), 'src', 'main', 'plugins', 'pig-kanban', 'index.ts')
}
