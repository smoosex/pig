/** Pig-only sidecars keep resource preferences out of Pi's message/branch history. */
import { existsSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { CapabilityGroup, SessionCapability, SessionCapabilityOverrides, SessionToolProvider } from '../../shared/session-capabilities'
import { pigPath } from '../pig-dir'
import { privateJson, sdkFile } from '../mcp/sdk'
import { copySessionPermission, removeSessionPermission } from '../permissions/store'
import { isPermissionTool } from '../permissions/extension'

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
/** Several ids are written at once for a plugin, whose single switch covers all of its tools. */
export function saveSessionCapability(sessionId: string, group: CapabilityGroup, ids: string | readonly string[], enabled: boolean | null): void {
  const prefs = readSessionCapabilities(sessionId)
  for (const id of typeof ids === 'string' ? [ids] : ids) {
    if (enabled === null) delete prefs[group][id]
    else Object.defineProperty(prefs[group], id, { value: enabled, enumerable: true, configurable: true, writable: true })
  }
  privateJson(preferencePath(sessionId), prefs)
}
/** A fork starts with its source's overrides and permission mode; a session without any leaves no file behind. */
export async function copySessionCapabilities(from: string, to: string): Promise<void> {
  const prefs = existsSync(preferencePath(from)) ? readSessionCapabilities(from) : null
  await copySessionPermission(from, to)
  if (prefs) privateJson(preferencePath(to), prefs)
}
export async function removeSessionCapabilities(sessionId: string): Promise<void> {
  await Promise.all([rm(preferencePath(sessionId), { force: true }), removeSessionPermission(sessionId)])
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
function toolProvider(source: { source: string; path: string }, plugins: ReadonlyMap<string, SessionToolProvider>): SessionToolProvider {
  if (source.source === 'builtin' || source.source === 'inline') return { kind: 'pi' }
  const known = plugins.get(resolve(source.path))
  if (known) return known
  // An extension Pig did not install (e.g. Pi's own extensions directory) is named after its file.
  const file = basename(source.path, extname(source.path))
  return { kind: 'plugin', id: resolve(source.path), name: file === 'index' ? basename(dirname(source.path)) : file }
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
  plugins?: ReadonlyMap<string, SessionToolProvider>
}
export function sessionTools(agent: AgentSession, overrides: Record<string, boolean>, { defaults, captureDefaults = false, plugins = new Map() }: SessionToolOptions): SessionCapability[] {
  return agent.getAllTools().filter((tool) => !tool.name.startsWith('mcp__')).flatMap((tool) => {
    const definition = agent.getToolDefinition(tool.name)
    if (!definition) return []
    let original = originals.get(definition)
    if (!original || captureDefaults) {
      const enabled = tool.name === 'tool_search'
        ? agent.getActiveToolNames().includes(tool.name)
        : (tool.sourceInfo.source !== 'builtin' && !isPermissionTool(tool.parameters)) || defaults.includes(tool.name)
      original = { exposure: original?.exposure ?? tool.exposure, enabled }
      originals.set(definition, original)
    }
    if (original.exposure === 'hidden') return []
    return [{ ...capability(tool.name, tool.name, original.enabled, overrides, tool.description), provider: toolProvider(tool.sourceInfo, plugins) }]
  })
}
/** Pi's tools stay individual switches; each plugin becomes one switch that is on only when all its tools are. */
export function groupPluginTools(tools: readonly SessionCapability[]): SessionCapability[] {
  const rows: SessionCapability[] = []
  const plugins = new Map<string, SessionCapability>()
  for (const tool of tools) {
    const provider = tool.provider
    if (!provider || provider.kind === 'pi') { rows.push(tool); continue }
    const id = `plugin:${provider.kind}:${provider.id}`
    const row = plugins.get(id)
    if (!row) {
      const created = { id, name: provider.name, provider, tools: [tool.id], enabled: tool.enabled, defaultEnabled: tool.defaultEnabled, overridden: tool.overridden }
      plugins.set(id, created)
      rows.push(created)
      continue
    }
    row.tools!.push(tool.id)
    row.enabled &&= tool.enabled
    row.defaultEnabled &&= tool.defaultEnabled
    row.overridden ||= tool.overridden
  }
  return rows
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
