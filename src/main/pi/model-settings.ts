/**
 * Shared model runtime and persisted preferences.
 *
 * Session controls consume these defaults without owning another runtime or settings cache.
 */
import { createHash } from 'node:crypto'
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent'
import type {
  DefaultSessionSettings,
  SessionModelInfo,
  ThinkingLevel as SessionThinkingLevel
} from '../../shared/api'

export type { DefaultSessionSettings, ThinkingLevel as SessionThinkingLevel } from '../../shared/api'

export interface DefaultSettingsSnapshot {
  stored: {
    model: { provider: string; id: string } | null
    thinkingLevel: SessionThinkingLevel | null
  }
  effective: DefaultSessionSettings
  modelThinkingLevel: SessionThinkingLevel | null
  revision: string
}

export interface DefaultSettingsPatch {
  model?: { provider: string; id: string }
  thinkingLevel?: SessionThinkingLevel
}

export const THINKING_LEVELS: SessionThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

export const HIDDEN_THINKING_LEVELS = new Set<SessionThinkingLevel>(['off', 'minimal'])

let modelRuntime: ModelRuntime | undefined
let modelRuntimePromise: Promise<ModelRuntime> | undefined
let settingsManager: SettingsManager | undefined
let thinkingSettingsNeedValidation = false
let settingsQueue: Promise<void> = Promise.resolve()

function withSettingsQueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = settingsQueue.then(operation)
  settingsQueue = result.then(() => undefined, () => undefined)
  return result
}

function discardSettings(): void {
  settingsManager = undefined
  thinkingSettingsNeedValidation = true
}

function checkSettingsErrors(settings: SettingsManager, message: string): void {
  const errors = settings.drainErrors()
  if (errors.length) throw new AggregateError(errors.map(({ error }) => error), message)
}

async function reloadSettings(message: string): Promise<SettingsManager> {
  try {
    const settings = appSettings()
    await settings.reload()
    checkSettingsErrors(settings, message)
    thinkingSettingsNeedValidation = false
    return settings
  } catch (error) {
    discardSettings()
    throw error
  }
}

async function persistSettings(
  settings: SettingsManager,
  update: () => void,
  message: string
): Promise<void> {
  try {
    try {
      update()
    } finally {
      await settings.flush()
    }
    checkSettingsErrors(settings, message)
  } catch (error) {
    // Failed SDK writes remain in memory; recovery must load a fresh, validated instance.
    discardSettings()
    throw error
  }
}

export function startModelRuntime(): Promise<ModelRuntime> {
  if (!modelRuntimePromise) {
    modelRuntimePromise = ModelRuntime.create()
      .then((runtime) => {
        modelRuntime = runtime
        return runtime
      })
      .catch((error) => {
        // A temporary auth or filesystem failure must not poison future sessions.
        modelRuntimePromise = undefined
        throw error
      })
  }
  return modelRuntimePromise
}

type ThinkingModel = {
  reasoning: boolean
  thinkingLevelMap?: Partial<Record<SessionThinkingLevel, string | null>>
}

function supportedThinkingLevels(model: ThinkingModel | undefined): SessionThinkingLevel[] {
  if (!model?.reasoning) return ['off']
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}

export function toModelInfo(model: ThinkingModel & {
  id: string
  name: string
  provider: string
  contextWindow: number
}): SessionModelInfo {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    providerName: modelRuntime?.getProvider(model.provider)?.name ?? model.provider,
    contextWindow: model.contextWindow,
    reasoning: model.reasoning,
    thinkingLevels: model.reasoning ? supportedThinkingLevels(model) : []
  }
}

export function availableModels(): SessionModelInfo[] {
  return (modelRuntime?.getAvailableSnapshot() ?? []).map(toModelInfo)
}

export function thinkingLevelsFor(model: { provider: string; id: string } | null): SessionThinkingLevel[] {
  if (!model) return ['off']
  return supportedThinkingLevels(modelRuntime?.getModel(model.provider, model.id))
}

