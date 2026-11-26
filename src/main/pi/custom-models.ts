/**
 * Custom providers and models backed by `~/.pi/agent/models.json` and `auth.json`.
 *
 * Reads and writes preserve user-authored fields (`$schema`, built-in provider overrides, `compat`,
 * `samplingParams`, `modelOverrides`) and refuse to overwrite unreadable or malformed JSON. Literal
 * API keys entered in Pig are stored in `auth.json` via `ModelRuntime`, while existing `models.json`
 * keys and header values are masked before crossing IPC.
 */
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getAgentDir, ModelRuntime, readStoredCredential } from '@earendil-works/pi-coding-agent'
import type {
  CustomHeaderInput,
  CustomHeaderView,
  CustomModelCost,
  CustomModelInput,
  CustomModelsState,
  CustomModelView,
  CustomProviderAuthMode,
  CustomProviderInput,
  CustomProviderView,
  DiscoveredRemoteModel,
  DiscoverModelsInput
} from '../../shared/custom-models'
import { currentLocale } from '../i18n'
import { synchronizeModelCatalog } from './model-catalog'
import { startModelRuntime } from './model-settings'

const MODELS_SCHEMA_URL = 'https://pi.dev/schemas/models.schema.json'
const LOCAL_DUMMY_KEYS = new Set(['local', 'ollama', 'none'])
const PROVIDER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const SINGLE_ENV_REF_PATTERN = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const DEFAULT_CONTEXT_WINDOW = 128_000
const DEFAULT_MAX_TOKENS = 16_384
const DISCOVERY_TIMEOUT_MS = 10_000
const DISCOVERY_MAX_BYTES = 2 * 1024 * 1024

let builtinIdsPromise: Promise<ReadonlySet<string>> | undefined
let mutationQueue: Promise<void> = Promise.resolve()

function withMutationQueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation)
  mutationQueue = result.then(() => undefined, () => undefined)
  return result
}

export function getBuiltinProviderIds(): Promise<ReadonlySet<string>> {
  builtinIdsPromise ??= ModelRuntime.create({ modelsPath: null, refreshOnCreate: false })
    .then((runtime) => new Set<string>([
      'radius',
      ...runtime.getProviders().map((provider) => provider.id)
    ]))
    .catch((error) => {
      builtinIdsPromise = undefined
      throw error
    })
  return builtinIdsPromise
}

function modelsFilePath(): string {
  return join(getAgentDir(), 'models.json')
}

function authFilePath(): string {
  return join(getAgentDir(), 'auth.json')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stripBomAndJsonComments(source: string): string {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    const next = text[i + 1]
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '/' && next === '/') {
      i += 2
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i += 1
      i -= 1
      continue
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end === -1) return out + text.slice(i)
      // Keep line breaks so JSON.parse still reports accurate line numbers on syntax errors.
      for (let j = i + 2; j < end; j += 1) {
        if (text[j] === '\n' || text[j] === '\r') out += text[j]
      }
      i = end + 1
      continue
    }
    out += ch
  }
  return out
}

interface LoadedModelsDocument {
  exists: boolean
  root: Record<string, unknown>
  providers: Record<string, Record<string, unknown>>
}

async function readModelsDocument(): Promise<LoadedModelsDocument> {
  const path = modelsFilePath()
  let rawText: string
  try {
    rawText = await readFile(path, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        exists: false,
        root: { $schema: MODELS_SCHEMA_URL, providers: {} },
        providers: {}
      }
    }
    throw new Error(`Failed to read models.json: ${error instanceof Error ? error.message : String(error)}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stripBomAndJsonComments(rawText))
  } catch (error) {
    throw new Error(`Failed to parse models.json: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isPlainObject(parsed)) {
    throw new Error('Invalid models.json: root must be a JSON object')
  }
  const rawProviders = parsed.providers
  if (rawProviders !== undefined && !isPlainObject(rawProviders)) {
    throw new Error('Invalid models.json: "providers" must be a JSON object')
  }
  const providers: Record<string, Record<string, unknown>> = {}
  for (const [id, entry] of Object.entries(rawProviders ?? {})) {
    if (!isPlainObject(entry)) {
      throw new Error(`Invalid models.json: provider "${id}" must be a JSON object`)
    }
    providers[id] = { ...entry }
  }
  return {
    exists: true,
    root: { ...parsed, providers },
    providers
  }
}

