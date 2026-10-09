/** Atomic Pig-only configuration. Project preferences contain enable overrides, never commands or credentials. */
import { pigDir, pigPath } from '../pig-dir'
import type {
  McpConfig,
  McpImportEntry,
  ProjectToolSettings,
  ToolOverride,
  ToolPreferences
} from '../../shared/tool-settings'
import { effectiveCodemode, effectiveMcpEnabled } from '../../shared/tool-settings'
import { mcpCredentials, mcpSdk, privateJson, readJson } from './sdk'
import { withMcpAuthMutation } from './connections'

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

class ToolConfigurationError extends Error {
  readonly code = 'ERR_PIG_TOOL_CONFIG'
}
export function readToolPreferences(): ToolPreferences {
  const raw = object(readJson(pigPath('tool-settings.json'), {}))
  if (Object.hasOwn(raw, 'codemode') && typeof raw.codemode !== 'boolean')
    throw new ToolConfigurationError('tool-settings.json: codemode must be a boolean')
  const projects: ToolPreferences['projects'] = {}
  for (const [cwd, value] of Object.entries(object(raw.projects ?? {}))) {
    const project = object(value)
    if (Object.hasOwn(project, 'codemode') && typeof project.codemode !== 'boolean')
      throw new ToolConfigurationError(
        `tool-settings.json: projects[${cwd}].codemode must be a boolean`
      )
    const mcp: Record<string, boolean> = Object.create(null)
    for (const [name, enabled] of Object.entries(object(project.mcp ?? {}))) {
      if (typeof enabled !== 'boolean') throw new Error(`Invalid MCP override: ${name}`)
      mcp[name] = enabled
    }
    projects[cwd] = {
      mcp,
      ...(typeof project.codemode === 'boolean' ? { codemode: project.codemode } : {})
    }
  }
  return { codemode: raw.codemode === true, projects }
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
export async function configuredServers() {
  const { config } = await mcpSdk()
  const loaded = config.loadMcpConfig({ agentDir: pigDir(), cwd: pigDir(), projectTrusted: false })
  if (loaded.errors.length) throw new Error(loaded.errors.join('\n'))
  return loaded.servers
}
export async function sessionMcpConfig(cwd: string, project: string | null) {
  await flushToolMutations()
  const preferences = readToolPreferences()
  return {
    autoEnableCodemode: false,
    errors: [],
    servers: (await configuredServers()).map((entry) => ({
      ...entry,
      config: {
        ...entry.config,
        enabled: effectiveMcpEnabled(entry.config, preferences, entry.name, project),
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
    codemode: effectiveCodemode(preferences, project),
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
    const preferences = readToolPreferences()
    let preferencesChanged = false
    const obsolete: { name: string; url: string }[] = []
    for (const entry of entries) {
      const previous = servers[entry.name] as McpConfig | undefined
      if (!entry.conflict) {
        for (const project of Object.values(preferences.projects)) {
          if (Object.hasOwn(project.mcp, entry.name)) {
            delete project.mcp[entry.name]
            preferencesChanged = true
          }
        }
      }
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
    await withMcpAuthMutation(
      obsolete.map((entry) => entry.name),
      async () => {
        if (preferencesChanged) privateJson(pigPath('tool-settings.json'), preferences)
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
    const preferences = readToolPreferences()
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
      for (const project of Object.values(preferences.projects)) delete project.mcp[name]
      privateJson(pigPath('tool-settings.json'), preferences)
    })
  })
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
  return serialize(async () => {
    if (typeof enabled !== 'boolean') throw new Error('Expected a boolean')
    if (!(await configuredServers()).some((entry) => entry.name === name))
      throw new Error(`MCP server not found: ${name}`)
    const raw = document()
    const entries = object(raw.mcpServers ?? {})
    entries[name] = { ...object(entries[name]), enabled }
    privateJson(pigPath('mcp.json'), { ...raw, mcpServers: entries })
  })
}
export function setCodemode(enabled: boolean): Promise<void> {
  return serialize(() => {
    if (typeof enabled !== 'boolean') throw new Error('Expected a boolean')
    privateJson(pigPath('tool-settings.json'), { ...readToolPreferences(), codemode: enabled })
  })
}
function applyOverride(
  value: ToolOverride,
  put: (enabled: boolean) => void,
  remove: () => void
): void {
  if (value === null) remove()
  else if (typeof value === 'boolean') put(value)
  else throw new Error('Expected inherit, enabled or disabled')
}
export function setProjectToolSettings(
  cwd: string,
  patch: { codemode?: ToolOverride; mcp?: Record<string, ToolOverride> }
): Promise<void> {
  return serialize(async () => {
    const servers = await configuredServers()
    const preferences = readToolPreferences()
    const project: ProjectToolSettings = preferences.projects[cwd] ?? { mcp: Object.create(null) }
    if (patch.codemode !== undefined)
      applyOverride(
        patch.codemode,
        (value) => {
          project.codemode = value
        },
        () => {
          delete project.codemode
        }
      )
    for (const [name, value] of Object.entries(patch.mcp ?? {})) {
      if (!servers.some((entry) => entry.name === name))
        throw new Error(`MCP server not found: ${name}`)
      applyOverride(
        value,
        (enabled) => {
          project.mcp[name] = enabled
        },
        () => {
          delete project.mcp[name]
        }
      )
    }
    preferences.projects[cwd] = project
    privateJson(pigPath('tool-settings.json'), preferences)
  })
}
