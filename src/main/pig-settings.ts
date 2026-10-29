import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
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
  approvalNotifications: boolean
  beamBorderEnabled: boolean
  locale: LocaleSetting
}

const defaults: PigSettings = {
  sendShortcut: 'enter',
  shortcuts: {},
  completionNotifications: true,
  approvalNotifications: true,
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
    approvalNotifications: data?.approvalNotifications !== false,
    beamBorderEnabled: data?.beamBorderEnabled !== false,
    locale: parseLocaleSetting(data?.locale),
    appearance: parseAppearance(data?.appearance),
    surfaceStyle: parseSurfaceStyle(data?.surfaceStyle, supportsGlass),
    lightTheme: parsePalette(data?.lightTheme),
    darkTheme: parsePalette(data?.darkTheme)
  }
}

async function readSettings(path: string, strict = false): Promise<PigSettings> {
  try {
    const data: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid Pig settings object')
    return normalize(data)
  } catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { ...defaults }
  }
}

let mutationQueue: Promise<void> = Promise.resolve()

export async function loadPigSettings(strict = false): Promise<PigSettings> {
  await mutationQueue
  return readSettings(filePath(), strict)
}

export function savePigSettings(patch: Partial<PigSettings>): Promise<PigSettings> {
  return updatePigSettings(() => patch)
}

/** For patches computed from the current file; `update` runs inside the queue and may throw to abort. */
export function updatePigSettings(update: (current: PigSettings) => Partial<PigSettings>): Promise<PigSettings> {
  const path = filePath()
  // Independent controls share this file, so serialize the entire read/merge/write.
  const result = mutationQueue.then(async () => {
    const current = await readSettings(path, true)
    const next = normalize({ ...current, ...update(current) })
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, path)
    } finally {
      await rm(temp, { force: true })
    }
    return next
  })
  mutationQueue = result.then(() => undefined, () => undefined)
  return result
}
