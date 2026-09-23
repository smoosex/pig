import { useCallback } from 'react'
import { translate, type MessageKey, type MessageParams, type Translate } from '../../../shared/i18n'
import { useSettingsStore } from '../stores/settings'

/** Components use this so a language switch re-renders them; plain modules use `lib/i18n`'s `t`. */
export function useT(): Translate {
  const locale = useSettingsStore((s) => s.locale)
  return useCallback(
    (key: MessageKey, params?: MessageParams) => translate(locale, key, params),
    [locale]
  )
}
