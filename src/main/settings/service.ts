/**
 * One allowlisted settings boundary for UI and Agent writes. Revisions are checked again inside the
 * file mutation queue; UI patches carry a separate monotonic revision for out-of-order IPC replies.
 * Native material handoff is injected so persistence and concurrency can be tested without Electron.
 */
import { createHash } from 'node:crypto'
import type { AppSettings, LocaleSetting, PaletteId, SurfaceStyle, ThemePrefs } from '../../shared/api'
import { LOCALES, resolveLocale } from '../../shared/i18n'
import {
  SETTINGS_GROUPS,
  type SettingsApplication, type SettingsCatalog, type SettingsChanged, type SettingsGroup,
  type SettingsGroupSnapshot, type SettingsListOptions, type SettingsMutationResult, type SettingsReply,
  type SettingsUpdateRequest, type SettingsValuesByGroup
} from '../../shared/settings'
import { applyShortcutPatch, defaultShortcut, resolveShortcuts, SHORTCUT_ACTIONS } from '../../shared/shortcuts'
import { loadPigSettings, updatePigSettings, type PigSettings } from '../pig-settings'
import { supportsGlass } from '../surface-support'
import { systemLocale } from '../i18n'
import {
  availableModels, pickerThinkingLevels, readDefaultSettings, startModelRuntime, updateDefaultSettings,
  type DefaultSettingsSnapshot
} from '../pi/model-settings'

export interface SurfaceHandoff { finish(style: SurfaceStyle): void }
export interface SettingsServiceDeps {
  prepareSolid(signal?: AbortSignal): Promise<SurfaceHandoff>
  applyTheme(theme: ThemePrefs): void
  applyShortcuts(shortcuts: PigSettings['shortcuts']): void
  applyLocale(locale: PigSettings['locale']): void
  publish(event: SettingsChanged): void
  isDark(): boolean
}

type ObjectValue = Record<string, unknown>
// Records keyed by the union fail to typecheck when a palette or locale is added without listing it here.
const PALETTES = Object.keys({ pig: true, everforest: true } satisfies Record<PaletteId, true>)
const LOCALE_SETTINGS = Object.keys({ system: true, ...Object.fromEntries(LOCALES.map((locale) => [locale, true])) } as Record<LocaleSetting, true>)
const applications: Record<SettingsGroup, SettingsApplication> = {
  theme: 'applied', general: 'applied', notifications: 'future-notifications', shortcuts: 'applied', defaults: 'new-sessions'
}
const fields: SettingsCatalog['groups'] = [
  { id: 'theme', description: 'Application appearance, native material and light/dark palettes.', scope: 'application', applies: 'applied', fields: [
    { key: 'appearance', type: 'enum', values: ['system', 'light', 'dark'], description: 'Follow the OS or choose light/dark.' },
    { key: 'surfaceStyle', type: 'enum', values: ['glass', 'solid'], description: 'Glass is available only on supported platforms.' },
    { key: 'lightTheme', type: 'enum', values: PALETTES, description: 'Palette used in light appearance.' },
    { key: 'darkTheme', type: 'enum', values: PALETTES, description: 'Palette used in dark appearance.' }
  ] },
  { id: 'general', description: 'Application UI language; this does not set the conversation reply language.', scope: 'application', applies: 'applied', fields: [
    { key: 'locale', type: 'enum', values: LOCALE_SETTINGS, description: 'Follow the OS language or choose a shipped locale.' }
  ] },
  { id: 'notifications', description: 'Pig completion notifications; operating-system notification permissions still apply.', scope: 'application', applies: 'future-notifications', fields: [
    { key: 'completionNotifications', type: 'boolean', description: 'Enable completion notifications for subsequent replies.' }
  ] },
  { id: 'shortcuts', description: 'Existing application actions only. Never replace a conflicting binding without user authorization.', scope: 'application', applies: 'applied', fields: [
    { key: 'sendShortcut', type: 'enum', values: ['enter', 'shift-enter'], description: 'Composer send key; IME composition stays protected.' },
    { key: 'bindings', type: 'shortcut-map', description: 'Patch action IDs to canonical bindings, null to disable, or "default" to restore. Mod means Command on macOS and Control elsewhere.' }
  ] },
  { id: 'defaults', description: 'Default model and thinking for new sessions. Shared with Pi CLI; does not switch an existing session. An explicit thinking choice also updates the chosen model\'s remembered level, like the settings page.', scope: 'pi-shared', applies: 'new-sessions', fields: [
    { key: 'model', type: 'model', description: 'An available model, identified by provider and id. Use settings_list with group defaults to find candidates.' },
    { key: 'thinkingLevel', type: 'enum', values: ['low', 'medium', 'high', 'xhigh', 'max'], description: 'Must be supported by the selected/default model. off and minimal are not offered for general defaults.' }
  ] }
]

