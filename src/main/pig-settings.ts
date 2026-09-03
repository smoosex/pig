import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { pigDir, pigPath } from './pig-dir'

export type SendShortcut = 'enter' | 'shift-enter'
export type Appearance = 'system' | 'light' | 'dark'
export type PaletteId = 'pig' | 'everforest'

export interface PigSettings {
  sendShortcut: SendShortcut
  appearance: Appearance
  lightTheme: PaletteId
  darkTheme: PaletteId
}

const defaults: PigSettings = {
  sendShortcut: 'enter',
  appearance: 'system',
  lightTheme: 'pig',
  darkTheme: 'pig'
}

function filePath(): string {
  return pigPath('settings.json')
}

function parseShortcut(value: unknown): SendShortcut {
  return value === 'shift-enter' ? 'shift-enter' : 'enter'
}

function parseAppearance(value: unknown): Appearance {
  return value === 'light' || value === 'dark' ? value : 'system'
}

function parsePalette(value: unknown): PaletteId {
  return value === 'everforest' ? 'everforest' : 'pig'
}

function normalize(data: Partial<PigSettings> | null | undefined): PigSettings {
  return {
    sendShortcut: parseShortcut(data?.sendShortcut),
    appearance: parseAppearance(data?.appearance),
    lightTheme: parsePalette(data?.lightTheme),
    darkTheme: parsePalette(data?.darkTheme)
  }
}

export async function loadPigSettings(): Promise<PigSettings> {
  try {
    const data = JSON.parse(await readFile(filePath(), 'utf8')) as Partial<PigSettings>
    return normalize(data)
  } catch {
    return { ...defaults }
  }
}

export async function savePigSettings(patch: Partial<PigSettings>): Promise<PigSettings> {
  const current = await loadPigSettings()
  const next = normalize({ ...current, ...patch })
  await mkdir(pigDir(), { recursive: true })
  await writeFile(filePath(), `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`)
  return next
}