async function writeModelsDocument(root: Record<string, unknown>, providers: Record<string, Record<string, unknown>>): Promise<void> {
  const path = modelsFilePath()
  const dir = dirname(path)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  const nextDoc: Record<string, unknown> = {
    ...(Object.keys(root).length > 0 ? root : { $schema: MODELS_SCHEMA_URL }),
    providers
  }
  if (!('$schema' in nextDoc)) {
    nextDoc.$schema = MODELS_SCHEMA_URL
  }
  try {
    await writeFile(tempPath, `${JSON.stringify(nextDoc, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
    await chmod(tempPath, 0o600).catch(() => {})
    await rename(tempPath, path)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

function parseSingleEnvVar(rawValue: unknown): string | undefined {
  if (typeof rawValue !== 'string') return undefined
  const match = SINGLE_ENV_REF_PATTERN.exec(rawValue.trim())
  return match?.[1] ?? match?.[2]
}

function normalizeEnvVarName(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim()
  const extracted = parseSingleEnvVar(trimmed) ?? trimmed
  if (!ENV_NAME_PATTERN.test(extracted)) {
    throw new Error('Environment variable name must contain only letters, digits, and underscores')
  }
  return extracted
}

function validateHttpUrl(raw: string, label: string): string {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error(`${label} is required`)
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`${label} must be a valid http:// or https:// URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must use http:// or https://`)
  }
  return trimmed.replace(/\/+$/, '')
}

function validateProviderId(raw: string, builtinIds: ReadonlySet<string>): string {
  const id = raw.trim()
  if (!id) throw new Error('Provider ID is required')
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new Error('Provider ID may contain only letters, digits, dots, underscores, and hyphens')
  }
  if (builtinIds.has(id)) {
    throw new Error(`"${id}" is a built-in Pi provider; choose a distinct ID for your custom provider`)
  }
  return id
}

function hasStoredApiKey(providerId: string): string | undefined {
  try {
    const credential = readStoredCredential(providerId, authFilePath())
    if (credential?.type === 'api_key' && typeof credential.key === 'string' && credential.key.length > 0) {
      return credential.key
    }
  } catch {
    // Unreadable auth.json is surfaced by ModelRuntime itself when credentials are checked.
  }
  return undefined
}

function deriveProviderAuthView(
  providerId: string,
  config: Record<string, unknown>
): {
  authMode: CustomProviderAuthMode
  hasSavedKey: boolean
  envVar?: string
  envDetected?: boolean
} {
  const storedKey = hasStoredApiKey(providerId)
  if (storedKey) {
    return { authMode: 'api_key', hasSavedKey: true }
  }
  const rawApiKey = typeof config.apiKey === 'string' ? config.apiKey : undefined
  if (!rawApiKey) {
    return { authMode: 'api_key', hasSavedKey: false }
  }
  if (LOCAL_DUMMY_KEYS.has(rawApiKey)) {
    return { authMode: 'none', hasSavedKey: false }
  }
  const envVar = parseSingleEnvVar(rawApiKey)
  if (envVar) {
    return {
      authMode: 'env',
      hasSavedKey: false,
      envVar,
      envDetected: process.env[envVar] !== undefined && process.env[envVar] !== ''
    }
  }
  return { authMode: 'api_key', hasSavedKey: true }
}

function toHeaderViews(rawHeaders: unknown): CustomHeaderView[] {
  if (!isPlainObject(rawHeaders)) return []
  const views: CustomHeaderView[] = []
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (typeof value !== 'string') continue
    const envVar = parseSingleEnvVar(value)
    views.push({
      name,
      ...(envVar ? { envVar } : {}),
      hasSavedValue: value.length > 0
    })
  }
  return views
}

