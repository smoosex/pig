/* Pig owns which Pi extensions may run and persists their settings independently of Pi CLI. */
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  DefaultPackageManager,
  SettingsManager
} from '@earendil-works/pi-coding-agent'
import type { MemoryPluginSettings, MemoryPluginSettingsPatch, PluginInfo, PluginScope, PluginSettingsSchema } from '../../shared/api'
import { pigPath } from '../pig-dir'
import { DEFAULTS } from '../plugins/observational-memory/config'
import { memorySettingsPath } from '../plugins/observational-memory/paths'

interface InstalledPlugin {
  id: string
  source: string
  kind: 'local' | 'npm' | 'git'
  scopes: PluginScope[]
}

interface Registry {
  memoryScopes: PluginScope[]
  reviewScopes: PluginScope[]
  webAccessScopes: PluginScope[]
  installed: InstalledPlugin[]
}

const registryPath = () => pigPath('plugins.json')
const packageRoot = () => pigPath('plugin-packages')
// Tests mock electron with a partial app object, so fall back to the project root.
const appPath = () => typeof app.getAppPath === 'function' ? app.getAppPath() : process.cwd()
const memoryPath = () => app.isPackaged
  ? join(process.resourcesPath, 'system-plugins', 'observational-memory', 'index.ts')
  : join(appPath(), 'src', 'main', 'plugins', 'observational-memory', 'index.ts')
const reviewPath = () => app.isPackaged
  ? join(process.resourcesPath, 'system-plugins', 'pi-review', 'index.ts')
  : join(appPath(), 'src', 'main', 'plugins', 'pi-review', 'index.ts')
const webAccessPath = () => app.isPackaged
  ? join(process.resourcesPath, 'system-plugins', 'pi-web-access', 'index.js')
  : join(appPath(), 'out', 'system-plugins', 'pi-web-access', 'index.js')

let mutation: Promise<void> = Promise.resolve()
function serialize<T>(action: () => Promise<T>): Promise<T> {
  const result = mutation.then(action)
  mutation = result.then(() => undefined, () => undefined)
  return result
}

function parseScopes(value: unknown): PluginScope[] {
  if (!Array.isArray(value) || value.some((scope) => scope !== 'project' && scope !== 'chat')) {
    throw new Error('Invalid plugin scopes')
  }
  return (['project', 'chat'] as const).filter((scope) => value.includes(scope))
}

async function readRegistry(): Promise<Registry> {
  const defaults: Registry = { memoryScopes: [], reviewScopes: ['project'], webAccessScopes: ['project', 'chat'], installed: [] }
  let text: string
  try {
    text = await readFile(registryPath(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return defaults
    }
    throw error
  }
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || !('installed' in value) || !Array.isArray(value.installed)) {
    throw new Error('Invalid Pig plugin registry')
  }
  const installed: InstalledPlugin[] = value.installed.map((item) => {
    if (!item || typeof item.id !== 'string' || typeof item.source !== 'string' ||
        !['local', 'npm', 'git'].includes(item.kind) || (!('scopes' in item) && typeof item.enabled !== 'boolean')) {
      throw new Error('Invalid Pig plugin registry entry')
    }
    return {
      id: item.id, source: item.source, kind: item.kind,
      scopes: 'scopes' in item ? parseScopes(item.scopes) : item.enabled ? ['project'] : []
    }
  })
  // Explicit legacy switches only applied to projects; preserve them instead of applying new defaults.
  return {
    memoryScopes: 'memoryScopes' in value ? parseScopes(value.memoryScopes)
      : 'memoryEnabled' in value ? (value.memoryEnabled === true ? ['project'] : []) : defaults.memoryScopes,
    reviewScopes: 'reviewScopes' in value ? parseScopes(value.reviewScopes)
      : 'reviewEnabled' in value ? (value.reviewEnabled === true ? ['project'] : []) : defaults.reviewScopes,
    webAccessScopes: 'webAccessScopes' in value ? parseScopes(value.webAccessScopes)
      : 'webAccessEnabled' in value ? (value.webAccessEnabled === true ? ['project'] : []) : defaults.webAccessScopes,
    installed
  }
}

