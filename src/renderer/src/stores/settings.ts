import { create } from 'zustand'
import { resolveLocale, type Locale, type LocaleSetting } from '../../../shared/i18n'
import {
  api,
  type AppSettings,
  type SendShortcut,
  type SessionModelInfo,
  type SettingsProvider,
  type SurfaceStyle,
  type ThemePrefs,
  type ThinkingLevel
} from '../ipc/api'
import { applyShortcutPatch, type ShortcutPatch } from '../../../shared/shortcuts'
import { applyDocumentLocale, storedLocale } from '../lib/locale'
import { IS_MAC } from '../lib/platform'
import { applyDocumentTheme, storedThemePrefs } from '../lib/theme'
import { waitForSurfacePaint } from '../lib/surface-transition'
import type { SettingsChanged, SettingsSurfaceRequest } from '../../../shared/settings'

interface SettingsStore extends AppSettings {
  /** The setting resolved against the system language: what the UI actually speaks. */
  locale: Locale
  loaded: boolean
  supportsGlass: boolean
  error: string | null
  load: () => Promise<void>
  setSendShortcut: (shortcut: SendShortcut) => Promise<void>
  setShortcuts: (patch: ShortcutPatch) => Promise<void>
  setCompletionNotifications: (enabled: boolean) => Promise<void>
  setApprovalNotifications: (enabled: boolean) => Promise<void>
  setBeamBorderEnabled: (enabled: boolean) => Promise<void>
  setLocale: (locale: LocaleSetting) => Promise<void>
  setTheme: (patch: Partial<ThemePrefs>) => Promise<void>
  setDefaultModel: (provider: string, id: string) => Promise<void>
  setDefaultThinking: (level: ThinkingLevel) => Promise<void>
  setProviders: (providers: SettingsProvider[]) => void
}

const empty: AppSettings = {
  sendShortcut: 'enter',
  shortcuts: {},
  completionNotifications: true,
  approvalNotifications: true,
  beamBorderEnabled: true,
  localeSetting: 'system',
  // Until the first load the only hint is the locale of the last run, which the mirror holds.
  systemLocale: storedLocale(),
  ...storedThemePrefs(api.supportsGlass),
  defaultModel: null,
  defaultThinkingLevel: null,
  thinkingLevels: [],
  providers: []
}

function applyDefaults(next: {
  model: SessionModelInfo | null
  thinkingLevel: ThinkingLevel | null
  thinkingLevels: ThinkingLevel[]
  settingsRevision?: number
}): Pick<AppSettings, 'defaultModel' | 'defaultThinkingLevel' | 'thinkingLevels'> & { settingsRevision?: number } {
  return {
    defaultModel: next.model,
    defaultThinkingLevel: next.thinkingLevel,
    thinkingLevels: next.thinkingLevels,
    settingsRevision: next.settingsRevision
  }
}

type Revisioned = Partial<AppSettings> & { settingsRevision?: number }

let receiveChange: (event: SettingsChanged) => void = () => {}
let receiveSurface: (request: SettingsSurfaceRequest) => void = () => {}

