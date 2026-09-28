import { app } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function memoryDataPath(...parts: string[]): string {
  const root = process.env.PIG_DIR || (app.isPackaged ? join(homedir(), '.pig') : join(process.cwd(), '.pig'))
  return join(root, 'plugins', 'observational-memory', ...parts)
}

export const memorySettingsPath = (): string => memoryDataPath('settings.json')