async function saveRegistry(value: Registry): Promise<void> {
  const path = registryPath()
  await mkdir(pigPath(), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify({ version: 2, ...value }, null, 2)}\n`)
    await rename(temp, path)
  } catch (error) {
    const { rm } = await import('node:fs/promises')
    await rm(temp, { force: true })
    throw error
  }
}

function packageManager(source: string): DefaultPackageManager {
  return new DefaultPackageManager({
    cwd: packageRoot(),
    agentDir: packageRoot(),
    settingsManager: SettingsManager.inMemory({ packages: [source] }, { projectTrusted: false })
  })
}

function normalizeSource(source: string): { source: string; kind: InstalledPlugin['kind']; identity: string } {
  const value = source.trim()
  if (value.startsWith('npm:')) {
    const name = value.slice(4).match(/^(@[^/@]+\/[^@]+|[^@/]+)(?:@.+)?$/)?.[1]
    if (!name) throw new Error('Expected npm:package[@version]')
    return { source: value, kind: 'npm', identity: `npm:${name}` }
  }
  if (value.startsWith('git:') || value.startsWith('https://') || value.startsWith('ssh://')) {
    const repo = value.replace(/^git:/, '').replace(/^(?:https?|ssh):\/\//, '').replace(/^git@/, '')
    return { source: value, kind: 'git', identity: `git:${repo.replace(/@[^/@]+$/, '').replace(/\.git\/?$/, '').replace(/\/$/, '').toLowerCase()}` }
  }
  if (!isAbsolute(value)) throw new Error('Choose an absolute local path, npm:package or git:URL')
  const path = resolve(value)
  return { source: path, kind: 'local', identity: `local:${existsSync(path) ? realpathSync(path) : path}` }
}

function displayName(source: string): string {
  return source.startsWith('npm:') ? source.slice(4) : source.split('/').filter(Boolean).at(-1) ?? source
}

async function resourcesFor(source: string): Promise<string[]> {
  const normalized = normalizeSource(source)
  if (normalized.kind === 'npm') {
    const packageName = normalized.identity.slice(4)
    if (!existsSync(join(packageRoot(), 'npm', 'node_modules', packageName))) return []
  }
  const manager = packageManager(source)
  const result = await manager.resolve(async () => 'skip')
  return result.extensions.filter((item) => item.enabled).map((item) => item.path)
}

export async function isMemoryPluginEnabled(scope: PluginScope): Promise<boolean> {
  await mutation
  return (await readRegistry()).memoryScopes.includes(scope)
}

export async function enabledPluginPaths(scope: PluginScope | 'any'): Promise<string[]> {
  await mutation
  const registry = await readRegistry()
  const isEnabled = (scopes: PluginScope[]) => scope === 'any' ? scopes.length > 0 : scopes.includes(scope)
  const paths: string[] = []
  // Older builds may lack an enabled bundle; keep sessions usable while settings reports the
  // missing file and refuses to enable it.
  for (const bundled of [
    { scopes: registry.memoryScopes, path: memoryPath(), name: 'observational memory' },
    { scopes: registry.reviewScopes, path: reviewPath(), name: 'code review' },
    { scopes: registry.webAccessScopes, path: webAccessPath(), name: 'web access' }
  ]) {
    if (!isEnabled(bundled.scopes)) continue
    if (!existsSync(bundled.path)) {
      console.warn(`Bundled ${bundled.name} extension is missing: ${bundled.path}`)
      continue
    }
    paths.push(bundled.path)
  }
  for (const plugin of registry.installed.filter((item) => isEnabled(item.scopes))) {
    const found = await resourcesFor(plugin.source)
    if (!found.length) throw new Error(`Enabled plugin is missing or has no extensions: ${plugin.source}`)
    paths.push(...found)
  }
  return [...new Set(paths)]
}

function settingsSchema(source: string): PluginSettingsSchema | undefined {
  const installed = packageManager(source).getInstalledPath(source, 'user')
  if (!installed) return undefined
  const root = statSync(installed).isDirectory() ? installed : dirname(installed)
  const manifestPath = join(root, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!manifest || typeof manifest !== 'object' || !('pig' in manifest)) return undefined
  const pig = manifest.pig
  if (!pig || typeof pig !== 'object' || !('settings' in pig)) return undefined
  const schema = pig.settings
  if (!schema || typeof schema !== 'object' || !('namespace' in schema) || !('fields' in schema) ||
      typeof schema.namespace !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(schema.namespace) ||
      !Array.isArray(schema.fields) || !schema.fields.length) throw new Error(`Invalid Pig settings schema: ${manifestPath}`)
  const fields: PluginSettingsSchema['fields'] = []
  const keys = new Set<string>()
  for (const field of schema.fields) {
    if (!field || typeof field !== 'object' || typeof field.key !== 'string' ||
        !/^[a-zA-Z][a-zA-Z0-9]*$/.test(field.key) || keys.has(field.key) ||
        typeof field.label !== 'string' || !field.label.trim() ||
        !['string', 'integer', 'boolean', 'select'].includes(field.type) ||
        (field.type === 'select' && (!Array.isArray(field.options) || !field.options.length || !field.options.every((item: unknown) => typeof item === 'string' && !!item && item !== '__pig_default__') || new Set(field.options).size !== field.options.length)) ||
        (field.min !== undefined && (!Number.isFinite(field.min) || field.type !== 'integer')) ||
        (field.max !== undefined && (!Number.isFinite(field.max) || field.type !== 'integer'))) {
      throw new Error(`Invalid Pig settings field: ${manifestPath}`)
    }
    keys.add(field.key)
    fields.push({
      key: field.key, label: field.label,
      ...(typeof field.description === 'string' ? { description: field.description } : {}),
      type: field.type,
      ...(field.type === 'select' ? { options: field.options } : {}),
      ...(field.min !== undefined ? { min: field.min } : {}),
      ...(field.max !== undefined ? { max: field.max } : {})
    })
  }
  return { namespace: schema.namespace, fields }
}

export async function listPlugins(): Promise<PluginInfo[]> {
  await mutation
  const registry = await readRegistry()
  const installed = await Promise.all(registry.installed.map(async (item): Promise<PluginInfo> => {
    try {
      const paths = await resourcesFor(item.source)
      if (!paths.length) {
        return {
          id: item.id, source: item.source, name: displayName(item.source), kind: item.kind,
          scopes: item.scopes, available: false, error: 'Package is missing or contains no Pi extensions'
        }
      }
      let settings: PluginSettingsSchema | undefined
      let error: string | undefined
      try {
        settings = settingsSchema(item.source)
      } catch (schemaError) {
        error = schemaError instanceof Error ? schemaError.message : String(schemaError)
      }
      return {
        id: item.id, source: item.source, name: displayName(item.source), kind: item.kind,
        scopes: item.scopes, available: true,
        ...(settings ? { settings } : {}),
        ...(error ? { error } : {})
      }
    } catch (error) {
      return {
        id: item.id, source: item.source, name: displayName(item.source), kind: item.kind,
        scopes: item.scopes, available: false, error: error instanceof Error ? error.message : String(error)
      }
    }
  }))
  return [{
    id: 'observational-memory', name: 'Observational Memory', source: 'Pig built-in',
    kind: 'system', scopes: registry.memoryScopes, available: existsSync(memoryPath()),
    ...(!existsSync(memoryPath()) ? { error: 'Bundled extension is missing' } : {})
  }, {
    id: 'pi-review', name: 'Pi Review', source: 'Pig built-in',
    kind: 'system', scopes: registry.reviewScopes, available: existsSync(reviewPath()),
    ...(!existsSync(reviewPath()) ? { error: 'Bundled extension is missing' } : {})
  }, {
    id: 'pi-web-access', name: 'Pi Web Access', source: 'Pig built-in',
    kind: 'system', scopes: registry.webAccessScopes, available: existsSync(webAccessPath()),
    ...(!existsSync(webAccessPath()) ? { error: 'Bundled extension is missing' } : {})
  }, ...installed]
}

export function installPlugin(source: string): Promise<void> {
  return serialize(async () => {
    const normalized = normalizeSource(source)
    const registry = await readRegistry()
    if (registry.installed.some((item) => normalizeSource(item.source).identity === normalized.identity)) {
      throw new Error('This plugin is already installed')
    }
    const manager = packageManager(normalized.source)
    await manager.install(normalized.source)
    try {
      if (!(await resourcesFor(normalized.source)).length) throw new Error('Package contains no Pi extensions')
      const schema = settingsSchema(normalized.source)
      if (schema) {
        const namespaces = new Set<string>()
        for (const item of registry.installed) {
          try {
            const existing = settingsSchema(item.source)
            if (existing) namespaces.add(existing.namespace)
          } catch {
            continue
          }
        }
        if (namespaces.has(schema.namespace)) throw new Error(`Plugin settings namespace already installed: ${schema.namespace}`)
      }
    } catch (error) {
      if (normalized.kind !== 'local') {
        await manager.remove(normalized.source).catch(() => undefined)
      }
      throw error
    }
    registry.installed.push({ id: randomUUID(), source: normalized.source, kind: normalized.kind, scopes: [] })
    await saveRegistry(registry)
  })
}

export function setPluginScopes(id: string, scopes: PluginScope[]): Promise<void> {
  return serialize(async () => {
    const next = parseScopes(scopes)
    const registry = await readRegistry()
    const addsScope = (current: PluginScope[]) => next.some((scope) => !current.includes(scope))
    if (id === 'observational-memory') {
      if (addsScope(registry.memoryScopes) && !existsSync(memoryPath())) throw new Error('Bundled extension is missing')
      registry.memoryScopes = next
    } else if (id === 'pi-review') {
      if (addsScope(registry.reviewScopes) && !existsSync(reviewPath())) throw new Error('Bundled extension is missing')
      registry.reviewScopes = next
    } else if (id === 'pi-web-access') {
      if (addsScope(registry.webAccessScopes) && !existsSync(webAccessPath())) throw new Error('Bundled extension is missing')
      registry.webAccessScopes = next
    } else {
      const plugin = registry.installed.find((item) => item.id === id)
      if (!plugin) throw new Error('Plugin not found')
      if (addsScope(plugin.scopes) && !(await resourcesFor(plugin.source)).length) throw new Error('Plugin is missing or has no extensions')
      plugin.scopes = next
    }
    await saveRegistry(registry)
  })
}

export function removePlugin(id: string): Promise<void> {
  return serialize(async () => {
    const registry = await readRegistry()
    const plugin = registry.installed.find((item) => item.id === id)
    if (!plugin) throw new Error('Plugin not found or is a system plugin')
    if (plugin.scopes.length) throw new Error('Disable the plugin before removing it')
    const schema = settingsSchema(plugin.source)
    await packageManager(plugin.source).remove(plugin.source)
    registry.installed = registry.installed.filter((item) => item.id !== id)
    await saveRegistry(registry)
    if (schema) {
      const { rm } = await import('node:fs/promises')
      await rm(pigPath('plugin-settings', `${schema.namespace}.json`), { force: true })
    }
  })
}

export function updatePlugin(id: string): Promise<void> {
  return serialize(async () => {
    const plugin = (await readRegistry()).installed.find((item) => item.id === id)
    if (!plugin) throw new Error('Plugin not found or is a system plugin')
    if (plugin.kind === 'local') {
      if (!(await resourcesFor(plugin.source)).length) throw new Error('Local plugin is missing')
      return
    }
    await packageManager(plugin.source).update(plugin.source)
  })
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

async function readSettingsObject(path: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Pi settings file')
    return value as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

const memoryDefaultKeys = [
  'observeAfterTokens', 'reflectAfterTokens', 'compactAfterTokens', 'compactAfterTokensRatio',
  'observationsPoolMaxTokens', 'observationsPoolTargetTokens', 'agentMaxTurns', 'agentMaxTokens',
  'compactionCatchUpMaxChunks'
] as const

export async function getMemoryPluginDefaults(): Promise<Record<string, number>> {
  await mutation
  return Object.fromEntries(memoryDefaultKeys.map((key) => [key, DEFAULTS[key] as number]))
}

export async function getMemoryPluginSettings(): Promise<MemoryPluginSettings> {
  await mutation
  const value = (await readSettingsObject(memorySettingsPath()))['observational-memory']
  return value && typeof value === 'object' && !Array.isArray(value) ? value as MemoryPluginSettings : {}
}

async function saveNamespacedSettings(path: string, settings: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`)
    await rename(temp, path)
  } catch (error) {
    const { rm } = await import('node:fs/promises')
    await rm(temp, { force: true })
    throw error
  }
}

