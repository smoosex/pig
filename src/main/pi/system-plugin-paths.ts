/** Shared identity of built-in tools whose source is checked at a permission boundary. */
import { app } from 'electron'
import { join } from 'node:path'

export function settingsToolPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'system-plugins', 'pig-settings', 'index.ts')
    : join(app.getAppPath(), 'src', 'main', 'plugins', 'pig-settings', 'index.ts')
}
