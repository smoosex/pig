import { DEFAULT_LOCALE, isLocale, type Locale } from '../../../shared/i18n'

const STORAGE_KEY = 'pig.locale'

/** Bun's test runtime has no DOM, and store fixtures import this module before registering one. */
function readLocale(): string | null {
  return typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY)
}

/** The last resolved locale: the pre-paint bootstrap in index.html and the store's first render
 * both read it, so an English user never sees a Chinese flash before settings arrive. */
export function storedLocale(): Locale {
  const value = readLocale()
  return isLocale(value) ? value : DEFAULT_LOCALE
}

export function applyDocumentLocale(locale: Locale): void {
  const root = document.documentElement
  root.lang = locale
  root.dataset.locale = locale
  localStorage.setItem(STORAGE_KEY, locale)
}
