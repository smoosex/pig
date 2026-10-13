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

export function toModelInfo(model: {
  id: string
  name: string
  provider: string
  contextWindow: number
  reasoning: boolean
}): SessionModelInfo {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    providerName: modelRuntime?.getProvider(model.provider)?.name ?? model.provider,
    contextWindow: model.contextWindow,
    reasoning: model.reasoning
  }
}

export function availableModels(): SessionModelInfo[] {
  return (modelRuntime?.getAvailableSnapshot() ?? []).map(toModelInfo)
}

export function thinkingLevelsFor(model: { provider: string; id: string } | null): SessionThinkingLevel[] {
  if (!model) return ['off']
  const full = modelRuntime?.getModel(model.provider, model.id)
  if (!full?.reasoning) return ['off']
  return THINKING_LEVELS.filter((level) => {
    const mapped = full.thinkingLevelMap?.[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
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

export function defaultModelFromSettings(): SessionModelInfo | null {
  const settings = appSettings()
  const provider = settings.getDefaultProvider()
  const id = settings.getDefaultModel()
  if (!provider || !id) return null
  return findModel(provider, id)
}

export function defaultThinkingFromSettings(
  model: { provider: string; id: string } | null
): SessionThinkingLevel | undefined {
  const settings = appSettings()
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
