import { join } from 'node:path'

export function pigDir(): string {
  if (process.env.PIG_DIR) return process.env.PIG_DIR
  return join(process.cwd(), '.pig')
}

export function pigPath(...parts: string[]): string {
  return join(pigDir(), ...parts)
}
