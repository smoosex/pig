/** Settings approval only displays the built-in tool's validated, allowlisted patch, never its revision or catalog details. */
import { isAbsolute, resolve } from 'node:path'
import { Compile } from 'typebox/compile'
import type { TSchema } from 'typebox'
import { settingsAgentHost } from '../plugins/pig-settings-host'
import { settingsToolPath } from '../pi/system-plugin-paths'

export { settingsToolPath } from '../pi/system-plugin-paths'

export function isSettingsToolPath(path: string | undefined): boolean {
  return typeof path === 'string' && isAbsolute(path) && resolve(path) === resolve(settingsToolPath())
}

// Reject, rather than truncate, a patch the card cannot show in full. Escape JSON strings and reject
// invisible direction controls so a name cannot visually rearrange what the user is approving.
function safeText(value: string): boolean {
  return value.length <= 512 && !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(value)
}
function safeValue(value: unknown): boolean {
  if (typeof value === 'string') return safeText(value)
  if (Array.isArray(value)) return value.every(safeValue)
  if (value && typeof value === 'object') return Object.entries(value).every(([key, item]) => safeText(key) && safeValue(item))
  return value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
}

export async function settingsApproval(input: unknown, schema: TSchema, sessionId: string): Promise<{ group: string; patch: string }> {
  if (!Compile(schema).Check(input)) throw new Error('Invalid settings update; no approval was requested')
  const { group, patch } = input as { group: string; patch: Record<string, unknown> }
  if (!safeValue(patch)) throw new Error('Settings update contains values that cannot be safely displayed for approval')
  let names: Record<string, string> | undefined
  if (group === 'plugins' && patch.scopes && Object.keys(patch.scopes).length) {
    const host = settingsAgentHost()
    if (!host) throw new Error('Settings are unavailable; plugin names cannot be shown for approval')
    const catalog = await host.list(sessionId, { group: 'plugins' })
    const plugins = new Map(catalog.plugins?.map(({ id, name }) => [id, name]))
    names = Object.fromEntries(Object.keys(patch.scopes).map((id) => {
      const name = plugins.get(id)
      if (!name || !safeText(name)) throw new Error('A plugin name cannot be safely shown for approval')
      return [id, name]
    }))
  }
  const display = JSON.stringify(names ? { patch, pluginNames: names } : patch, null, 2)
  if (display.length > 16000) throw new Error('Settings update is too large to display for approval; split it into smaller updates')
  return { group, patch: display }
}