export function clampThinking(
  level: SessionThinkingLevel | undefined,
  levels: SessionThinkingLevel[]
): SessionThinkingLevel {
  if (level && levels.includes(level)) return level
  return levels[0] ?? 'off'
}

export function pickerThinkingLevels(levels: SessionThinkingLevel[]): SessionThinkingLevel[] {
  return levels.filter((level) => !HIDDEN_THINKING_LEVELS.has(level))
}

export function findModel(provider: string, id: string): SessionModelInfo | null {
  const model = modelRuntime?.getModel(provider, id)
  return model ? toModelInfo(model) : null
}

function appSettings(): SettingsManager {
  settingsManager ??= SettingsManager.create(process.cwd())
  return settingsManager
}

/** Pi's `shouldCompact` boundary: auto-compaction runs once context tokens exceed this. */
export function autoCompactAt(
  contextWindow: number,
  model: { provider: string; id: string } | null,
  settings: SettingsManager = appSettings()
): number | null {
  const compaction = settings.getCompactionSettings(model ?? undefined)
  return compaction.enabled ? Math.max(0, contextWindow - compaction.reserveTokens) : null
}

export async function getOrCreateDeviceId(): Promise<string> {
  return withSettingsQueue(async () => {
    const settings = await reloadSettings('Could not load settings for the installation ID')
    let deviceId!: string
    await persistSettings(settings, () => {
      deviceId = settings.getOrCreateDeviceId()
    }, 'Could not persist the installation ID')
    return deviceId
  })
}

export function defaultModelFromSettings(): SessionModelInfo | null {
  const settings = thinkingSettings()
  const provider = settings.getDefaultProvider()
  const id = settings.getDefaultModel()
  if (!provider || !id) return null
  return findModel(provider, id)
}

function thinkingSettings(): SettingsManager {
  const settings = appSettings()
  if (thinkingSettingsNeedValidation) {
    const errors = settings.drainErrors()
    if (errors.length) {
      discardSettings()
      throw new AggregateError(errors.map(({ error }) => error), 'Could not reload thinking preferences')
    }
    thinkingSettingsNeedValidation = false
  }
  return settings
}

export function modelThinkingFromSettings(
  model: { provider: string; id: string } | null
): SessionThinkingLevel | null {
  if (!model) return null
  return (thinkingSettings().getModelThinkingLevel(model.provider, model.id) as SessionThinkingLevel | undefined) ?? null
}

// Explicit preference actions write here; SDK/plugin model switches and restoration never do.
export async function saveModelThinkingPreference(
  model: { provider: string; id: string },
  level: SessionThinkingLevel | null
): Promise<void> {
  return withSettingsQueue(async () => {
    thinkingSettings()
    const settings = await reloadSettings('Could not read thinking preferences')
    await persistSettings(settings, () => {
      if (level === null) settings.removeModelThinkingLevel(model.provider, model.id)
      else settings.setModelThinkingLevel(model.provider, model.id, level)
    }, 'Could not save thinking preferences')
  })
}

export function defaultThinkingFromSettings(
  model: { provider: string; id: string } | null
): SessionThinkingLevel | undefined {
  const settings = thinkingSettings()
  if (model) {
    const perModel = settings.getModelThinkingLevel(model.provider, model.id)
    if (perModel) return perModel as SessionThinkingLevel
  }
  const global = settings.getDefaultThinkingLevel()
  return global as SessionThinkingLevel | undefined
}

function defaultSessionSettings(
  model: SessionModelInfo | null,
  settings: SettingsManager
): DefaultSessionSettings {
  const picker = pickerThinkingLevels(thinkingLevelsFor(model))
  const stored = (model && settings.getModelThinkingLevel(model.provider, model.id)) ?? settings.getDefaultThinkingLevel()
  const thinkingLevel =
    stored && picker.includes(stored) ? stored : (picker[0] ?? null)
  return { model, thinkingLevel, thinkingLevels: picker }
}

