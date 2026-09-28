import { create } from 'zustand'
import { resolveLocale, type Locale, type LocaleSetting } from '../../../shared/i18n'
import {
  api,
  type AppSettings,
  type SendShortcut,
  type SessionModelInfo,
  type SettingsProvider,
  type ThemePrefs,
  type ThinkingLevel
} from '../ipc/api'
import { applyDocumentLocale, storedLocale } from '../lib/locale'
import { applyDocumentTheme } from '../lib/theme'

interface SettingsStore extends AppSettings {
  /** The setting resolved against the system language: what the UI actually speaks. */
  locale: Locale
  loaded: boolean
  error: string | null
  load: () => Promise<void>
  setSendShortcut: (shortcut: SendShortcut) => Promise<void>
  setCompletionNotifications: (enabled: boolean) => Promise<void>
  setLocale: (locale: LocaleSetting) => Promise<void>
  setTheme: (patch: Partial<ThemePrefs>) => Promise<void>
  setDefaultModel: (provider: string, id: string) => Promise<void>
  setDefaultThinking: (level: ThinkingLevel) => Promise<void>
  setProviders: (providers: SettingsProvider[]) => void
}

const empty: AppSettings = {
  sendShortcut: 'enter',
  completionNotifications: true,
  localeSetting: 'system',
  // Until the first load the only hint is the locale of the last run, which the mirror holds.
  systemLocale: storedLocale(),
  appearance: 'system',
  lightTheme: 'pig',
  darkTheme: 'pig',
  defaultModel: null,
  defaultThinkingLevel: null,
  thinkingLevels: [],
  models: [],
  providers: []
}

function applyDefaults(next: {
  model: SessionModelInfo | null
  thinkingLevel: ThinkingLevel | null
  thinkingLevels: ThinkingLevel[]
}): Pick<AppSettings, 'defaultModel' | 'defaultThinkingLevel' | 'thinkingLevels'> {
  return {
    defaultModel: next.model,
    defaultThinkingLevel: next.thinkingLevel,
    thinkingLevels: next.thinkingLevels
  }
}

export const useSettingsStore = create<SettingsStore>((set, get) => {
  let confirmed = { ...empty }
  let revision = 0
  let writes = Promise.resolve()
  let loading: Promise<void> | null = null
  const pending: Partial<AppSettings>[] = []

  const publish = () => {
    const merged = Object.assign({}, confirmed, ...pending) as AppSettings
    const locale = resolveLocale(merged.localeSetting, merged.systemLocale)
    const next = { ...merged, locale }
    const current = get()
    if (
      !current.loaded ||
      current.appearance !== next.appearance ||
      current.lightTheme !== next.lightTheme ||
      current.darkTheme !== next.darkTheme
    ) {
      applyDocumentTheme(next)
    }
    if (!current.loaded || current.locale !== locale) applyDocumentLocale(locale)
    set(next)
  }

  /**
   * Theme and shortcut writes share Pig's settings file; model defaults use Pi.
   * Commit changes in order and keep pending UI patches above confirmed values,
   * including when an earlier save fails.
   */
  const save = (
    optimistic: Partial<AppSettings>,
    write: () => Promise<Partial<AppSettings>>
  ): Promise<void> => {
    revision += 1
    pending.push(optimistic)
    set({ error: null })
    publish()
    writes = writes.then(async () => {
      try {
        confirmed = { ...confirmed, ...(await write()) }
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) })
      } finally {
        pending.shift()
        publish()
      }
    })
    return writes
  }

  const load = (): Promise<void> => {
    if (loading) return loading
    loading = (async () => {
      try {
        while (true) {
          const pendingWrites = writes
          await pendingWrites
          if (pendingWrites !== writes) continue
          const requestedRevision = revision
          const settings = await api.getSettings()
          if (requestedRevision !== revision) continue
          confirmed = settings
          publish()
          set({ loaded: true, error: null })
          return
        }
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) })
      } finally {
        loading = null
      }
    })()
    return loading
  }

  return {
    ...empty,
    locale: storedLocale(),
    loaded: false,
    error: null,
    load,

    setSendShortcut: (shortcut) =>
      save({ sendShortcut: shortcut }, async () => {
        const next = await api.setSendShortcut(shortcut)
        return { sendShortcut: next.sendShortcut }
      }),

    setCompletionNotifications: (enabled) =>
      save({ completionNotifications: enabled }, async () => {
        const next = await api.setCompletionNotifications(enabled)
        return { completionNotifications: next.completionNotifications }
      }),

    setLocale: (locale) =>
      save({ localeSetting: locale }, async () => {
        const next = await api.setLocaleSetting(locale)
        return { localeSetting: next.localeSetting, systemLocale: next.systemLocale }
      }),

    setTheme: (patch) =>
      save(patch, async () => {
        const next = await api.setTheme(patch)
        return {
          appearance: next.appearance,
          lightTheme: next.lightTheme,
          darkTheme: next.darkTheme
        }
      }),

    setDefaultModel: (provider, id) =>
      save({}, async () => applyDefaults(await api.setDefaultModelSetting(provider, id))),

    setDefaultThinking: (level) =>
      save({}, async () => applyDefaults(await api.setDefaultThinkingSetting(level))),

    setProviders: (providers) => {
      revision += 1
      confirmed = { ...confirmed, providers }
      publish()
    }
  }
})

export function modelKey(model: Pick<SessionModelInfo, 'provider' | 'id'>): string {
  return `${model.provider}/${model.id}`
}
