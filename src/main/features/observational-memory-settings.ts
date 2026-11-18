/** Configuration of built-in observational memory; preserves the existing data directory. */
import { readSettingsObject, saveNamespacedSettings } from '../settings/json-file'
import type { MemorySettings, MemorySettingsPatch } from '../../shared/api'
import { DEFAULTS } from './memory/config'
import { memorySettingsPath } from './memory/paths'

let mutation: Promise<unknown> = Promise.resolve()
function serialize<T>(action: () => Promise<T>): Promise<T> {
  const result = mutation.then(action)
  mutation = result.catch(() => {})
  return result
}

const integerKeys = [
  'observeAfterTokens', 'reflectAfterTokens', 'observerChunkMaxTokens', 'compactAfterTokens',
  'compactionMaxRetainedTokens', 'compactionSummaryMaxTokens', 'workerMemoryMaxTokens',
  'observationsPoolMaxTokens', 'observationsPoolTargetTokens', 'agentMaxTurns', 'agentMaxTokens'
] as const
// 0 is meaningful here: it disables the synchronous observer catch-up.
const nonNegativeIntegerKeys = ['compactionCatchUpMaxChunks'] as const
const booleanKeys = [
  'showWorkerNotifications', 'showCompactionNotifications', 'passive', 'debugLog', 'consolidateWhenIdle'
] as const

const memoryDefaultKeys = [
  'observeAfterTokens', 'reflectAfterTokens', 'compactAfterTokens', 'compactAfterTokensRatio',
  'observationsPoolMaxTokens', 'observationsPoolTargetTokens', 'agentMaxTurns', 'agentMaxTokens',
  'compactionCatchUpMaxChunks'
] as const

const settingKeys = [...integerKeys, ...nonNegativeIntegerKeys, ...booleanKeys, 'model', 'fallbackModel', 'compactAfterTokensMode', 'compactAfterTokensRatio'] as const

const allowed = new Set<string>(settingKeys)

function editableSettings(value: Record<string, unknown>): MemorySettings {
  return Object.fromEntries(settingKeys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])) as MemorySettings
}

export async function getMemoryDefaults(): Promise<Record<string, number>> {
  await mutation
  return Object.fromEntries(memoryDefaultKeys.map(key => [key, DEFAULTS[key]]))
}

export async function getMemorySettings(): Promise<MemorySettings> {
  await mutation
  const value = (await readSettingsObject(memorySettingsPath()))['observational-memory']
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid observational-memory namespace')
  return editableSettings(value as Record<string, unknown>)
}

export function setMemorySettings(patch: MemorySettingsPatch): Promise<MemorySettings> {
  return serialize(async () => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid memory settings')
    for (const [key, value] of Object.entries(patch)) {
      if (!allowed.has(key)) throw new Error(`Unknown memory setting: ${key}`)
      if (value === undefined || value === null) continue
      const nonNegative = (nonNegativeIntegerKeys as readonly string[]).includes(key)
      const integer = (integerKeys as readonly string[]).includes(key) || nonNegative
      if (integer && (!Number.isSafeInteger(value) || (value as number) < (nonNegative ? 0 : 1))) {
        throw new Error(nonNegative ? `Invalid non-negative integer: ${key}` : `Invalid positive integer: ${key}`)
      }
      if ((booleanKeys as readonly string[]).includes(key) && typeof value !== 'boolean') throw new Error(`Invalid boolean: ${key}`)
      if (key === 'compactAfterTokensMode' && value !== 'calibrated' && value !== 'ratio') throw new Error('Invalid compaction mode')
      if (key === 'compactAfterTokensRatio' && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1)) throw new Error('Ratio must be between 0 and 1')
      if (key === 'model' || key === 'fallbackModel') {
        const model = value as Record<string, unknown>
        if (!model || typeof model !== 'object' || Array.isArray(model)
          || Object.keys(model).some(key => !['provider', 'id', 'thinking'].includes(key))
          || typeof model.provider !== 'string' || !model.provider.trim()
          || typeof model.id !== 'string' || !model.id.trim()
          || (model.thinking !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(model.thinking as string))) throw new Error('Invalid memory model')
      }
    }
    const path = memorySettingsPath()
    const settings = await readSettingsObject(path)
    const previous = settings['observational-memory']
    if (previous !== undefined && (!previous || typeof previous !== 'object' || Array.isArray(previous))) {
      throw new Error('Invalid observational-memory namespace')
    }
    const next = { ...(previous as Record<string, unknown> | undefined) }
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete next[key]
      else if (value !== undefined) next[key] = value
    }
    if (typeof next.observationsPoolTargetTokens === 'number' && next.observationsPoolTargetTokens >= (typeof next.observationsPoolMaxTokens === 'number' ? next.observationsPoolMaxTokens : DEFAULTS.observationsPoolMaxTokens)) {
      throw new Error('Observation pool target must be smaller than its maximum')
    }
    settings['observational-memory'] = next
    await saveNamespacedSettings(path, settings)
    return editableSettings(next)
  })
}