function object(value: unknown, allowed: string[], nonempty = true): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a settings patch object')
  const entries = Object.keys(value)
  if (nonempty && !entries.length) throw new Error('Settings patch must not be empty')
  for (const key of entries) if (!allowed.includes(key)) throw new Error(`Unknown settings field: ${key}`)
  return value as ObjectValue
}

function member(value: unknown, options: readonly string[], name: string): void {
  if (typeof value !== 'string' || !options.includes(value)) throw new Error(`Invalid ${name}; expected one of: ${options.join(', ')}`)
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]))
  return value
}

function revision(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
}

function theme(pig: PigSettings): ThemePrefs {
  return { appearance: pig.appearance, surfaceStyle: pig.surfaceStyle, lightTheme: pig.lightTheme, darkTheme: pig.darkTheme }
}

function pigValues(pig: PigSettings, group: Exclude<SettingsGroup, 'defaults'>): SettingsValuesByGroup[Exclude<SettingsGroup, 'defaults'>] {
  switch (group) {
    case 'theme': return theme(pig)
    case 'general': return { locale: pig.locale }
    case 'notifications': return { completionNotifications: pig.completionNotifications }
    case 'shortcuts': return { sendShortcut: pig.sendShortcut, bindings: pig.shortcuts }
  }
}

function defaultsSnapshot(state: DefaultSettingsSnapshot): SettingsGroupSnapshot {
  const model = state.effective.model
  return {
    group: 'defaults', revision: state.revision, values: state.stored,
    effective: { model: model ? { provider: model.provider, id: model.id } : null, thinkingLevel: state.effective.thinkingLevel },
    scope: 'pi-shared', applies: 'new-sessions'
  }
}

function errorText(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length) {
    return `${error.message}: ${error.errors.map((cause) => cause instanceof Error ? cause.message : String(cause)).join('; ')}`
  }
  return error instanceof Error ? error.message : String(error)
}

function validateGroup(group: unknown): asserts group is SettingsGroup {
  if (!(SETTINGS_GROUPS as readonly unknown[]).includes(group)) throw new Error(`Unknown settings group: ${String(group)}`)
}

export class SettingsService {
  private queue: Promise<unknown> = Promise.resolve()
  private uiRevision = 0

