/** Jiti-loaded settings tools share main's allowlisted configuration service through this registry. */
import type { SettingsAgentHost } from '../../shared/settings'

const key = Symbol.for('pig:settings-agent-host')
type Slot = Record<symbol, SettingsAgentHost | undefined>

export function registerSettingsAgentHost(host: SettingsAgentHost): void {
  (globalThis as Slot)[key] = host
}

export function settingsAgentHost(): SettingsAgentHost | undefined {
  return (globalThis as Slot)[key]
}
