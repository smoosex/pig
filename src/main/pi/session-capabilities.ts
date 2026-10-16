/** Pig-only sidecars keep resource preferences out of Pi's message/branch history. */
import { existsSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { CapabilityGroup, SessionCapability, SessionCapabilityOverrides, SessionToolProvider } from '../../shared/session-capabilities'
import { pigPath } from '../pig-dir'
import { privateJson, sdkFile } from '../mcp/sdk'

const empty = (): SessionCapabilityOverrides => ({ tools: {}, mcp: {}, skills: {} })
function preferencePath(sessionId: string): string {
  if (!/^[\w-]+$/.test(sessionId)) throw new Error('Invalid session id')
  return join(pigPath('session-capabilities'), `${sessionId}.json`)
}
export function readSessionCapabilities(sessionId: string): SessionCapabilityOverrides {
  const path = preferencePath(sessionId)
  if (!existsSync(path)) return empty()
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  for (const group of ['tools', 'mcp', 'skills'] as const) {
    if (!raw[group] || typeof raw[group] !== 'object' || Array.isArray(raw[group]) || Object.values(raw[group]).some((v) => typeof v !== 'boolean'))
      throw new Error('Invalid session capabilities')
  }
  return raw
}
export function saveSessionCapability(sessionId: string, group: CapabilityGroup, id: string, enabled: boolean | null): void {
  const prefs = readSessionCapabilities(sessionId)
  if (enabled === null) delete prefs[group][id]
  else Object.defineProperty(prefs[group], id, { value: enabled, enumerable: true, configurable: true, writable: true })
  privateJson(preferencePath(sessionId), prefs)
}
/** A fork starts with its source's overrides; a session without any leaves no file behind. */
export function copySessionCapabilities(from: string, to: string): void {
  if (existsSync(preferencePath(from))) privateJson(preferencePath(to), readSessionCapabilities(from))
}
export async function removeSessionCapabilities(sessionId: string): Promise<void> {
  await rm(preferencePath(sessionId), { force: true })
}
export function saveSessionCapabilityGroup(sessionId: string, group: CapabilityGroup, ids: readonly string[], enabled: boolean | null): void {
  const prefs = readSessionCapabilities(sessionId)
  prefs[group] = enabled === null ? {} : Object.fromEntries(ids.map((id) => [id, enabled]))
  privateJson(preferencePath(sessionId), prefs)
}
export function capability(id: string, name: string, defaultEnabled: boolean, overrides: Record<string, boolean>, description?: string): SessionCapability {
  const overridden = Object.hasOwn(overrides, id)
  return { id, name, description, defaultEnabled, enabled: overridden ? overrides[id] : defaultEnabled, overridden }
}

// Definitions belong to an SDK runtime. Weak keys let reload discard old definitions, and retain
// the original exposure when a disabled definition is inspected or toggled more than once.
const originals = new WeakMap<object, { exposure: ReturnType<AgentSession['getAllTools']>[number]['exposure']; enabled: boolean }>()
// Pi's built-ins are `builtin`; its codemode / tool_search / MCP extensions reach the session as
// Pig's inline factories. Everything loaded from an extension file comes from a plugin.
function toolProvider(source: { source: string; path: string }, plugins: ReadonlyMap<string, string>): SessionToolProvider {
  if (source.source === 'builtin' || source.source === 'inline') return { kind: 'pi' }
  const name = plugins.get(resolve(source.path))
  return name ? { kind: 'plugin', name } : { kind: 'plugin' }
}
let sdkDefaultTools: Promise<readonly string[]> | undefined
/** The built-ins a session starts with: the `defaultTools` setting, else the SDK's own list (not exported from its entry). */
export async function defaultToolNames(agent: AgentSession): Promise<readonly string[]> {
  const configured = agent.settingsManager.getDefaultTools()
  if (configured) return configured
  sdkDefaultTools ??= import(pathToFileURL(sdkFile('core/settings-manager.js')).href)
    .then((module: { DEFAULT_TOOL_NAMES: readonly string[] }) => module.DEFAULT_TOOL_NAMES)
  return sdkDefaultTools
}
interface SessionToolOptions {
  /** Resolved names from {@link defaultToolNames}. */
  defaults: readonly string[]
  captureDefaults?: boolean
  plugins?: ReadonlyMap<string, string>
}
export function sessionTools(agent: AgentSession, overrides: Record<string, boolean>, { defaults, captureDefaults = false, plugins = new Map() }: SessionToolOptions): SessionCapability[] {
  return agent.getAllTools().filter((tool) => !tool.name.startsWith('mcp__')).flatMap((tool) => {
    const definition = agent.getToolDefinition(tool.name)
    if (!definition) return []
    let original = originals.get(definition)
    if (!original || captureDefaults) {
      const enabled = tool.name === 'tool_search'
        ? agent.getActiveToolNames().includes(tool.name)
        : tool.sourceInfo.source !== 'builtin' || defaults.includes(tool.name)
      original = { exposure: original?.exposure ?? tool.exposure, enabled }
      originals.set(definition, original)
    }
    if (original.exposure === 'hidden') return []
    return [{ ...capability(tool.name, tool.name, original.enabled, overrides, tool.description), provider: toolProvider(tool.sourceInfo, plugins) }]
  })
}
const applied = new WeakMap<AgentSession, Record<string, boolean>>()
export async function applySessionTools(agent: AgentSession, overrides: Record<string, boolean>, captureDefaults = false): Promise<void> {
  const previous = applied.get(agent)
  if (!Object.keys(overrides).length && (!previous || !Object.keys(previous).length)) return
  applied.set(agent, { ...overrides })
  const defaults = await defaultToolNames(agent)
  const active = new Set(agent.getActiveToolNames())
  for (const tool of sessionTools(agent, overrides, { defaults, captureDefaults })) {
    const definition = agent.getToolDefinition(tool.id)!
    const original = originals.get(definition)!
    definition.exposure = tool.enabled ? original.exposure : 'hidden'
    if (!tool.enabled) active.delete(tool.id)
    else if (original.exposure !== 'deferred' && original.exposure !== 'codemode') active.add(tool.id)
  }
  agent.setActiveToolsByName([...active])
}