export const useSettingsStore = create<SettingsStore>((set, get) => {
  let confirmed = { ...empty }
  // Main numbers every settings change; each field keeps the newest one it has seen, so a late
  // reply or broadcast cannot undo a newer change made by another window or the Agent.
  const fieldRevisions: Partial<Record<keyof AppSettings, number>> = {}
  // Main asks every window to paint solid before it removes the native material.
  const solidHolds = new Set<string>()
  let revision = 0
  let writes = Promise.resolve()
  let loading: Promise<void> | null = null
  const pending: Partial<AppSettings>[] = []
  let requestedSurfaceStyle: SurfaceStyle = empty.surfaceStyle
  let surfacePaint = new AbortController()

  const publish = () => {
    const merged = Object.assign({}, confirmed, ...pending) as AppSettings
    if (solidHolds.size) merged.surfaceStyle = 'solid'
    const locale = resolveLocale(merged.localeSetting, merged.systemLocale)
    const next = { ...merged, locale }
    const current = get()
    if (
      !current.loaded ||
      current.appearance !== next.appearance ||
      current.surfaceStyle !== next.surfaceStyle ||
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
  const confirm = ({ settingsRevision, ...values }: Revisioned) => {
    const next = { ...confirmed }
    for (const [key, value] of Object.entries(values) as [keyof AppSettings, never][]) {
      if (value === undefined) continue
      if (settingsRevision !== undefined) {
        if (settingsRevision < (fieldRevisions[key] ?? -1)) continue
        fieldRevisions[key] = settingsRevision
      }
      next[key] = value
    }
    confirmed = next
  }

  receiveChange = (event) => {
    confirm({ ...event.values, settingsRevision: event.revision })
    publish()
  }

  receiveSurface = (request) => {
    if (request.type === 'finish') {
      if (solidHolds.delete(request.requestId)) publish()
      return
    }
    solidHolds.add(request.requestId)
    publish()
    void (async () => {
      try {
        // Stay below main's timeout; a stuck transition must not cancel the whole change.
        await waitForSurfacePaint(AbortSignal.timeout(4_000))
        await api.replySettingsSurface(request.requestId)
      } catch (error) {
        solidHolds.delete(request.requestId)
        publish()
        await api.replySettingsSurface(request.requestId, error instanceof Error ? error.message : String(error)).catch(() => {})
      }
    })()
  }

  const save = (
    optimistic: Partial<AppSettings>,
    write: () => Promise<Revisioned>
  ): Promise<void> => {
    revision += 1
    pending.push(optimistic)
    set({ error: null })
    publish()
    writes = writes.then(async () => {
      try {
        confirm(await write())
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
          confirm(settings)
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
    supportsGlass: api.supportsGlass,
    error: null,
    load,

    setSendShortcut: (shortcut) =>
      save({ sendShortcut: shortcut }, async () => {
        const next = await api.setSendShortcut(shortcut)
        return { sendShortcut: next.sendShortcut, settingsRevision: next.settingsRevision }
      }),

    setShortcuts: (patch) => {
      let optimistic
      try {
        optimistic = { shortcuts: applyShortcutPatch(get().shortcuts, patch, IS_MAC) }
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) })
        return Promise.resolve()
      }
      return save(optimistic, async () => api.setShortcuts(patch))
    },

    setCompletionNotifications: (enabled) =>
      save({ completionNotifications: enabled }, async () => {
        const next = await api.setCompletionNotifications(enabled)
        return { completionNotifications: next.completionNotifications, settingsRevision: next.settingsRevision }
      }),

    setApprovalNotifications: (enabled) =>
      save({ approvalNotifications: enabled }, async () => {
        const next = await api.setApprovalNotifications(enabled)
        return { approvalNotifications: next.approvalNotifications, settingsRevision: next.settingsRevision }
      }),

    setBeamBorderEnabled: (enabled) =>
      save({ beamBorderEnabled: enabled }, async () => {
        const next = await api.setBeamBorderEnabled(enabled)
        return { beamBorderEnabled: next.beamBorderEnabled, settingsRevision: next.settingsRevision }
      }),

    setLocale: (locale) =>
      save({ localeSetting: locale }, async () => {
        const next = await api.setLocaleSetting(locale)
        return { localeSetting: next.localeSetting, systemLocale: next.systemLocale, settingsRevision: next.settingsRevision }
      }),

    setTheme: (patch) => {
      if (patch.surfaceStyle !== undefined) {
        requestedSurfaceStyle = patch.surfaceStyle
        surfacePaint.abort()
        surfacePaint = new AbortController()
      }
      // Solid paints first; glass stays covered until main has enabled its material.
      const optimistic = { ...patch }
      if (optimistic.surfaceStyle === 'glass') delete optimistic.surfaceStyle
      return save(optimistic, async () => {
        let effective = patch
        if (patch.surfaceStyle !== undefined) {
          while (requestedSurfaceStyle === 'solid' && confirmed.surfaceStyle !== 'solid') {
            const paint = surfacePaint
            const waiting = waitForSurfacePaint(paint.signal)
            if (waiting) await waiting
            if (paint === surfacePaint) break
          }
          // Only obsolete material choices are coalesced; palette and appearance patches still commit in order.
          effective = { ...patch, surfaceStyle: requestedSurfaceStyle }
        }
        const next = await api.setTheme(effective)
        return {
          appearance: next.appearance,
          lightTheme: next.lightTheme,
          darkTheme: next.darkTheme,
          surfaceStyle: next.surfaceStyle,
          settingsRevision: next.settingsRevision
        }
      })
    },

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

/** Follow settings changed by other windows or the Agent; App mounts this once per window. */
export function subscribeSettingsChanges(): () => void {
  const offChanged = api.onSettingsChanged((event) => receiveChange(event))
  const offSurface = api.onSettingsSurface((request) => receiveSurface(request))
  return () => {
    offChanged()
    offSurface()
  }
}