export function setMemoryPluginSettings(patch: MemoryPluginSettingsPatch): Promise<MemoryPluginSettings> {
  return serialize(async () => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid memory settings')
    const allowed = new Set<string>([
      ...integerKeys, ...nonNegativeIntegerKeys, ...booleanKeys,
      'model', 'fallbackModel', 'compactAfterTokensMode', 'compactAfterTokensRatio'
    ])
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
      if ((key === 'model' || key === 'fallbackModel') && value !== null && (
        typeof value !== 'object' || !value || typeof value.provider !== 'string' || !value.provider ||
        typeof value.id !== 'string' || !value.id ||
        (value.thinking !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value.thinking))
      )) throw new Error('Invalid memory model')
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
    if (typeof next.observationsPoolTargetTokens === 'number' && typeof next.observationsPoolMaxTokens === 'number' && next.observationsPoolTargetTokens >= next.observationsPoolMaxTokens) {
      throw new Error('Observation pool target must be smaller than its maximum')
    }
    settings['observational-memory'] = next
    await saveNamespacedSettings(path, settings)
    return next
  })
}

async function pluginSchema(id: string): Promise<PluginSettingsSchema> {
  const plugin = (await readRegistry()).installed.find((item) => item.id === id)
  if (!plugin) throw new Error('Plugin not found')
  const schema = settingsSchema(plugin.source)
  if (!schema) throw new Error('Plugin does not declare Pig settings')
  return schema
}