  constructor(private readonly deps: SettingsServiceDeps) {}

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action)
    this.queue = result.catch(() => undefined)
    return result
  }

  private publish(values: SettingsChanged['values']): SettingsChanged {
    const event = { revision: ++this.uiRevision, values }
    this.deps.publish(event)
    return event
  }

  private pigSnapshot(pig: PigSettings, group: Exclude<SettingsGroup, 'defaults'>): SettingsGroupSnapshot {
    const values = pigValues(pig, group)
    let effective: SettingsGroupSnapshot['effective'] = values
    if (group === 'theme') effective = { ...theme(pig), appearance: pig.appearance === 'system' ? this.deps.isDark() ? 'dark' : 'light' : pig.appearance }
    if (group === 'general') effective = { locale: resolveLocale(pig.locale, systemLocale()) }
    if (group === 'shortcuts') effective = { sendShortcut: pig.sendShortcut, bindings: resolveShortcuts(pig.shortcuts, process.platform === 'darwin') }
    return { group, revision: revision(values), values, effective, scope: 'application', applies: applications[group] }
  }

  private async snapshot(group: SettingsGroup): Promise<SettingsGroupSnapshot> {
    if (group !== 'defaults') return this.pigSnapshot(await loadPigSettings(true), group)
    return defaultsSnapshot(await readDefaultSettings())
  }

  async get(group: SettingsGroup): Promise<SettingsGroupSnapshot> {
    validateGroup(group)
    return this.serial(() => this.snapshot(group))
  }

  list(options: SettingsListOptions = {}): Promise<SettingsCatalog> {
    return this.serial(async () => {
      object(options, ['group', 'query', 'offset', 'limit'], false)
      if (options.group !== undefined) validateGroup(options.group)
      if (options.query !== undefined && (typeof options.query !== 'string' || options.query.length > 200)) throw new Error('Invalid settings search query')
      const offset = options.offset ?? 0
      const limit = options.limit ?? 20
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid settings catalog page')
      const catalog: SettingsCatalog = {
        platform: process.platform, supportsGlass,
        groups: structuredClone(fields.filter((entry) => options.group === undefined || entry.id === options.group))
      }
      if (!supportsGlass) catalog.groups.find((group) => group.id === 'theme')?.fields.find((field) => field.key === 'surfaceStyle')?.values?.splice(0, 1)
      if (options.group === 'defaults') {
        await startModelRuntime()
        const query = options.query?.trim().toLowerCase() ?? ''
        const models = availableModels().filter((model) => `${model.provider} ${model.providerName} ${model.id} ${model.name}`.toLowerCase().includes(query))
        catalog.models = { items: models.slice(offset, offset + limit).map((model) => ({ ...model, thinkingLevels: pickerThinkingLevels(model.thinkingLevels) })), total: models.length, offset, hasMore: offset + limit < models.length }
      }
      if (options.group === 'shortcuts') {
        const pig = await loadPigSettings(true)
        const bindings = resolveShortcuts(pig.shortcuts, process.platform === 'darwin')
        catalog.shortcuts = SHORTCUT_ACTIONS.map((id) => ({ id, label: id, binding: bindings[id], default: defaultShortcut(id, process.platform === 'darwin') }))
      }
      return catalog
    })
  }

  getUi(): Promise<SettingsReply<Omit<AppSettings, 'providers'>>> {
    return this.serial(async () => {
      const [pig, defaults] = await Promise.all([
        loadPigSettings(),
        // Read-only boundary: a broken Pi settings.json is shared with the CLI and must not hide Pig's own
        // preferences. The error is shown beside the default model; writes still fail strictly.
        readDefaultSettings().then(
          (state) => ({ ...state.effective, error: null }),
          (error: unknown) => ({ model: null, thinkingLevel: null, thinkingLevels: [], error: errorText(error) })
        )
      ])
      return {
        ...theme(pig), sendShortcut: pig.sendShortcut, shortcuts: pig.shortcuts,
        completionNotifications: pig.completionNotifications, beamBorderEnabled: pig.beamBorderEnabled,
        localeSetting: pig.locale, systemLocale: systemLocale(), defaultModel: defaults.model,
        defaultThinkingLevel: defaults.thinkingLevel, thinkingLevels: defaults.thinkingLevels,
        defaultSettingsError: defaults.error, settingsRevision: this.uiRevision
      }
    })
  }

  private valuesForUi(pig: PigSettings, group: Exclude<SettingsGroup, 'defaults'>): SettingsChanged['values'] {
    switch (group) {
      case 'theme': return theme(pig)
      case 'general': return { localeSetting: pig.locale, systemLocale: systemLocale() }
      case 'notifications': return { completionNotifications: pig.completionNotifications }
      case 'shortcuts': return { sendShortcut: pig.sendShortcut, shortcuts: pig.shortcuts }
    }
  }

  private validatePatch(group: SettingsGroup, patch: unknown, agent: boolean): ObjectValue {
    const allowed = fields.find((entry) => entry.id === group)!.fields.map((field) => field.key)
    const value = object(patch, allowed)
    for (const [key, input] of Object.entries(value)) {
      const field = fields.find((entry) => entry.id === group)!.fields.find((entry) => entry.key === key)!
      if (field.type === 'enum') member(input, field.values!, key)
      if (field.type === 'boolean' && typeof input !== 'boolean') throw new Error(`Expected a boolean ${key}`)
      if (field.type === 'model') {
        const model = object(input, ['provider', 'id'])
        if (typeof model.provider !== 'string' || !model.provider || typeof model.id !== 'string' || !model.id) throw new Error('Provider and model id are required')
      }
      if (field.type === 'shortcut-map') object(input, [...SHORTCUT_ACTIONS], false)
    }
    if (agent && value.surfaceStyle === 'glass' && !supportsGlass) throw new Error('Glass is not supported on this platform')
    return value
  }

  private async mutate(
    group: SettingsGroup, patch: unknown, expectedRevision?: string, signal?: AbortSignal,
    authorize: () => void = () => {}, agent = false
  ): Promise<{ result: SettingsMutationResult; event: SettingsChanged }> {
    authorize()
    signal?.throwIfAborted()
    const value = this.validatePatch(group, patch, agent)
    const before = await this.snapshot(group)
    if (expectedRevision !== undefined && expectedRevision !== before.revision) throw new Error('Settings revision conflict; read the group again before saving')
    authorize()
    signal?.throwIfAborted()
    if (group === 'defaults') {
      // The model service validates the pair and performs its own CAS inside the SDK preference queue.
      const state = await updateDefaultSettings(value, expectedRevision)
      const after = defaultsSnapshot(state)
      const event = this.publish({
        defaultModel: state.effective.model, defaultThinkingLevel: state.effective.thinkingLevel,
        thinkingLevels: state.effective.thinkingLevels, defaultSettingsError: null
      })
      return { result: { ok: true, changed: before.revision !== after.revision, before, after, application: 'new-sessions' }, event }
    }
    const beforePig = await loadPigSettings(true)
    let handoff: SurfaceHandoff | undefined
    let saved = false
    let next = beforePig
    try {
      if (group === 'theme' && value.surfaceStyle === 'solid' && beforePig.surfaceStyle !== 'solid') handoff = await this.deps.prepareSolid(signal)
      authorize()
      signal?.throwIfAborted()
      next = await updatePigSettings((current) => {
        authorize()
        signal?.throwIfAborted()
        if (expectedRevision !== undefined && this.pigSnapshot(current, group).revision !== expectedRevision) throw new Error('Settings revision conflict; read the group again before saving')
        switch (group) {
          case 'theme': return value as Partial<ThemePrefs>
          case 'general': return { locale: value.locale as PigSettings['locale'] }
          case 'notifications': return { completionNotifications: value.completionNotifications as boolean }
          case 'shortcuts': return {
            ...(value.sendShortcut !== undefined ? { sendShortcut: value.sendShortcut as PigSettings['sendShortcut'] } : {}),
            ...(value.bindings !== undefined ? { shortcuts: applyShortcutPatch(current.shortcuts, value.bindings, process.platform === 'darwin') } : {})
          }
        }
      })
      saved = true
      // Cancellation after persistence cannot interrupt material cleanup or leave a half-applied shortcut map.
      if (group === 'theme') this.deps.applyTheme(theme(next))
      if (group === 'general') this.deps.applyLocale(next.locale)
      if (group === 'shortcuts') this.deps.applyShortcuts(next.shortcuts)
      const after = this.pigSnapshot(next, group)
      const event = this.publish(this.valuesForUi(next, group))
      return { result: { ok: true, changed: before.revision !== after.revision, before, after, application: applications[group] }, event }
    } catch (error) {
      if (!saved) throw error
      const after = this.pigSnapshot(next, group)
      const event = this.publish(this.valuesForUi(next, group))
      return { result: { ok: false, changed: before.revision !== after.revision, before, after, application: 'failed', error: `Settings were saved but could not be applied: ${error instanceof Error ? error.message : String(error)}` }, event }
    } finally {
      handoff?.finish(saved ? next.surfaceStyle : beforePig.surfaceStyle)
    }
  }

  async update(request: SettingsUpdateRequest, signal?: AbortSignal, authorize?: () => void): Promise<SettingsMutationResult> {
    object(request, ['group', 'patch', 'expectedRevision'])
    validateGroup(request.group)
    if (typeof request.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(request.expectedRevision)) throw new Error('A settings revision from settings_get is required')
    return this.serial(async () => (await this.mutate(request.group, request.patch, request.expectedRevision, signal, authorize, true)).result)
  }

  async updateUi(group: SettingsGroup, patch: unknown): Promise<SettingsReply<SettingsChanged['values']>> {
    validateGroup(group)
    return this.serial(async () => {
      const { result, event } = await this.mutate(group, patch)
      if (!result.ok) throw new Error(result.error)
      return { ...event.values, settingsRevision: event.revision }
    })
  }

  async setBeamBorder(enabled: boolean): Promise<SettingsReply<{ beamBorderEnabled: boolean }>> {
    if (typeof enabled !== 'boolean') throw new Error('Expected a boolean beam border setting')
    return this.serial(async () => {
      const next = await updatePigSettings(() => ({ beamBorderEnabled: enabled }))
      const event = this.publish({ beamBorderEnabled: next.beamBorderEnabled })
      return { beamBorderEnabled: next.beamBorderEnabled, settingsRevision: event.revision }
    })
  }
}
