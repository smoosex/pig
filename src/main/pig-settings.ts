import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { pigDir, pigPath } from './pig-dir'

export type SendShortcut = 'enter' | 'shift-enter'

export interface PigSettings {
  sendShortcut: SendShortcut
}

const defaults: PigSettings = {
  sendShortcut: 'enter'
}

function filePath(): string {
  return pigPath('settings.json')
}

function parseShortcut(value: unknown): SendShortcut {
  return value === 'shift-enter' ? 'shift-enter' : 'enter'
}

export async function loadPigSettings(): Promise<PigSettings> {
  try {
    const data = JSON.parse(await readFile(filePath(), 'utf8')) as Partial<PigSettings>
    return { sendShortcut: parseShortcut(data.sendShortcut) }
  } catch {
    return { ...defaults }
  }
}

export async function savePigSettings(patch: Partial<PigSettings>): Promise<PigSettings> {
  const current = await loadPigSettings()
  const next: PigSettings = {
    sendShortcut: patch.sendShortcut === undefined ? current.sendShortcut : parseShortcut(patch.sendShortcut)
  }
  await mkdir(pigDir(), { recursive: true })
  await writeFile(filePath(), `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`)
  return next
}
