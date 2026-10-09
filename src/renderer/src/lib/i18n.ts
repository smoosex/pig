import { translate, type MessageKey, type Translate } from '../../../shared/i18n'
import { useSettingsStore } from '../stores/settings'

/**
 * Translation for plain modules (projections, stores, event handlers) that run outside a component.
 * They read the locale when they run, so the component drawing the result is the one that must
 * subscribe to it — components should use `useT`, and pure formatters should take a `Translate`.
 */
export const t: Translate = (key, params) =>
  translate(useSettingsStore.getState().locale, key, params)

/**
 * Catalog copy for a featured listing: the dictionary wins so the sheet follows the app language,
 * and the English text the listing shipped falls back when the entry is missing. A Registry listing
 * carries no key, so its author's own wording is shown as written.
 */
export function listingText(
  format: Translate,
  key: MessageKey | undefined,
  fallback: string
): string {
  if (!key) return fallback
  const text = format(key)
  // The keys are built from template strings, so a malformed path resolves to the key itself.
  return text === key ? fallback : text
}
