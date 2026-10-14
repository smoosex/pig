import type { Appearance, PaletteId, ThemePrefs } from '../../../shared/api'
import { parseSurfaceStyle } from '../../../shared/surface-style'

export type { Appearance, PaletteId, ThemePrefs } from '../../../shared/api'

const STORAGE_KEY = 'pig.theme'

export function parseAppearance(value: unknown): Appearance {
  return value === 'light' || value === 'dark' ? value : 'system'
}

export function parsePalette(value: unknown): PaletteId {
  return value === 'everforest' ? 'everforest' : 'pig'
}

export function storedThemePrefs(supportsGlass: boolean): ThemePrefs {
  const cached = typeof localStorage === 'undefined'
    ? null
    : JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<ThemePrefs> | null
  return {
    appearance: parseAppearance(cached?.appearance),
    lightTheme: parsePalette(cached?.lightTheme),
    darkTheme: parsePalette(cached?.darkTheme),
    surfaceStyle: parseSurfaceStyle(cached?.surfaceStyle, supportsGlass)
  }
}

export function resolvedScheme(appearance: Appearance): 'light' | 'dark' {
  if (appearance === 'light' || appearance === 'dark') return appearance
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyDocumentTheme(prefs: ThemePrefs): void {
  const scheme = resolvedScheme(prefs.appearance)
  const palette = scheme === 'dark' ? prefs.darkTheme : prefs.lightTheme
  const root = document.documentElement
  root.classList.toggle('dark', scheme === 'dark')
  root.dataset.palette = palette
  root.dataset.surfaceStyle = prefs.surfaceStyle
  root.style.colorScheme = scheme
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
}
