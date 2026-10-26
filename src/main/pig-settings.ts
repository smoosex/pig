import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pigPath } from './pig-dir'
import { supportsGlass } from './surface-support'
import { parseLocaleSetting } from '../shared/i18n'
import { parseSurfaceStyle } from '../shared/surface-style'
import type { Appearance, LocaleSetting, PaletteId, SendShortcut, ThemePrefs } from '../shared/api'
import { parseShortcutOverrides, type ShortcutOverrides } from '../shared/shortcuts'

export type { Appearance, PaletteId, SendShortcut } from '../shared/api'

export interface PigSettings extends ThemePrefs {
  sendShortcut: SendShortcut
  shortcuts: ShortcutOverrides
  completionNotifications: boolean
  beamBorderEnabled: boolean
  locale: LocaleSetting
}

const defaults: PigSettings = {
  sendShortcut: 'enter',
  shortcuts: {},
  completionNotifications: true,
  beamBorderEnabled: true,
  locale: 'system',
  appearance: 'system',
  surfaceStyle: parseSurfaceStyle(undefined, supportsGlass),
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
    shortcuts: parseShortcutOverrides(data?.shortcuts, process.platform === 'darwin'),
    completionNotifications: data?.completionNotifications !== false,
    beamBorderEnabled: data?.beamBorderEnabled !== false,
    locale: parseLocaleSetting(data?.locale),
    appearance: parseAppearance(data?.appearance),
    surfaceStyle: parseSurfaceStyle(data?.surfaceStyle, supportsGlass),
    lightTheme: parsePalette(data?.lightTheme),
    darkTheme: parsePalette(data?.darkTheme)
  }
}

async function readSettings(path: string): Promise<PigSettings> {
  try {
    const data = JSON.parse(await readFile(path, 'utf8')) as Partial<PigSettings>
    return normalize(data)
  } catch {
    return { ...defaults }
  }
}

let mutationQueue: Promise<void> = Promise.resolve()

export async function loadPigSettings(): Promise<PigSettings> {
  await mutationQueue
  return readSettings(filePath())
}

export function savePigSettings(patch: Partial<PigSettings>): Promise<PigSettings> {
  return updatePigSettings(() => patch)
}

/** For patches computed from the current file; `update` runs inside the queue and may throw to abort. */
export function updatePigSettings(update: (current: PigSettings) => Partial<PigSettings>): Promise<PigSettings> {
  const path = filePath()
  // Independent controls share this file, so serialize the entire read/merge/write.
  const result = mutationQueue.then(async () => {
    const current = await readSettings(path)
    const next = normalize({ ...current, ...update(current) })
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`)
    return next
  })
  mutationQueue = result.then(() => undefined, () => undefined)
  return result
}
