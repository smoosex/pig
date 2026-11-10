/** File memory has only an enablement setting; no auxiliary model or old-model migration. */
import type { LongTermSettings } from '../../../../shared/long-term-memory'

export function validateLongTermSettings(value: unknown): asserts value is LongTermSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid long-term memory settings')
  const item = value as Record<string, unknown>
  if (Object.keys(item).some(key => !['enabled'].includes(key)) || typeof item.enabled !== 'boolean') {
    throw new Error('Invalid long-term memory settings')
  }
}
