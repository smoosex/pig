/** Pig's global review model preference; resolved at review start so edits need no extension reload. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PluginSettingsSchema, ThinkingLevel } from '../../../shared/api'

export const reviewSettingsSchema: PluginSettingsSchema = {
  namespace: 'pi-review',
  fields: [
    { key: 'provider', label: 'Provider', type: 'string' },
    { key: 'modelId', label: 'Model ID', type: 'string' },
    { key: 'thinking', label: 'Thinking effort', type: 'select', options: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }
  ]
}

export async function readReviewSettings(): Promise<{ model?: { provider: string; id: string }; thinking?: ThinkingLevel }> {
  const root = process.env.PIG_DIR || join(process.cwd(), '.pig')
  let text: string
  try {
    text = await readFile(join(root, 'plugin-settings', 'pi-review.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid review settings file')
  const namespace = (value as Record<string, unknown>)['pi-review']
  if (namespace !== undefined && (!namespace || typeof namespace !== 'object' || Array.isArray(namespace))) {
    throw new Error('Invalid pi-review settings namespace')
  }
  const settings = namespace as Record<string, unknown> | undefined
  const provider = settings?.provider
  const id = settings?.modelId
  const thinking = settings?.thinking
  if (thinking !== undefined && (typeof thinking !== 'string' || !reviewSettingsSchema.fields.find((field) => field.key === 'thinking')!.options!.includes(thinking))) {
    throw new Error('Invalid review thinking effort')
  }
  if (provider === undefined && id === undefined) return { thinking: thinking as ThinkingLevel | undefined }
  if (typeof provider !== 'string' || !provider.trim() || typeof id !== 'string' || !id.trim()) {
    throw new Error('Review model requires both provider and model ID')
  }
  return { model: { provider: provider.trim(), id: id.trim() }, thinking: thinking as ThinkingLevel | undefined }
}