function toCostView(rawCost: unknown): CustomModelCost | undefined {
  if (!isPlainObject(rawCost)) return undefined
  const input = typeof rawCost.input === 'number' && Number.isFinite(rawCost.input) ? rawCost.input : 0
  const output = typeof rawCost.output === 'number' && Number.isFinite(rawCost.output) ? rawCost.output : 0
  const cacheRead = typeof rawCost.cacheRead === 'number' && Number.isFinite(rawCost.cacheRead) ? rawCost.cacheRead : 0
  const cacheWrite = typeof rawCost.cacheWrite === 'number' && Number.isFinite(rawCost.cacheWrite) ? rawCost.cacheWrite : 0
  return { input, output, cacheRead, cacheWrite }
}

function toModelView(entry: unknown): CustomModelView | null {
  if (!isPlainObject(entry) || typeof entry.id !== 'string' || !entry.id.trim()) return null
  const id = entry.id
  const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name : id
  const reasoning = entry.reasoning === true
  const vision = Array.isArray(entry.input) && entry.input.includes('image')
  const contextWindow =
    typeof entry.contextWindow === 'number' && Number.isFinite(entry.contextWindow) && entry.contextWindow > 0
      ? entry.contextWindow
      : DEFAULT_CONTEXT_WINDOW
  const maxTokens =
    typeof entry.maxTokens === 'number' && Number.isFinite(entry.maxTokens) && entry.maxTokens > 0
      ? entry.maxTokens
      : DEFAULT_MAX_TOKENS
  const cost = toCostView(entry.cost)
  return {
    id,
    name,
    reasoning,
    vision,
    contextWindow,
    maxTokens,
    ...(cost ? { cost } : {})
  }
}

function isCustomProviderEntry(
  providerId: string,
  config: Record<string, unknown>,
  builtinIds: ReadonlySet<string>
): boolean {
  if (builtinIds.has(providerId)) return false
  if (config.oauth === 'radius') return false
  return true
}

function buildModelRecord(
  input: CustomModelInput,
  existing: Record<string, unknown> | undefined
): Record<string, unknown> {
  const id = input.id.trim()
  if (!id) throw new Error('Model ID is required')
  if (/\s/.test(id)) throw new Error('Model ID cannot contain whitespace')

  const contextWindow = Math.trunc(input.contextWindow)
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    throw new Error(`Model "${id}": contextWindow must be a positive integer`)
  }
  const maxTokens = Math.trunc(input.maxTokens)
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw new Error(`Model "${id}": maxTokens must be a positive integer`)
  }

  const record: Record<string, unknown> = {
    ...(existing ?? {}),
    id,
    reasoning: Boolean(input.reasoning),
    input: input.vision ? ['text', 'image'] : ['text'],
    contextWindow,
    maxTokens
  }

  const displayName = input.name?.trim()
  if (displayName && displayName !== id) {
    record.name = displayName
  } else {
    delete record.name
  }

  if (input.cost === null) {
    delete record.cost
  } else if (input.cost !== undefined) {
    const fields: (keyof CustomModelCost)[] = ['input', 'output', 'cacheRead', 'cacheWrite']
    for (const key of fields) {
      const val = input.cost[key]
      if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) {
        throw new Error(`Model "${id}": cost.${key} must be a non-negative number`)
      }
    }
    record.cost = {
      ...(isPlainObject(existing?.cost) ? existing.cost : {}),
      input: input.cost.input,
      output: input.cost.output,
      cacheRead: input.cost.cacheRead,
      cacheWrite: input.cost.cacheWrite
    }
  }

  return record
}

