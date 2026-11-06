/** Strict validation shared by UI configuration writes and background reads. */
import type { LongTermSettings } from '../../../../shared/long-term-memory'

export function validateLongTermSettings(value: unknown): asserts value is LongTermSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid long-term memory settings')
  const item = value as Record<string, unknown>
  if (Object.keys(item).some(key => !['enabled', 'model'].includes(key)) || typeof item.enabled !== 'boolean') {
    throw new Error('Invalid long-term memory settings')
  }
  if (item.model !== undefined) {
    if (!item.model || typeof item.model !== 'object' || Array.isArray(item.model)) throw new Error('Invalid long-term memory model')
    const model = item.model as Record<string, unknown>
    if (Object.keys(model).some(key => !['provider', 'id', 'thinking'].includes(key))
      || typeof model.provider !== 'string' || !model.provider.trim() || typeof model.id !== 'string' || !model.id.trim()
      || (model.thinking !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(model.thinking as string))) {
      throw new Error('Invalid long-term memory model')
    }
  }
}
