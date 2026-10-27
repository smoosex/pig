/** Allowlisted Agent settings and the versioned UI handoff; neither contract exposes credentials or paths. */
import type { AppSettings, LocaleSetting, SendShortcut, SessionModelInfo, SurfaceStyle, ThemePrefs, ThinkingLevel } from './api'
import type { ShortcutActionId, ShortcutBindings, ShortcutOverrides, ShortcutPatch } from './shortcuts'

export const SETTINGS_GROUPS = ['theme', 'general', 'notifications', 'shortcuts', 'defaults'] as const
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number]
export type SettingsApplication = 'applied' | 'future-notifications' | 'new-sessions'

export interface SettingsValuesByGroup {
  theme: ThemePrefs
  general: { locale: LocaleSetting }
  notifications: { completionNotifications: boolean }
  shortcuts: { sendShortcut: SendShortcut; bindings: ShortcutOverrides }
  defaults: { model: { provider: string; id: string } | null; thinkingLevel: ThinkingLevel | null }
}

export interface SettingsPatchesByGroup {
  theme: Partial<ThemePrefs>
  general: { locale?: LocaleSetting }
  notifications: { completionNotifications?: boolean }
  shortcuts: { sendShortcut?: SendShortcut; bindings?: ShortcutPatch }
  defaults: { model?: { provider: string; id: string }; thinkingLevel?: ThinkingLevel }
}

export type SettingsUpdateRequest = {
  [G in SettingsGroup]: { group: G; expectedRevision: string; patch: SettingsPatchesByGroup[G] }
}[SettingsGroup]

export interface SettingsGroupSnapshot {
  group: SettingsGroup
  revision: string
  values: SettingsValuesByGroup[SettingsGroup]
  effective: SettingsValuesByGroup[SettingsGroup] | { sendShortcut: SendShortcut; bindings: ShortcutBindings }
  scope: 'application' | 'pi-shared'
  applies: SettingsApplication
}

export interface SettingsMutationResult {
  ok: boolean
  changed: boolean
  before: SettingsGroupSnapshot
  after: SettingsGroupSnapshot
  application: SettingsApplication | 'failed'
  error?: string
}

export interface SettingsListOptions {
  group?: SettingsGroup
  query?: string
  offset?: number
  limit?: number
}

export interface SettingsField {
  key: string
  type: 'enum' | 'boolean' | 'model' | 'shortcut-map'
  description: string
  values?: string[]
}

export interface SettingsCatalog {
  platform: string
  supportsGlass: boolean
  groups: Array<{
    id: SettingsGroup
    description: string
    scope: 'application' | 'pi-shared'
    applies: SettingsApplication
    fields: SettingsField[]
  }>
  models?: { items: SessionModelInfo[]; total: number; offset: number; hasMore: boolean }
  shortcuts?: Array<{ id: ShortcutActionId; label: string; binding: string | null; default: string | null }>
}

export interface SettingsAgentHost {
  list(sessionId: string, options: SettingsListOptions): Promise<SettingsCatalog>
  get(sessionId: string, group: SettingsGroup): Promise<SettingsGroupSnapshot>
  update(sessionId: string, request: SettingsUpdateRequest, signal?: AbortSignal): Promise<SettingsMutationResult>
}

/** Each value keeps its revision in renderer, so a late reply cannot undo a newer change to another field. */
export interface SettingsChanged {
  revision: number
  values: Partial<Omit<AppSettings, 'providers'>>
}

export type SettingsReply<T> = T & { settingsRevision: number }

export type SettingsSurfaceRequest =
  | { type: 'prepare-solid'; requestId: string }
  | { type: 'finish'; requestId: string; surfaceStyle: SurfaceStyle }

export interface SettingsEventsApi {
  onSettingsChanged(listener: (event: SettingsChanged) => void): () => void
  onSettingsSurface(listener: (event: SettingsSurfaceRequest) => void): () => void
  replySettingsSurface(requestId: string, error?: string): Promise<void>
}
