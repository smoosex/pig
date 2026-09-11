import type { Appearance, PaletteId, ThemePrefs } from '../../../shared/api'

export type { Appearance, PaletteId, ThemePrefs } from '../../../shared/api'

export const defaultThemePrefs: ThemePrefs = {
  appearance: 'system',
  lightTheme: 'pig',
  darkTheme: 'pig'
}

const STORAGE_KEY = 'pig.theme'

export function parseAppearance(value: unknown): Appearance {
  return value === 'light' || value === 'dark' ? value : 'system'
}

export function parsePalette(value: unknown): PaletteId {
  return value === 'everforest' ? 'everforest' : 'pig'
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
  root.style.colorScheme = scheme
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
}
