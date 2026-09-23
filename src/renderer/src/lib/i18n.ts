import { translate, type Translate } from '../../../shared/i18n'
import { useSettingsStore } from '../stores/settings'

/**
 * Translation for plain modules (projections, stores, event handlers) that run outside a component.
 * They read the locale when they run, so the component drawing the result is the one that must
 * subscribe to it — components should use `useT`, and pure formatters should take a `Translate`.
 */
export const t: Translate = (key, params) =>
  translate(useSettingsStore.getState().locale, key, params)