function persistDefaultThinking(
  settings: SettingsManager,
  model: SessionModelInfo | null,
  level: SessionThinkingLevel | null
): void {
  if (!level) return
  settings.setDefaultThinkingLevel(level)
  if (model) settings.setModelThinkingLevel(model.provider, model.id, level)
}

function revisionSettings(settings: ReturnType<SettingsManager['getGlobalSettings']>): object {
  return {
    defaultProvider: settings.defaultProvider ?? null,
    defaultModel: settings.defaultModel ?? null,
    defaultThinkingLevel: settings.defaultThinkingLevel ?? null,
    modelThinkingLevels: settings.modelThinkingLevels === undefined ? null : Object.entries(settings.modelThinkingLevels)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  }
}

function defaultSettingsSnapshot(settings: SettingsManager): DefaultSettingsSnapshot {
  const global = settings.getGlobalSettings()
  const effective = defaultSessionSettings(defaultModelFromSettings() ?? availableModels()[0] ?? null, settings)
  return {
    stored: {
      model: global.defaultProvider && global.defaultModel
        ? { provider: global.defaultProvider, id: global.defaultModel }
        : null,
      thinkingLevel: global.defaultThinkingLevel ?? null
    },
    effective,
    modelThinkingLevel: effective.model
      ? settings.getModelThinkingLevel(effective.model.provider, effective.model.id) ?? null
      : null,
    // Include only persisted model preferences, never runtime/auth state or unrelated settings.
    revision: createHash('sha256').update(JSON.stringify({
      global: revisionSettings(global),
      project: revisionSettings(settings.getProjectSettings())
    })).digest('hex')
  }
}

export async function readDefaultSettings(): Promise<DefaultSettingsSnapshot> {
  return withSettingsQueue(async () => {
    await startModelRuntime()
    const settings = await reloadSettings('Could not read default settings')
    return defaultSettingsSnapshot(settings)
  })
}

export async function updateDefaultSettings(
  patch: DefaultSettingsPatch,
  expectedRevision?: string
): Promise<DefaultSettingsSnapshot> {
  return withSettingsQueue(async () => {
    await startModelRuntime()
    const settings = await reloadSettings('Could not read default settings')
    const current = defaultSettingsSnapshot(settings)
    if (expectedRevision !== undefined && expectedRevision !== current.revision) {
      throw new Error('Default settings revision conflict')
    }
    if (patch.model === undefined && patch.thinkingLevel === undefined) {
      throw new Error('Default settings update is empty')
    }
    const model = patch.model ? findModel(patch.model.provider, patch.model.id) : current.effective.model
    if (patch.model && !model) throw new Error(`Model not found: ${patch.model.provider}/${patch.model.id}`)
    if (!model) throw new Error('Model not available: (none)')
    // Only a newly chosen model must be signed in; the saved default keeps its levels after a logout.
    if (patch.model && !availableModels().some((candidate) => candidate.provider === model.provider && candidate.id === model.id)) {
      throw new Error(`Model not available: ${model.provider}/${model.id}`)
    }
    const next = defaultSessionSettings(model, settings)
    if (patch.thinkingLevel !== undefined) {
      const level = patch.thinkingLevel
      if (!THINKING_LEVELS.includes(level) || HIDDEN_THINKING_LEVELS.has(level)) {
        throw new Error(`Invalid thinking level: ${level}`)
      }
      if (!next.thinkingLevels.includes(level)) throw new Error(`Thinking level not supported: ${level}`)
      next.thinkingLevel = level
    }
    // SDK setters enqueue separate writes, not a transaction. Validate everything first; IO
    // failures are reported without rolling back over another writer's persisted changes.
    await persistSettings(settings, () => {
      if (patch.model) settings.setDefaultModelAndProvider(model.provider, model.id)
      persistDefaultThinking(settings, model, next.thinkingLevel)
    }, 'Could not save default settings')
    return defaultSettingsSnapshot(await reloadSettings('Could not reread default settings'))
  })
}

export async function getDefaultSessionSettings(): Promise<DefaultSessionSettings> {
  return (await readDefaultSettings()).effective
}