function configValues(settings: Record<string, unknown>, schema: PluginSettingsSchema): Record<string, string | number | boolean> {
  const node = settings[schema.namespace]
  if (!node || typeof node !== 'object' || Array.isArray(node)) return {}
  const values: Record<string, string | number | boolean> = {}
  for (const field of schema.fields) {
    const value = (node as Record<string, unknown>)[field.key]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') values[field.key] = value
  }
  return values
}

export async function getPluginSettings(id: string): Promise<Record<string, string | number | boolean>> {
  await mutation
  const schema = await pluginSchema(id)
  return configValues(await readSettingsObject(pigPath('plugin-settings', `${schema.namespace}.json`)), schema)
}

export function setPluginSettings(id: string, patch: Record<string, string | number | boolean | null>): Promise<Record<string, string | number | boolean>> {
  return serialize(async () => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid plugin settings')
    const schema = await pluginSchema(id)
    for (const [key, value] of Object.entries(patch)) {
      const field = schema.fields.find((item) => item.key === key)
      if (!field) throw new Error(`Unknown plugin setting: ${key}`)
      if (value === null) continue
      if (field.type === 'boolean' && typeof value !== 'boolean') throw new Error(`Expected boolean: ${key}`)
      if (field.type === 'string' && typeof value !== 'string') throw new Error(`Expected string: ${key}`)
      if (field.type === 'select' && (typeof value !== 'string' || !field.options?.includes(value))) throw new Error(`Invalid choice: ${key}`)
      if (field.type === 'integer' && (!Number.isSafeInteger(value) ||
          (field.min !== undefined && (value as number) < field.min) ||
          (field.max !== undefined && (value as number) > field.max))) throw new Error(`Invalid integer: ${key}`)
    }
    const path = pigPath('plugin-settings', `${schema.namespace}.json`)
    const settings = await readSettingsObject(path)
    const previous = settings[schema.namespace]
    if (previous !== undefined && (!previous || typeof previous !== 'object' || Array.isArray(previous))) throw new Error('Invalid plugin config namespace')
    const next: Record<string, unknown> = { ...(previous as Record<string, unknown> | undefined) }
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete next[key]
      else next[key] = value
    }
    settings[schema.namespace] = next
    await saveNamespacedSettings(path, settings)
    return configValues(settings, schema)
  })
}
