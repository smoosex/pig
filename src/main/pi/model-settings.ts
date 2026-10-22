/**
 * Shared model runtime and persisted preferences.
 *
 * Session controls consume these defaults without owning another runtime or settings cache.
 */
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent'
import type {
  DefaultSessionSettings,
  SessionModelInfo,
  ThinkingLevel as SessionThinkingLevel
} from '../../shared/api'

export type { DefaultSessionSettings, ThinkingLevel as SessionThinkingLevel } from '../../shared/api'

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
  const settings = appSettings()
  // Reload drops IDs left in memory by failed writes; the SDK buffers errors instead of throwing them.
  await settings.reload()
  const loadErrors = settings.drainErrors()
  if (loadErrors.length) {
    throw new AggregateError(loadErrors.map(({ error }) => error), 'Could not load settings for the installation ID')
  }
  const deviceId = settings.getOrCreateDeviceId()
  await settings.flush()
  const writeErrors = settings.drainErrors()
  if (writeErrors.length) {
    throw new AggregateError(writeErrors.map(({ error }) => error), 'Could not persist the installation ID')
  }
  return deviceId
}

export function defaultModelFromSettings(): SessionModelInfo | null {
  const settings = appSettings()
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
      settingsManager = undefined
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

// Only explicit UI preference actions write here. SDK/plugin changes and session restoration never do.
export async function saveModelThinkingPreference(
  model: { provider: string; id: string },
  level: SessionThinkingLevel | null
): Promise<void> {
  const settings = thinkingSettings()
  await settings.reload()
  const loadErrors = settings.drainErrors()
  if (loadErrors.length) {
    settingsManager = undefined
    thinkingSettingsNeedValidation = true
    throw new AggregateError(loadErrors.map(({ error }) => error), 'Could not read thinking preferences')
  }
  if (level === null) settings.removeModelThinkingLevel(model.provider, model.id)
  else settings.setModelThinkingLevel(model.provider, model.id, level)
  await settings.flush()
  const errors = settings.drainErrors()
  if (errors.length) {
    // The SDK retains failed writes in memory, and reload can itself fail while retaining that
    // value. Discard the instance instead; the next reader must successfully load a fresh one.
    settingsManager = undefined
    thinkingSettingsNeedValidation = true
    throw new AggregateError(errors.map(({ error }) => error), 'Could not save thinking preferences')
  }
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

function defaultSessionSettings(model: SessionModelInfo | null): DefaultSessionSettings {
  const picker = pickerThinkingLevels(thinkingLevelsFor(model))
  const stored = defaultThinkingFromSettings(model)
  const thinkingLevel =
    stored && picker.includes(stored) ? stored : (picker[0] ?? null)
  return { model, thinkingLevel, thinkingLevels: picker }
}

function persistDefaultThinking(
  model: SessionModelInfo | null,
  level: SessionThinkingLevel | null
): void {
  if (!level) return
  const settings = appSettings()
  settings.setDefaultThinkingLevel(level)
  if (model) settings.setModelThinkingLevel(model.provider, model.id, level)
}

export async function getDefaultSessionSettings(): Promise<DefaultSessionSettings> {
  await startModelRuntime()
  await appSettings().reload()
  return defaultSessionSettings(defaultModelFromSettings() ?? availableModels()[0] ?? null)
}

export async function setDefaultModel(provider: string, id: string): Promise<DefaultSessionSettings> {
  await startModelRuntime()
  const model = findModel(provider, id)
  if (!model) throw new Error(`Model not found: ${provider}/${id}`)
  const settings = appSettings()
  settings.setDefaultModelAndProvider(provider, id)
  const next = defaultSessionSettings(model)
  persistDefaultThinking(next.model, next.thinkingLevel)
  await settings.flush()
  return next
}

export async function setDefaultThinking(level: SessionThinkingLevel): Promise<DefaultSessionSettings> {
  await startModelRuntime()
  if (!THINKING_LEVELS.includes(level) || HIDDEN_THINKING_LEVELS.has(level)) {
    throw new Error(`Invalid thinking level: ${level}`)
  }
  const model = defaultModelFromSettings() ?? availableModels()[0] ?? null
  const picker = pickerThinkingLevels(thinkingLevelsFor(model))
  if (!picker.includes(level)) throw new Error(`Thinking level not supported: ${level}`)
  persistDefaultThinking(model, level)
  await appSettings().flush()
  return { model, thinkingLevel: level, thinkingLevels: picker }
}
