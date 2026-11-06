import { join } from 'node:path'

export function memoryDataPath(...parts: string[]): string {
  // The extension loader cannot resolve 'electron' from packaged resources, so this module must
  // stay dependency-free. The main process guarantees PIG_DIR before any extension loads.
  const root = process.env.PIG_DIR || join(process.cwd(), '.pig')
  return join(root, 'plugins', 'observational-memory', ...parts)
}

export const memorySettingsPath = (): string => memoryDataPath('settings.json')
