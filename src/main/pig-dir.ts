import { app } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function pigDir(): string {
  if (process.env.PIG_DIR) return process.env.PIG_DIR
  return app.isPackaged ? join(homedir(), '.pig') : join(process.cwd(), '.pig')
}

export function pigPath(...parts: string[]): string {
  return join(pigDir(), ...parts)
}