function buildHeadersRecord(
  inputs: CustomHeaderInput[] | undefined,
  existingRaw: unknown
): Record<string, string> | undefined {
  if (!inputs) {
    if (!isPlainObject(existingRaw)) return undefined
    const preserved: Record<string, string> = {}
    for (const [k, v] of Object.entries(existingRaw)) {
      if (typeof v === 'string') preserved[k] = v
    }
    return Object.keys(preserved).length > 0 ? preserved : undefined
  }

  const existing = isPlainObject(existingRaw) ? existingRaw : {}
  const next: Record<string, string> = {}
  const seenLower = new Set<string>()
  for (const item of inputs) {
    const name = item.name.trim()
    if (!name) continue
    if (!HEADER_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid header name "${name}"`)
    }
    const lower = name.toLowerCase()
    if (seenLower.has(lower)) {
      throw new Error(`Duplicate header "${name}"`)
    }
    seenLower.add(lower)

    if (item.keepSaved) {
      const prev = existing[name]
      if (typeof prev !== 'string' || !prev.length) {
        throw new Error(`Header "${name}" has no saved value to keep`)
      }
      next[name] = prev
      continue
    }
    const value = (item.value ?? '').trim()
    if (!value) {
      throw new Error(`Header "${name}" value cannot be empty`)
    }
    if (/[\r\n]/.test(value)) {
      throw new Error(`Header "${name}" value cannot contain line breaks`)
    }
    next[name] = value
  }
  return Object.keys(next).length > 0 ? next : undefined
}

async function refreshRuntimeAndCatalog(runtime: ModelRuntime): Promise<void> {
  await runtime.refresh({ allowNetwork: false })
  synchronizeModelCatalog()
}

async function buildCustomModelsState(runtime: ModelRuntime): Promise<CustomModelsState> {
  const builtinIds = await getBuiltinProviderIds()
  let doc: LoadedModelsDocument
  try {
    doc = await readModelsDocument()
  } catch (error) {
    return {
      providers: [],
      error: error instanceof Error ? error.message : String(error),
      runtimeError: runtime.getError() ?? null
    }
  }

  const providers: CustomProviderView[] = []
  for (const [id, config] of Object.entries(doc.providers)) {
    if (!isCustomProviderEntry(id, config, builtinIds)) continue
    const authView = deriveProviderAuthView(id, config)
    const rawModels = Array.isArray(config.models) ? config.models : []
    const models = rawModels.flatMap((entry) => {
      const view = toModelView(entry)
      return view ? [view] : []
    })
    const status = runtime.getProviderAuthStatus(id)
    providers.push({
      id,
      name: typeof config.name === 'string' && config.name.trim() ? config.name.trim() : id,
      api: typeof config.api === 'string' && config.api.trim() ? config.api.trim() : 'openai-completions',
      baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl : '',
      authMode: authView.authMode,
      hasSavedKey: authView.hasSavedKey,
      ...(authView.envVar ? { envVar: authView.envVar, envDetected: authView.envDetected } : {}),
      authHeader: config.authHeader === true,
      headers: toHeaderViews(config.headers),
      models,
      configured: status.configured
    })
  }

  providers.sort((a, b) => a.name.localeCompare(b.name, currentLocale()))
  return {
    providers,
    error: null,
    runtimeError: runtime.getError() ?? null
  }
}

export async function getCustomModels(): Promise<CustomModelsState> {
  await mutationQueue
  const runtime = await startModelRuntime()
  return buildCustomModelsState(runtime)
}

export function saveCustomProvider(input: CustomProviderInput): Promise<CustomModelsState> {
  return withMutationQueue(async () => {
    const [runtime, builtinIds, doc] = await Promise.all([
      startModelRuntime(),
      getBuiltinProviderIds(),
      readModelsDocument()
    ])

    const id = validateProviderId(input.id, builtinIds)
    const previousId = input.previousId?.trim() || undefined
    if (previousId && builtinIds.has(previousId)) {
      throw new Error(`"${previousId}" is a built-in Pi provider and cannot be edited here`)
    }
    if (!previousId && Object.hasOwn(doc.providers, id)) {
      throw new Error(`Provider "${id}" already exists`)
    }
    if (previousId && previousId !== id && Object.hasOwn(doc.providers, id)) {
      throw new Error(`Provider "${id}" already exists`)
    }

    const existing = previousId ? doc.providers[previousId] : undefined
    if (previousId && !existing) {
      throw new Error(`Provider "${previousId}" does not exist`)
    }

    const api = input.api.trim()
    if (!api) throw new Error('API protocol is required')
    const baseUrl = validateHttpUrl(input.baseUrl, 'Base URL')

    const previousStoredKey = previousId ? hasStoredApiKey(previousId) : undefined
    const targetStoredKey = hasStoredApiKey(id)
    const existingRawKey = typeof existing?.apiKey === 'string' ? existing.apiKey : undefined
    const existingHasLiteralOrCmdKey = Boolean(
      existingRawKey && !LOCAL_DUMMY_KEYS.has(existingRawKey) && !parseSingleEnvVar(existingRawKey)
    )

    const nextProvider: Record<string, unknown> = {
      ...(existing ?? {}),
      baseUrl,
      api
    }

    const trimmedName = input.name?.trim()
    if (trimmedName && trimmedName !== id) {
      nextProvider.name = trimmedName
    } else {
      delete nextProvider.name
    }

    if (input.authHeader) {
      nextProvider.authHeader = true
    } else {
      delete nextProvider.authHeader
    }

    const headers = buildHeadersRecord(input.headers, existing?.headers)
    if (headers) nextProvider.headers = headers
    else delete nextProvider.headers

    let keyToStoreInAuthJson: string | undefined
    let logoutOldProvider = false
    let logoutTargetProvider = false

    if (input.authMode === 'none') {
      nextProvider.apiKey = existingRawKey && LOCAL_DUMMY_KEYS.has(existingRawKey) ? existingRawKey : 'local'
      if (previousId && previousStoredKey) logoutOldProvider = true
      if (targetStoredKey) logoutTargetProvider = true
    } else if (input.authMode === 'env') {
      const envName = normalizeEnvVarName(input.envVar)
      nextProvider.apiKey = `$${envName}`
      if (previousId && previousStoredKey) logoutOldProvider = true
      if (targetStoredKey) logoutTargetProvider = true
    } else if (input.authMode === 'api_key') {
      const typedKey = input.apiKey?.trim()
      if (typedKey) {
        keyToStoreInAuthJson = typedKey
        delete nextProvider.apiKey
        if (previousId && previousId !== id && previousStoredKey) logoutOldProvider = true
      } else if (previousId && previousStoredKey) {
        delete nextProvider.apiKey
        if (previousId !== id) {
          keyToStoreInAuthJson = previousStoredKey
          logoutOldProvider = true
        }
      } else if (existingHasLiteralOrCmdKey) {
        nextProvider.apiKey = existingRawKey
      } else if (!previousId && targetStoredKey) {
        delete nextProvider.apiKey
      } else {
        throw new Error('API key is required')
      }
    } else {
      throw new Error(`Unsupported auth mode: ${String(input.authMode)}`)
    }

    if (input.models !== undefined) {
      const existingModels = Array.isArray(existing?.models) ? existing.models : []
      const existingById = new Map<string, Record<string, unknown>>()
      for (const item of existingModels) {
        if (isPlainObject(item) && typeof item.id === 'string') existingById.set(item.id, item)
      }
      const seenIds = new Set<string>()
      const builtModels = input.models.map((modelInput) => {
        const prev = existingById.get(modelInput.previousId ?? modelInput.id.trim())
        const built = buildModelRecord(modelInput, prev)
        const modelId = built.id as string
        if (seenIds.has(modelId)) {
          throw new Error(`Duplicate model ID "${modelId}"`)
        }
        seenIds.add(modelId)
        return built
      })
      if (builtModels.length > 0) nextProvider.models = builtModels
      else delete nextProvider.models
    }

    // Clear stored credentials on the old provider ID before removing its runtime registration.
    if (logoutOldProvider && previousId) {
      await runtime.logout(previousId, { signal: AbortSignal.timeout(15_000) }).catch(() => {})
    }
    if (logoutTargetProvider && (!previousId || previousId !== id)) {
      await runtime.logout(id, { signal: AbortSignal.timeout(15_000) }).catch(() => {})
    }

    const nextProviders: Record<string, Record<string, unknown>> = {}
    for (const [key, val] of Object.entries(doc.providers)) {
      if (previousId && key === previousId) {
        nextProviders[id] = nextProvider
      } else {
        nextProviders[key] = val
      }
    }
    if (!previousId) {
      nextProviders[id] = nextProvider
    }

    await writeModelsDocument(doc.root, nextProviders)
    await runtime.refresh({ allowNetwork: false })

    if (keyToStoreInAuthJson) {
      await runtime.login(id, 'api_key', {
        prompt: async () => keyToStoreInAuthJson,
        notify: () => {}
      })
    }
    synchronizeModelCatalog()
    return buildCustomModelsState(runtime)
  })
}

export function removeCustomProvider(providerId: string): Promise<CustomModelsState> {
  return withMutationQueue(async () => {
    const [runtime, builtinIds, doc] = await Promise.all([
      startModelRuntime(),
      getBuiltinProviderIds(),
      readModelsDocument()
    ])
    const id = providerId.trim()
    if (!id) throw new Error('Provider ID is required')
    if (builtinIds.has(id)) {
      throw new Error(`"${id}" is a built-in Pi provider and cannot be removed here`)
    }
    if (!Object.hasOwn(doc.providers, id)) {
      return buildCustomModelsState(runtime)
    }

    if (hasStoredApiKey(id)) {
      await runtime.logout(id, { signal: AbortSignal.timeout(15_000) }).catch(() => {})
    }

    const nextProviders = { ...doc.providers }
    delete nextProviders[id]
    await writeModelsDocument(doc.root, nextProviders)
    await refreshRuntimeAndCatalog(runtime)
    return buildCustomModelsState(runtime)
  })
}

export function saveCustomModel(
  providerId: string,
  model: CustomModelInput | CustomModelInput[]
): Promise<CustomModelsState> {
  return withMutationQueue(async () => {
    const [runtime, builtinIds, doc] = await Promise.all([
      startModelRuntime(),
      getBuiltinProviderIds(),
      readModelsDocument()
    ])
    const id = providerId.trim()
    if (!id || builtinIds.has(id)) {
      throw new Error('Valid custom provider ID is required')
    }
    const provider = doc.providers[id]
    if (!provider) {
      throw new Error(`Provider "${id}" does not exist`)
    }

    const inputs = Array.isArray(model) ? model : [model]
    if (inputs.length === 0) {
      return buildCustomModelsState(runtime)
    }

    const rawModels = Array.isArray(provider.models) ? [...provider.models] : []
    for (const item of inputs) {
      const targetId = item.id.trim()
      const previousId = item.previousId?.trim() || undefined

      const previousIndex = previousId
        ? rawModels.findIndex((entry) => isPlainObject(entry) && entry.id === previousId)
        : -1
      const duplicateIndex = rawModels.findIndex((entry) => isPlainObject(entry) && entry.id === targetId)

      if (previousId) {
        if (previousIndex === -1) {
          throw new Error(`Model "${previousId}" does not exist on provider "${id}"`)
        }
        if (duplicateIndex !== -1 && duplicateIndex !== previousIndex) {
          throw new Error(`Model "${targetId}" already exists on provider "${id}"`)
        }
      } else if (duplicateIndex !== -1) {
        throw new Error(`Model "${targetId}" already exists on provider "${id}"`)
      }

      const existingEntry =
        previousIndex >= 0 && isPlainObject(rawModels[previousIndex])
          ? (rawModels[previousIndex] as Record<string, unknown>)
          : undefined
      const nextEntry = buildModelRecord(item, existingEntry)

      if (previousIndex >= 0) {
        rawModels[previousIndex] = nextEntry
      } else {
        rawModels.push(nextEntry)
      }
    }

    const nextProviders = {
      ...doc.providers,
      [id]: {
        ...provider,
        models: rawModels
      }
    }
    await writeModelsDocument(doc.root, nextProviders)
    await refreshRuntimeAndCatalog(runtime)
    return buildCustomModelsState(runtime)
  })
}

export function removeCustomModel(providerId: string, modelId: string): Promise<CustomModelsState> {
  return withMutationQueue(async () => {
    const [runtime, builtinIds, doc] = await Promise.all([
      startModelRuntime(),
      getBuiltinProviderIds(),
      readModelsDocument()
    ])
    const id = providerId.trim()
    if (!id || builtinIds.has(id)) {
      throw new Error('Valid custom provider ID is required')
    }
    const provider = doc.providers[id]
    if (!provider) {
      throw new Error(`Provider "${id}" does not exist`)
    }

    const targetId = modelId.trim()
    const rawModels = Array.isArray(provider.models)
      ? provider.models.filter((entry) => !(isPlainObject(entry) && entry.id === targetId))
      : []

    const nextProvider = { ...provider }
    if (rawModels.length > 0) nextProvider.models = rawModels
    else delete nextProvider.models

    const nextProviders = {
      ...doc.providers,
      [id]: nextProvider
    }
    await writeModelsDocument(doc.root, nextProviders)
    await refreshRuntimeAndCatalog(runtime)
    return buildCustomModelsState(runtime)
  })
}

function resolveInlineValue(raw: string): string | undefined {
  const envVar = parseSingleEnvVar(raw)
  if (envVar) {
    const val = process.env[envVar]
    return val && val.length > 0 ? val : undefined
  }
  return raw
}

async function resolveDiscoveryAuth(input: DiscoverModelsInput): Promise<{
  apiKey?: string
  headers: Record<string, string>
}> {
  let existingProvider: Record<string, unknown> | undefined
  const providerId = input.providerId?.trim()
  if (providerId) {
    try {
      const doc = await readModelsDocument()
      existingProvider = doc.providers[providerId]
    } catch {
      existingProvider = undefined
    }
  }

  let resolvedKey: string | undefined
  if (input.authMode === 'env') {
    const envName = normalizeEnvVarName(input.envVar)
    resolvedKey = process.env[envName] || undefined
    if (!resolvedKey) {
      throw new Error(`Environment variable "${envName}" is not set`)
    }
  } else if (input.authMode === 'api_key') {
    const typed = input.apiKey?.trim()
    if (typed) {
      resolvedKey = typed
    } else if (providerId) {
      resolvedKey = hasStoredApiKey(providerId)
      if (!resolvedKey && typeof existingProvider?.apiKey === 'string') {
        const raw = existingProvider.apiKey
        if (!LOCAL_DUMMY_KEYS.has(raw) && !raw.startsWith('!')) {
          resolvedKey = resolveInlineValue(raw)
        }
      }
    }
    if (!resolvedKey) {
      throw new Error('Enter an API key before fetching models')
    }
  }

  const headersRecord = buildHeadersRecord(input.headers, existingProvider?.headers) ?? {}
  const resolvedHeaders: Record<string, string> = {}
  for (const [name, rawVal] of Object.entries(headersRecord)) {
    if (rawVal.startsWith('!')) continue
    const val = resolveInlineValue(rawVal)
    if (val !== undefined) resolvedHeaders[name] = val
  }

  return { apiKey: resolvedKey, headers: resolvedHeaders }
}

async function fetchJsonBounded(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json', ...headers },
    signal
  })
  if (!response.ok) {
    throw new Error(`Endpoint returned HTTP ${response.status}`)
  }
  const reader = response.body?.getReader()
  if (!reader) {
    return JSON.parse(await response.text())
  }
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > DISCOVERY_MAX_BYTES) {
        throw new Error('Model list response exceeded 2 MiB limit')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const text = Buffer.concat(chunks).toString('utf-8')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('Endpoint did not return valid JSON')
  }
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined
}

function parseDiscoveredModels(payload: unknown, api: string): DiscoveredRemoteModel[] {
  if (!isPlainObject(payload) && !Array.isArray(payload)) return []

  const rawItems: unknown[] = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.data)
      ? payload.data
      : Array.isArray(payload.models)
        ? payload.models
        : []

  const seen = new Set<string>()
  const result: DiscoveredRemoteModel[] = []

  for (const item of rawItems) {
    if (!isPlainObject(item)) continue
    let rawId = typeof item.id === 'string'
      ? item.id.trim()
      : typeof item.name === 'string'
        ? item.name.trim()
        : ''
    if (api === 'google-generative-ai' && rawId.startsWith('models/')) {
      rawId = rawId.slice('models/'.length)
    }
    if (!rawId || /\s/.test(rawId) || seen.has(rawId)) continue

    // Google Gemini's /models lists embedding-only models too; keep chat/generateContent models.
    if (
      api === 'google-generative-ai' &&
      Array.isArray(item.supportedGenerationMethods) &&
      !item.supportedGenerationMethods.includes('generateContent')
    ) {
      continue
    }

    seen.add(rawId)
    const displayName =
      typeof item.display_name === 'string' && item.display_name.trim()
        ? item.display_name.trim()
        : typeof item.displayName === 'string' && item.displayName.trim()
          ? item.displayName.trim()
          : typeof item.name === 'string' && item.name.trim() && item.name.trim() !== rawId && !item.name.startsWith('models/')
            ? item.name.trim()
            : undefined

    const contextWindow =
      positiveInt(item.context_length) ??
      positiveInt(item.contextWindow) ??
      positiveInt(item.max_model_len) ??
      positiveInt(item.inputTokenLimit)
    const topProvider = isPlainObject(item.top_provider) ? item.top_provider : undefined
    const maxTokens =
      positiveInt(item.max_completion_tokens) ??
      positiveInt(topProvider?.max_completion_tokens) ??
      positiveInt(item.maxTokens) ??
      positiveInt(item.outputTokenLimit)

    const arch = isPlainObject(item.architecture) ? item.architecture : undefined
    const modalities = Array.isArray(arch?.input_modalities)
      ? arch.input_modalities
      : Array.isArray(item.input_modalities)
        ? item.input_modalities
        : undefined
    const vision = modalities ? modalities.includes('image') : undefined
    const supportedParams = Array.isArray(item.supported_parameters) ? item.supported_parameters : undefined
    const reasoning =
      typeof item.thinking === 'boolean'
        ? item.thinking
        : supportedParams
          ? supportedParams.includes('reasoning') || supportedParams.includes('include_reasoning')
          : undefined

    result.push({
      id: rawId,
      ...(displayName ? { name: displayName } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxTokens ? { maxTokens } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(vision !== undefined ? { vision } : {})
    })
  }

  return result
}

export async function discoverCustomModels(input: DiscoverModelsInput): Promise<DiscoveredRemoteModel[]> {
  const api = input.api.trim() || 'openai-completions'
  const baseUrl = validateHttpUrl(input.baseUrl, 'Base URL')
  const { apiKey, headers: customHeaders } = await resolveDiscoveryAuth(input)

  const headers: Record<string, string> = { ...customHeaders }
  const candidateUrls: string[] = []

  if (api === 'anthropic-messages') {
    headers['anthropic-version'] ??= '2023-06-01'
    if (apiKey) {
      headers['x-api-key'] ??= apiKey
      if (input.authHeader) headers.Authorization ??= `Bearer ${apiKey}`
    }
    if (/\/v\d+$/i.test(baseUrl)) {
      candidateUrls.push(`${baseUrl}/models`)
    } else {
      candidateUrls.push(`${baseUrl}/v1/models`, `${baseUrl}/models`)
    }
  } else if (api === 'google-generative-ai') {
    if (apiKey) {
      headers['x-goog-api-key'] ??= apiKey
      if (input.authHeader) headers.Authorization ??= `Bearer ${apiKey}`
    }
    if (/\/v\d+(?:beta|alpha)?$/i.test(baseUrl)) {
      candidateUrls.push(`${baseUrl}/models`)
    } else {
      candidateUrls.push(`${baseUrl}/v1beta/models`, `${baseUrl}/models`)
    }
  } else {
    if (apiKey) {
      headers.Authorization ??= `Bearer ${apiKey}`
    }
    candidateUrls.push(`${baseUrl}/models`)
    if (!/\/v\d+$/i.test(baseUrl)) {
      candidateUrls.push(`${baseUrl}/v1/models`)
    }
  }

  const signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
  let lastError: unknown
  for (const url of candidateUrls) {
    try {
      const payload = await fetchJsonBounded(url, headers, signal)
      return parseDiscoveredModels(payload, api)
    } catch (error) {
      lastError = error
      if (signal.aborted) break
    }
  }
  if (signal.aborted) {
    throw new Error('Timed out while fetching models from endpoint')
  }
  throw lastError instanceof Error ? lastError : new Error('Failed to fetch models from endpoint')
}
