/** Platform-specific icon option for Electron desktop notifications. */
import * as electron from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const mainDirectory = dirname(fileURLToPath(import.meta.url))

// macOS and Windows resolve the sender icon from the registered app bundle / AUMID; passing
// options.icon on macOS adds a right-side content thumbnail instead of replacing the app icon.
export function notificationIconOption(
  platform: NodeJS.Platform = process.platform
): { icon?: string } {
  if (platform !== 'linux') return {}
  return {
    icon: electron.app?.isPackaged
      ? join(process.resourcesPath, 'icon.png')
      : join(mainDirectory, '../../build/icon.png')
  }
}
