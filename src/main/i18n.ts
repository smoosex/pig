import {
  DEFAULT_LOCALE,
  normalizeLocale,
  resolveLocale,
  translate,
  type Locale,
  type LocaleSetting,
  type MessageKey,
  type MessageParams
} from '../shared/i18n'

/**
 * Main-process copy: errors, dialog titles, and anything else the renderer shows verbatim.
 * The locale is resolved once at startup and re-resolved when the renderer saves a new setting, so a
 * message carries the language that was active when it was produced.
 */
let system: Locale = DEFAULT_LOCALE
let current: Locale = DEFAULT_LOCALE

/** Call once after `app` is ready: `getSystemLocale` needs the ready event, and the window must not
 * open before the resolved locale is known, or the first paint picks the fallback language. Electron is
 * imported here rather than at the top so the main modules that only need `t` stay testable without it. */
export async function initLocale(setting: LocaleSetting): Promise<void> {
  const { app } = await import('electron')
  system = normalizeLocale(app.getSystemLocale()) ?? DEFAULT_LOCALE
  current = resolveLocale(setting, system)
}

export function applyLocaleSetting(setting: LocaleSetting): Locale {
  current = resolveLocale(setting, system)
  return current
}

export function currentLocale(): Locale {
  return current
}

export function systemLocale(): Locale {
  return system
}

export function t(key: MessageKey, params?: MessageParams): string {
  return translate(current, key, params)
}
