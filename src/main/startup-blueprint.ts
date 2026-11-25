/**
 * Persists and reads the last settled workspace geometry blueprint (`.pig/startup-blueprint.json`).
 *
 * Kept free of top-level `electron` imports so `startup-window` and standalone unit tests can load
 * it before or outside an Electron main runtime.
 */
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { parseStartupBlueprint, type StartupBlueprint } from '../shared/startup-blueprint'
import { writeFileAtomic } from './atomic-write'

const FILE_NAME = 'startup-blueprint.json'

let writeQueue: Promise<void> = Promise.resolve()

async function resolveDataDir(): Promise<string> {
  if (process.env.PIG_DIR) return process.env.PIG_DIR
  const { pigDir } = await import('./pig-dir')
  return pigDir()
}

export function readStartupBlueprintSync(dir: string): StartupBlueprint | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dir, FILE_NAME), 'utf8'))
    return parseStartupBlueprint(raw)
  } catch {
    return null
  }
}

export function saveStartupBlueprint(raw: unknown): Promise<void> {
  const parsed = parseStartupBlueprint(raw)
  if (!parsed) return Promise.resolve()
  const next = writeQueue.then(async () => {
    const dir = await resolveDataDir()
    await mkdir(dir, { recursive: true })
    await writeFileAtomic(join(dir, FILE_NAME), `${JSON.stringify(parsed)}\n`)
  })
  writeQueue = next.catch(() => {})
  return next
}

export async function flushStartupBlueprint(): Promise<void> {
  await writeQueue
}
