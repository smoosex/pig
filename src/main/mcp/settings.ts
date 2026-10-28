/** Atomic Pig-only global configuration; repository MCP files are never loaded automatically. */
import { pigDir, pigPath } from '../pig-dir'
import type { McpConfig, McpImportEntry } from '../../shared/tool-settings'
import { mcpCredentials, mcpSdk, privateJson, readJson } from './sdk'
import { withMcpAuthMutation } from './connections'
import { openComputerUseMcp } from './featured'
import { readPermissionSettings, updatePermissionSettings } from '../permissions/store'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a JSON object')
  return value as Record<string, unknown>
}
let mutations: Promise<unknown> = Promise.resolve()
function serialize<T>(operation: () => Promise<T> | T): Promise<T> {
  const result = mutations.then(operation)
  // Only the queue tail consumes rejection to permit subsequent writes; callers receive the original result.
  mutations = result.catch(() => {})
  return result
}
export async function flushToolMutations(signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await mutations
    return
  }
  signal.throwIfAborted()
  let cancel!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
  })
  try {
    await Promise.race([mutations, aborted])
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

function document(): Record<string, unknown> {
  const raw = object(readJson(pigPath('mcp.json'), { mcpServers: {} }))
  object(raw.mcpServers ?? {})
  return raw
}
/** Catalog icons by server name; Pig's own map, so a non-standard key never enters `mcp.json`. */
function iconDocument(): Record<string, string> {
  const raw = object(readJson(pigPath('mcp-icons.json'), {}))
  const icons: Record<string, string> = {}
  for (const [name, source] of Object.entries(object(raw.servers ?? {}))) {
    if (typeof source !== 'string') throw new Error(`Invalid MCP icon entry: ${name}`)
    icons[name] = source
  }
  return icons
}
export function mcpIcons(): Record<string, string> {
  return iconDocument()
}
/** Seed once, not on every catalog read: ordinary edits, disabling and removal must remain durable. */
export function initializeMcpDefaults(): Promise<void> {
  return serialize(async () => {
    const raw = document()
    const defaults = object(raw.pigDefaults ?? {})
    const name = openComputerUseMcp.name
    if (Object.hasOwn(defaults, name)) {
      if (defaults[name] !== true) throw new Error(`Invalid MCP default marker: ${name}`)
      return
    }
    const existing = await configuredServers()
    const { core } = await mcpSdk()
    const servers = object(raw.mcpServers ?? {})
    // A pre-existing or namespace-equivalent entry belongs to the user, including its enabled state.
    if (!existing.some((entry) => core.mcpNamespace(entry.name) === core.mcpNamespace(name))) {
      servers[name] = { ...openComputerUseMcp.config }
    }
    privateJson(pigPath('mcp.json'), {
      ...raw, mcpServers: servers, pigDefaults: { ...defaults, [name]: true }
    })
  })
}

export async function configuredServers() {
  const { config } = await mcpSdk()
  const loaded = config.loadMcpConfig({ agentDir: pigDir(), cwd: pigDir(), projectTrusted: false })
  if (loaded.errors.length) throw new Error(loaded.errors.join('\n'))
  return loaded.servers
}
export async function sessionMcpConfig(cwd: string, overrides: Record<string, boolean> = {}) {
  await flushToolMutations()
  return {
    autoEnableCodemode: false,
    errors: [],
    servers: (await configuredServers()).map((entry) => ({
      ...entry,
      config: {
        ...entry.config,
        enabled: Object.hasOwn(overrides, entry.name) ? overrides[entry.name] : entry.config.enabled === true,
        // Keep MCP reachable by tool_search even when codemode is disabled; honor hidden/direct tools.
        exposure:
          entry.config.exposure === 'codemode' || !entry.config.exposure
            ? ('deferred' as const)
            : entry.config.exposure,
        toolExposure: Object.fromEntries(
          Object.entries(entry.config.toolExposure ?? {}).map(([name, exposure]) => [
            name,
            exposure === 'codemode' ? 'deferred' : exposure
          ])
        )
      }
    })),
    cwd
  }
}
export async function previewMcpImport(json: string, name?: string): Promise<McpImportEntry[]> {
  const raw = object(JSON.parse(json))
  const entries =
    'command' in raw || 'url' in raw ? { [name?.trim() || '']: raw } : object(raw.mcpServers ?? raw)
  const { core } = await mcpSdk()
  const existing = await configuredServers()
  const namespaces = new Map(existing.map((entry) => [core.mcpNamespace(entry.name), entry.name]))
  return Object.entries(entries).map(([key, value]) => {
    const config = core.validateMcpServerConfig(key, value)
    if (typeof config === 'string') throw new Error(config)
    // The SDK only checks that a stdio command is a string, so an empty one would be saved and fail
    // later at launch. Reject it here, where every add/import path passes through.
    if ('command' in config && !config.command.trim())
      throw new Error(`server "${key}": command must not be empty`)
    const namespace = core.mcpNamespace(key)
    const other = namespaces.get(namespace)
    if (other && other !== key) throw new Error(`MCP names collide: ${key} / ${other}`)
    namespaces.set(namespace, key)
    const previous = existing.find((entry) => entry.name === key)
    return {
      name: key,
      config: { ...config, enabled: previous?.config.enabled === true },
      conflict: !!previous
    }
  })
}
export function importMcpServers(
  json: string,
  replaceNames: string[],
  name?: string,
  icon?: string
): Promise<void> {
  return serialize(async () => {
    const entries = await previewMcpImport(json, name)
    const raw = document()
    const icons = iconDocument()
    const servers: Record<string, unknown> = Object.assign(
      Object.create(null),
      object(raw.mcpServers ?? {})
    )
    for (const entry of entries) {
      if (entry.conflict && !replaceNames.includes(entry.name))
        throw new Error(`Confirm replacement: ${entry.name}`)
    }
    const obsolete: { name: string; url: string }[] = []
    const retargeted: string[] = []
    for (const entry of entries) {
      const previous = servers[entry.name] as McpConfig | undefined
      if (previous && endpoint(previous) !== endpoint(entry.config)) retargeted.push(entry.name)
      if (
        previous &&
        'url' in previous &&
        (!('url' in entry.config) || previous.url !== entry.config.url)
      )
        obsolete.push({ name: entry.name, url: previous.url })
      servers[entry.name] = {
        ...entry.config,
        enabled: entry.conflict ? entry.config.enabled === true : false
      }
      // Only the catalog knows an icon, and only for the single entry it was added as.
      if (icon && entries.length === 1) icons[entry.name] = icon
    }
    // A replacement that runs another command or URL is a different server: like removal, it must not
    // inherit the old one's approval. Cleared before the swap so a failed write never leaves it trusted.
    await forgetMcpApprovals(retargeted)
    await withMcpAuthMutation(
      obsolete.map((entry) => entry.name),
      async () => {
        privateJson(pigPath('mcp.json'), { ...raw, mcpServers: servers, autoEnableCodemode: false })
        if (icon && entries.length === 1) privateJson(pigPath('mcp-icons.json'), { servers: icons })
        if (obsolete.length) {
          const credentials = await mcpCredentials()
          for (const entry of obsolete) credentials.remove(entry.name, entry.url)
        }
      }
    )
  })
}
export async function saveMcpServer(
  name: string,
  config: McpConfig,
  replace: boolean,
  icon?: string
): Promise<void> {
  await importMcpServers(
    JSON.stringify({ mcpServers: { [name]: config } }),
    replace ? [name] : [],
    name,
    icon
  )
}
export function removeMcpServer(name: string): Promise<void> {
  return serialize(async () => {
    const server = (await configuredServers()).find((entry) => entry.name === name)
    if (!server) throw new Error(`MCP server not found: ${name}`)
    await withMcpAuthMutation([name], async () => {
      if ('url' in server.config) (await mcpCredentials()).remove(name, server.config.url)
      const raw = document()
      const entries = object(raw.mcpServers ?? {})
      delete entries[name]
      privateJson(pigPath('mcp.json'), { ...raw, mcpServers: entries })
      const icons = iconDocument()
      if (Object.hasOwn(icons, name)) {
        delete icons[name]
        privateJson(pigPath('mcp-icons.json'), { servers: icons })
      }
    })
    // A server added later under the same name must not inherit this one's approval.
    await forgetMcpApprovals([name])
  })
}

/** What a server runs or connects to; other edits (env, headers, timeouts) keep its approval. */
function endpoint(config: McpConfig): string {
  return 'url' in config ? JSON.stringify(['url', config.url]) : JSON.stringify(['command', config.command, config.args ?? []])
}

async function forgetMcpApprovals(names: readonly string[]): Promise<void> {
  if (!names.some((name) => Object.hasOwn(readPermissionSettings().mcp, name))) return
  await updatePermissionSettings((current) => ({
    ...current, mcp: Object.fromEntries(Object.entries(current.mcp).filter(([server]) => !names.includes(server)))
  }))
}
export function deleteMcpCredentials(name: string): Promise<void> {
  return serialize(async () => {
    const entry = (await configuredServers()).find((server) => server.name === name)
    if (!entry || !('url' in entry.config)) throw new Error('Expected an HTTP MCP server')
    const url = entry.config.url
    await withMcpAuthMutation([name], async () => (await mcpCredentials()).remove(name, url))
  })
}
export function setMcpEnabled(name: string, enabled: boolean): Promise<void> {
  return updateMcpEnabled({ [name]: enabled }).then(() => undefined)
}

function enabledServers(servers: Awaited<ReturnType<typeof configuredServers>>): Record<string, boolean> {
  return Object.fromEntries(servers.map((entry) => [entry.name, entry.config.enabled === true]))
}

/** Global enablement by server name; the Agent settings tools hash this for compare-and-swap. */
export function mcpEnabled(): Promise<Record<string, boolean>> {
  return serialize(async () => enabledServers(await configuredServers()))
}

/** One `mcp.json` write for several servers; `check` sees the current state inside the mutation queue. */
export function updateMcpEnabled(
  patch: Record<string, boolean>,
  check?: (current: Record<string, boolean>) => void
): Promise<Record<string, boolean>> {
  return serialize(async () => {
    const servers = await configuredServers()
    for (const [name, enabled] of Object.entries(patch)) {
      if (typeof enabled !== 'boolean') throw new Error('Expected a boolean')
      if (!servers.some((entry) => entry.name === name)) throw new Error(`MCP server not found: ${name}`)
    }
    const current = enabledServers(servers)
    check?.(current)
    const raw = document()
    const entries = object(raw.mcpServers ?? {})
    for (const [name, enabled] of Object.entries(patch)) entries[name] = { ...object(entries[name]), enabled }
    privateJson(pigPath('mcp.json'), { ...raw, mcpServers: entries })
    return { ...current, ...patch }
  })
}
