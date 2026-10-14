/**
 * Pig-side settings for the bundled pi-web-access extension.
 *
 * The extension reads web-search.json on every call, so this module is the single writer: it
 * preserves unknown keys, validates the fields the settings page owns, and keeps the file at
 * mode 0600 because it stores API keys. Saving does not reload sessions; the caller does that
 * because the extension caches provider routing at load time.
 */
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import type {
  WebSearchFetchMode,
  WebSearchProviderOption,
  WebSearchProviderState,
  WebSearchSettings,
  WebSearchSettingsPatch,
  WebSearchSettingsState,
  WebSearchToolFlags
} from '../../shared/api'
import { pigPath } from '../pig-dir'

const FETCH_MODES: WebSearchFetchMode[] = ['readable', 'raw', 'answer']
const TOOL_KEYS: Array<keyof WebSearchToolFlags> = ['webSearch', 'sourceCheck', 'fetchContent', 'getSearchContent']
const MIN_INLINE_CONTENT_CHARS = 1_000
const MAX_INLINE_CONTENT_CHARS = 200_000

/**
 * Every credential the extension understands, in the order the settings page shows it.
 * `loginOptional` providers also accept a Pi provider login, so a missing key is not an error.
 */
export const WEB_SEARCH_PROVIDERS: WebSearchProviderOption[] = [
  { id: 'duckduckgo', name: 'DuckDuckGo', kind: 'none' },
  { id: 'degoog', name: 'degoog', kind: 'key', loginOptional: true, apiKeyKey: 'degoogApiKey', apiKeyEnv: 'DEGOOG_API_KEY', baseUrlKey: 'degoogBaseUrl', baseUrlEnv: 'DEGOOG_URL', note: 'Self-hosted or public instance; the key is optional' },
  { id: 'searxng', name: 'SearXNG', kind: 'none', baseUrlKey: 'searxngBaseUrl', baseUrlEnv: 'SEARXNG_BASE_URL', note: 'Self-hosted instance URL' },
  {
    id: 'gemini', name: 'Gemini', kind: 'key', apiKeyKey: 'geminiApiKey', apiKeyEnv: 'GEMINI_API_KEY',
    extras: [
      { key: 'geminiAuth', label: 'Auth mode (adc)', type: 'select', options: ['', 'adc'] },
      { key: 'geminiProject', label: 'Google Cloud project' },
      { key: 'geminiLocation', label: 'Google Cloud location' },
      { key: 'geminiBaseUrl', label: 'Base URL', env: 'GOOGLE_GEMINI_BASE_URL' },
      { key: 'cloudflareApiKey', label: 'Cloudflare API key', env: 'CLOUDFLARE_API_KEY' },
      { key: 'browserCookies.browser', label: 'Browser cookies: browser', type: 'select', options: ['', 'chrome', 'chromium', 'brave', 'arc', 'edge'] },
      { key: 'browserCookies.profile', label: 'Browser cookies: profile' }
    ],
    note: 'API key, browser cookies, or Application Default Credentials'
  },
  { id: 'ollama', name: 'Ollama', kind: 'key', apiKeyKey: 'ollamaApiKey', apiKeyEnv: 'OLLAMA_API_KEY', note: 'Ollama Cloud' },
  {
    id: 'openai', name: 'OpenAI', kind: 'key', loginOptional: true, apiKeyKey: 'openaiApiKey', apiKeyEnv: 'OPENAI_API_KEY',
    extras: [
      { key: 'openaiUseAlphaSearch', label: 'Use alpha search', type: 'boolean' },
      { key: 'openaiUseProviderBaseUrl', label: 'Use provider base URL', type: 'boolean' }
    ]
  },
  { id: 'brave', name: 'Brave', kind: 'key', apiKeyKey: 'braveApiKey', apiKeyEnv: 'BRAVE_API_KEY', baseUrlKey: 'braveBaseUrl', baseUrlEnv: 'BRAVE_BASE_URL' },
  { id: 'parallel', name: 'Parallel', kind: 'key', apiKeyKey: 'parallelApiKey', apiKeyEnv: 'PARALLEL_API_KEY' },
  { id: 'parallel-mcp', name: 'Parallel MCP', kind: 'key', apiKeyKey: 'parallelApiKey', apiKeyEnv: 'PARALLEL_API_KEY', note: 'Shares the Parallel API key over MCP' },
  { id: 'tinyfish', name: 'TinyFish', kind: 'key', apiKeyKey: 'tinyfishApiKey', apiKeyEnv: 'TINYFISH_API_KEY' },
  { id: 'search1api', name: 'Search1API', kind: 'key', apiKeyKey: 'search1apiApiKey', apiKeyEnv: 'SEARCH1API_KEY' },
  { id: 'searchinfinity', name: 'Searchinfinity', kind: 'key', apiKeyKey: 'searchinfinityApiKey', apiKeyEnv: 'SEARCHINFINITY_API_KEY' },
  { id: 'querit', name: 'Querit', kind: 'key', apiKeyKey: 'queritApiKey', apiKeyEnv: 'QUERIT_API_KEY' },
  { id: 'tavily', name: 'Tavily', kind: 'key', apiKeyKey: 'tavilyApiKey', apiKeyEnv: 'TAVILY_API_KEY', baseUrlKey: 'tavilyBaseUrl', baseUrlEnv: 'TAVILY_BASE_URL' },
  { id: 'you', name: 'You.com', kind: 'key', apiKeyKey: 'youApiKey', apiKeyEnv: 'YDC_API_KEY' },
  {
    id: 'firecrawl', name: 'Firecrawl', kind: 'key', apiKeyKey: 'firecrawlApiKey', apiKeyEnv: 'FIRECRAWL_API_KEY',
    baseUrlKey: 'firecrawlBaseUrl', baseUrlEnv: 'FIRECRAWL_BASE_URL',
    extras: [
      { key: 'firecrawlApiVersion', label: 'API version', env: 'FIRECRAWL_API_VERSION' },
      { key: 'firecrawlFreshScrape', label: 'Fresh scrape', type: 'boolean' }
    ]
  },
  { id: 'jina', name: 'Jina', kind: 'key', apiKeyKey: 'jinaApiKey', apiKeyEnv: 'JINA_API_KEY' },
  { id: 'perplexity', name: 'Perplexity', kind: 'key', apiKeyKey: 'perplexityApiKey', apiKeyEnv: 'PERPLEXITY_API_KEY' },
  { id: 'kimi', name: 'Kimi', kind: 'piLogin', note: 'Pi login: Kimi Code Plan' },
  { id: 'exa', name: 'Exa', kind: 'key', apiKeyKey: 'exaApiKey', apiKeyEnv: 'EXA_API_KEY', baseUrlKey: 'exaBaseUrl', baseUrlEnv: 'EXA_BASE_URL' },
  { id: 'serpdive', name: 'SERPdive', kind: 'key', apiKeyKey: 'serpdiveApiKey', apiKeyEnv: 'SERPDIVE_API_KEY', extras: [{ key: 'serpdiveModel', label: 'Model', env: 'SERPDIVE_MODEL' }] },
  { id: 'kagi', name: 'Kagi', kind: 'key', apiKeyKey: 'kagiApiKey', apiKeyEnv: 'KAGI_API_KEY' },
  { id: 'anysearch', name: 'AnySearch', kind: 'key', apiKeyKey: 'anysearchApiKey', apiKeyEnv: 'ANYSEARCH_API_KEY' },
  { id: 'xai', name: 'xAI', kind: 'key', loginOptional: true, apiKeyKey: 'xaiApiKey', apiKeyEnv: 'XAI_API_KEY' },
  {
    id: 'mistral', name: 'Mistral', kind: 'key', apiKeyKey: 'mistralApiKey', apiKeyEnv: 'MISTRAL_API_KEY',
    extras: [
      { key: 'mistralSearchModel', label: 'Model' },
      { key: 'mistralSearchTool', label: 'Tool', type: 'select', options: ['', 'web_search', 'web_search_premium'] }
    ]
  },
  { id: 'brightdata', name: 'Bright Data', kind: 'key', apiKeyKey: 'brightdataApiKey', apiKeyEnv: 'BRIGHTDATA_API_KEY', extras: [{ key: 'brightdataSerpZone', label: 'SERP zone', env: 'BRIGHTDATA_SERP_ZONE' }] },
  { id: 'serpbase', name: 'SerpBase', kind: 'key', apiKeyKey: 'serpbaseApiKey', apiKeyEnv: 'SERPBASE_API_KEY' },
  { id: 'serpapi', name: 'SerpApi', kind: 'key', apiKeyKey: 'serpapiApiKey', apiKeyEnv: 'SERPAPI_KEY' },
  { id: 'serper', name: 'Serper', kind: 'key', apiKeyKey: 'serperApiKey', apiKeyEnv: 'SERPER_API_KEY' },
  { id: 'serply', name: 'Serply', kind: 'key', apiKeyKey: 'serplyApiKey', apiKeyEnv: 'SERPLY_API_KEY' },
  { id: 'baizhi', name: 'Baizhi', kind: 'key', apiKeyKey: 'baizhiApiKey', apiKeyEnv: 'BAIZHI_API_KEY' },
  { id: 'zai', name: 'Z.ai', kind: 'key', apiKeyKey: 'zaiApiKey', apiKeyEnv: 'ZAI_API_KEY', note: 'GLM Coding Plan key; searches use plan quota',
    extras: [{ key: 'zaiEndpoint', label: 'Endpoint', type: 'select', options: ['', 'global', 'china'] }] },
  { id: 'keenable', name: 'Keenable', kind: 'key', loginOptional: true, apiKeyKey: 'keenableApiKey', apiKeyEnv: 'KEENABLE_API_KEY', note: 'Works without a key; a key raises the rate limit' },
  { id: 'ceramic', name: 'Ceramic', kind: 'key', apiKeyKey: 'ceramicApiKey', apiKeyEnv: 'CERAMIC_API_KEY', note: 'Paid keyword search API' },
  { id: 'valyu', name: 'Valyu', kind: 'key', apiKeyKey: 'valyuApiKey', apiKeyEnv: 'VALYU_API_KEY' },
  { id: 'bocha', name: 'Bocha', kind: 'key', apiKeyKey: 'bochaApiKey', apiKeyEnv: 'BOCHA_API_KEY' },
  { id: 'xcrawl', name: 'XCrawl', kind: 'key', apiKeyKey: 'xcrawlApiKey', apiKeyEnv: 'XCRAWL_API_KEY' },
  {
    id: 'datalab', name: 'Datalab PDF', kind: 'key', group: 'extract',
    apiKeyKey: 'datalabApiKey', apiKeyEnv: 'DATALAB_API_KEY',
    extras: [{ key: 'datalabMode', label: 'Mode', type: 'select', options: ['', 'fast', 'balanced', 'accurate'], env: 'DATALAB_MODE' }]
  },
  {
    id: 'pdf-endpoint', name: 'PDF endpoint', kind: 'none', group: 'extract',
    baseUrlKey: 'pdf.endpointUrl', baseUrlEnv: 'PDF_ENDPOINT_URL',
    extras: [{ key: 'pdf.provider', label: 'PDF provider', type: 'select', options: ['', 'auto', 'endpoint', 'gemini', 'datalab', 'unpdf'] }],
    note: 'Your own document parser; select "endpoint" as the PDF provider to use it'
  },
  {
    id: 'crawl4ai', name: 'Crawl4AI', kind: 'key', group: 'extract',
    apiKeyKey: 'crawl4aiApiToken', apiKeyEnv: 'CRAWL4AI_API_TOKEN',
    baseUrlKey: 'crawl4aiBaseUrl', baseUrlEnv: 'CRAWL4AI_BASE_URL'
  }
]

type Config = Record<string, unknown>

const configPath = (): string => pigPath('web-search.json')

/** Path of the settings file the bundled web-access plugin reads; shared with the icon cache. */
export const webSearchConfigPath = configPath

function isRecord(value: unknown): value is Config {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Reading for the settings surface. A file that cannot be read or parsed is reported instead of
 * thrown: the panel has to open on it so the user can repair it, and the next save rewrites it.
 */
async function loadConfig(): Promise<{ config: Config; error: string | null; unreadable: boolean }> {
  let text: string
  try {
    text = await readFile(configPath(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { config: {}, error: null, unreadable: false }
    return { config: {}, error: `Cannot read ${configPath()}: ${errorMessage(error)}`, unreadable: true }
  }
  try {
    const value: unknown = JSON.parse(text)
    if (!isRecord(value)) throw new Error('expected a JSON object')
    return { config: value, error: null, unreadable: false }
  } catch (error) {
    return { config: {}, error: `Invalid ${configPath()}: ${errorMessage(error)}`, unreadable: false }
  }
}

function getPath(config: Config, path: string): unknown {
  let current: unknown = config
  for (const part of path.split('.')) {
    if (!isRecord(current)) return undefined
    current = current[part]
  }
  return current
}

function setPath(config: Config, path: string, value: unknown): void {
  const parts = path.split('.')
  let current: Config = config
  for (const part of parts.slice(0, -1)) {
    const next = current[part]
    if (!isRecord(next)) {
      if (value === null) return
      current[part] = {}
    }
    current = current[part] as Config
  }
  const last = parts[parts.length - 1]
  if (value === null) delete current[last]
  else current[last] = value
}

function configString(config: Config, path: string | undefined): string {
  if (!path) return ''
  const value = getPath(config, path)
  if (typeof value === 'string') return value
  return value === undefined || value === null ? '' : String(value)
}

const normalizeProviderId = (id: string): string => id.trim().toLowerCase()

function requireArray(value: unknown, message: string): void {
  if (!Array.isArray(value)) throw new Error(message)
}

/**
 * Reads a value the extension validates strictly when it loads. Pig mirrors those rules instead of
 * filtering to a valid-looking subset: a hand-edited file that cannot work says so here, rather
 * than showing healthy controls and failing inside a search.
 */
function providerList(value: unknown): string[] | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || !value.length) throw new Error('webSearch.allowedProviders must be a non-empty array')
  const ids: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim()) throw new Error('webSearch.allowedProviders must contain only provider ids')
    const id = normalizeProviderId(entry)
    requireSearchProvider(id)
    if (ids.includes(id)) throw new Error(`webSearch.allowedProviders must not contain duplicates: ${id}`)
    ids.push(id)
  }
  return ids
}

function fetchModeList(value: unknown): WebSearchFetchMode[] | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || !value.length) throw new Error('fetch.allowedModes must be a non-empty array')
  const modes: WebSearchFetchMode[] = []
  for (const entry of value) {
    if (!FETCH_MODES.includes(entry as WebSearchFetchMode)) throw new Error(`Unsupported fetch mode: ${String(entry)}`)
    if (modes.includes(entry as WebSearchFetchMode)) throw new Error(`fetch.allowedModes must not contain duplicates: ${String(entry)}`)
    modes.push(entry as WebSearchFetchMode)
  }
  return modes
}

/** An unset default means "readable" to the extension, so it has to stay an allowed mode. */
function fetchMode(value: unknown, allowed: WebSearchFetchMode[] | null): WebSearchFetchMode | null {
  const modes = allowed ?? FETCH_MODES
  if (value === undefined || value === null) {
    if (!modes.includes('readable')) throw new Error('fetch.defaultMode must be one of fetch.allowedModes')
    return null
  }
  if (!FETCH_MODES.includes(value as WebSearchFetchMode)) throw new Error(`Unsupported fetch mode: ${String(value)}`)
  if (!modes.includes(value as WebSearchFetchMode)) throw new Error('fetch.defaultMode must be one of fetch.allowedModes')
  return value as WebSearchFetchMode
}

function ssrfRanges(value: unknown): string[] | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value)) throw new Error('ssrf.allowRanges must be an array of CIDR strings')
  const ranges: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim()) throw new Error('ssrf.allowRanges must contain only CIDR strings')
    assertCidrRange(entry.trim())
    ranges.push(entry.trim())
  }
  return ranges.length ? ranges : null
}

function ssrfBoolean(value: unknown): boolean | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'boolean') throw new Error('ssrf.trustEnvProxy must be a boolean')
  return value
}

function fetchRedirects(value: unknown): 'same-origin' | null {
  if (value === undefined || value === null) return null
  if (value !== 'same-origin') throw new Error('fetchContent.redirects must be "same-origin"')
  return value
}

/**
 * Lenient read: a field the extension would reject reads as unset and its message is collected, so
 * the panel shows the rest of the config and can repair the broken field on save.
 */
function readSettingsLenient(config: Config): { settings: WebSearchSettings; issues: string[] } {
  const issues: string[] = []
  const collect = <T,>(read: () => T, fallback: T): T => {
    try {
      return read()
    } catch (error) {
      issues.push(errorMessage(error))
      return fallback
    }
  }
  const fetchConfig = isRecord(config.fetch) ? config.fetch : {}
  const ssrf = isRecord(config.ssrf) ? config.ssrf : {}
  const fetchContent = isRecord(config.fetchContent) ? config.fetchContent : {}
  const webSearch = isRecord(config.webSearch) ? config.webSearch : {}
  const tools = isRecord(config.tools) ? config.tools : {}
  const allowedModes = collect(() => fetchModeList(fetchConfig.allowedModes), null)
  // The extension reads an unset default as "readable" and rejects a default outside
  // fetch.allowedModes, so a rejected default has to read back as a mode the panel can save;
  // falling back to null would fail the same cross-field check again on the next save.
  const defaultModeFallback = allowedModes === null || allowedModes.includes('readable') ? null : allowedModes[0]
  const settings: WebSearchSettings = {
    provider: normalizeProviderId(configString(config, 'searchProvider') || configString(config, 'provider')) || null,
    allowedProviders: collect(() => providerList(webSearch.allowedProviders), null),
    maxInlineContentChars: typeof config.maxInlineContentChars === 'number' ? config.maxInlineContentChars : null,
    fetchDefaultMode: collect(() => fetchMode(fetchConfig.defaultMode, allowedModes), defaultModeFallback),
    fetchAllowedModes: allowedModes,
    ssrfAllowRanges: collect(() => ssrfRanges(ssrf.allowRanges), null),
    ssrfTrustEnvProxy: collect(() => ssrfBoolean(ssrf.trustEnvProxy), null),
    fetchRedirects: collect(() => fetchRedirects(fetchContent.redirects), null),
    tools: Object.fromEntries(TOOL_KEYS.map((key) => {
      const entry = tools[key]
      const enabled = isRecord(entry) ? entry.enabled : undefined
      if (typeof enabled === 'boolean') return [key, enabled]
      // Without an explicit override the extension falls back to webSearch.enabled, and only for
      // web_search and source_check.
      if (key === 'webSearch' || key === 'sourceCheck') return [key, webSearch.enabled !== false]
      return [key, true]
    })) as unknown as WebSearchToolFlags
  }
  return { settings, issues }
}

function readProviderState(config: Config, option: WebSearchProviderOption): WebSearchProviderState {
  const apiKey = configString(config, option.apiKeyKey)
  const baseUrl = configString(config, option.baseUrlKey)
  const extraValues: Record<string, string> = {}
  for (const field of option.extras ?? []) {
    const value = getPath(config, field.key)
    extraValues[field.key] = typeof value === 'boolean' ? String(value) : configString(config, field.key)
  }
  // SearXNG is configured by base URL alone, so both fields count as configured.
  const fromEnv = Boolean(
    (option.apiKeyEnv && process.env[option.apiKeyEnv]) || (option.baseUrlEnv && process.env[option.baseUrlEnv])
  )
  const source: WebSearchProviderState['source'] = apiKey || baseUrl ? 'config' : fromEnv ? 'env' : null
  return { ...option, apiKey, baseUrl, extraValues, source }
}

export async function webSearchSettingsState(): Promise<WebSearchSettingsState> {
  const { config, error } = await loadConfig()
  const { settings, issues } = readSettingsLenient(config)
  return {
    settings,
    providers: WEB_SEARCH_PROVIDERS.map((option) => readProviderState(config, option)),
    error: [error, ...issues].filter(Boolean).join('\n') || null
  }
}

/** Provider ids are matched the way the extension normalizes them, so "Brave" is accepted. */
function requireProvider(id: string): WebSearchProviderOption {
  const option = WEB_SEARCH_PROVIDERS.find((item) => item.id === normalizeProviderId(id))
  if (!option) throw new Error(`Unknown web search provider: ${id}`)
  return option
}

/** Only search engines can be a default or an allowlist entry: web_search never routes extract providers. */
function requireSearchProvider(id: string): WebSearchProviderOption {
  const option = requireProvider(id)
  if (option.group === 'extract') throw new Error(`${option.name} is a content extractor, not a search provider`)
  return option
}

/** Validates a provider id from the renderer: `auto` and `all` route inside the allowlist. */
export function assertProviderSelection(id: string): void {
  const normalized = normalizeProviderId(id)
  if (normalized === 'auto' || normalized === 'all') return
  requireSearchProvider(normalized)
}

function applyProviderPatch(config: Config, id: string, patch: NonNullable<WebSearchSettingsPatch['providers']>[string]): void {
  const option = requireProvider(id)
  const text = (value: string | null | undefined, label: string): string | null => {
    if (value === undefined || value === null) return null
    if (typeof value !== 'string') throw new Error(`${label} must be a string`)
    return value.trim() || null
  }
  if (patch.apiKey !== undefined) {
    if (option.kind !== 'key') throw new Error(`${option.name} does not take an API key`)
    setPath(config, option.apiKeyKey!, text(patch.apiKey, `${option.name} API key`))
  }
  if (patch.baseUrl !== undefined) {
    if (!option.baseUrlKey) throw new Error(`${option.name} has no base URL setting`)
    setPath(config, option.baseUrlKey, text(patch.baseUrl, `${option.name} base URL`))
  }
  if (patch.extras !== undefined && patch.extras !== null && !isRecord(patch.extras)) {
    throw new Error(`${option.name} settings must be an object`)
  }
  for (const [key, value] of Object.entries(patch.extras ?? {})) {
    const field = (option.extras ?? []).find((item) => item.key === key)
    if (!field) throw new Error(`${option.name} has no setting named ${key}`)
    if (field.type === 'boolean') setPath(config, key, value === null || value === undefined ? null : value === 'true')
    else setPath(config, key, text(value, `${option.name} ${field.label}`))
  }
}

/**
 * The extension refuses to run an explicit provider its allowlist excludes, so refuse to store one:
 * the settings page only offers added engines, but hand-edited files must not end up unusable.
 * `auto` and `all` route inside the allowlist instead of naming a provider, so they always pass.
 */
function assertDefaultProviderAllowed(config: Config): void {
  const provider = normalizeProviderId(configString(config, 'searchProvider') || configString(config, 'provider'))
  if (!provider || provider === 'auto' || provider === 'all') return
  const webSearch = isRecord(config.webSearch) ? config.webSearch : {}
  let allowed: string[] | null
  try {
    allowed = providerList(webSearch.allowedProviders)
  } catch {
    // An unusable allowlist is the panel's business to report; it must not block a save.
    return
  }
  if (allowed && !allowed.includes(provider)) {
    throw new Error(`Default provider ${provider} is not in webSearch.allowedProviders`)
  }
}

/** Mirrors the extension's own CIDR parser so a bad range fails here instead of at search time. */
function assertCidrRange(value: string): void {
  const slash = value.lastIndexOf('/')
  const address = slash >= 0 ? value.slice(0, slash) : value
  const prefixPart = slash >= 0 ? value.slice(slash + 1) : null
  const version = isIP(address)
  const maxPrefix = version === 4 ? 32 : version === 6 ? 128 : 0
  const prefix = prefixPart === null ? maxPrefix : /^\d+$/.test(prefixPart) ? Number(prefixPart) : 0
  if (!maxPrefix || prefix < 1 || prefix > maxPrefix) {
    throw new Error(`Invalid CIDR notation in ssrf.allowRanges: "${value}"`)
  }
}

function applyPatch(config: Config, patch: WebSearchSettingsPatch): void {
  // The IPC boundary only proves the patch is an object, so every collection is checked here.
  if (patch.allowedProviders !== undefined && patch.allowedProviders !== null) {
    requireArray(patch.allowedProviders, 'webSearch.allowedProviders must be an array of provider ids')
  }
  if (patch.fetchAllowedModes !== undefined && patch.fetchAllowedModes !== null) {
    requireArray(patch.fetchAllowedModes, 'fetch.allowedModes must be an array of fetch modes')
  }
  if (patch.ssrfAllowRanges !== undefined && patch.ssrfAllowRanges !== null) {
    requireArray(patch.ssrfAllowRanges, 'ssrf.allowRanges must be an array of CIDR strings')
  }
  if (patch.tools !== undefined && patch.tools !== null && !isRecord(patch.tools)) throw new Error('tools must be an object')
  if (patch.providers !== undefined && patch.providers !== null && !isRecord(patch.providers)) throw new Error('providers must be an object')
  if (patch.provider !== undefined) {
    if (patch.provider !== null && typeof patch.provider !== 'string') throw new Error('provider must be a string or null')
    const provider = patch.provider === null ? '' : normalizeProviderId(patch.provider)
    if (provider) assertProviderSelection(provider)
    setPath(config, 'searchProvider', provider || null)
    setPath(config, 'provider', null)
  }
  if (patch.allowedProviders !== undefined) {
    const allowed: string[] = []
    for (const id of patch.allowedProviders ?? []) {
      if (typeof id !== 'string' || !id.trim()) throw new Error('webSearch.allowedProviders must contain only provider ids')
      const normalized = normalizeProviderId(id)
      requireSearchProvider(normalized)
      if (!allowed.includes(normalized)) allowed.push(normalized)
    }
    setPath(config, 'webSearch.allowedProviders', allowed.length ? allowed : null)
  }
  if (patch.maxInlineContentChars !== undefined) {
    const value = patch.maxInlineContentChars
    if (value !== null && (!Number.isInteger(value) || value < MIN_INLINE_CONTENT_CHARS || value > MAX_INLINE_CONTENT_CHARS)) {
      throw new Error(`maxInlineContentChars must be an integer between ${MIN_INLINE_CONTENT_CHARS} and ${MAX_INLINE_CONTENT_CHARS}`)
    }
    setPath(config, 'maxInlineContentChars', value)
  }
  if (patch.fetchDefaultMode !== undefined) {
    const mode = patch.fetchDefaultMode
    if (mode !== null && !FETCH_MODES.includes(mode as WebSearchFetchMode)) throw new Error(`Unsupported fetch mode: ${mode}`)
    setPath(config, 'fetch.defaultMode', mode)
  }
  if (patch.fetchAllowedModes !== undefined) {
    const modes = patch.fetchAllowedModes
    if (modes !== null && (!modes.length || modes.some((mode) => !FETCH_MODES.includes(mode as WebSearchFetchMode)))) {
      throw new Error('fetch.allowedModes must contain readable, raw, or answer')
    }
    setPath(config, 'fetch.allowedModes', modes)
  }
  if (patch.ssrfAllowRanges !== undefined) {
    const ranges: string[] = []
    for (const range of patch.ssrfAllowRanges ?? []) {
      if (typeof range !== 'string' || !range.trim()) throw new Error('ssrf.allowRanges must contain only CIDR strings')
      assertCidrRange(range.trim())
      ranges.push(range.trim())
    }
    setPath(config, 'ssrf.allowRanges', ranges.length ? ranges : null)
  }
  if (patch.ssrfTrustEnvProxy !== undefined) {
    if (patch.ssrfTrustEnvProxy !== null && typeof patch.ssrfTrustEnvProxy !== 'boolean') {
      throw new Error('ssrf.trustEnvProxy must be a boolean')
    }
    setPath(config, 'ssrf.trustEnvProxy', patch.ssrfTrustEnvProxy)
  }
  if (patch.fetchRedirects !== undefined) {
    if (patch.fetchRedirects !== null && patch.fetchRedirects !== 'same-origin') {
      throw new Error('fetchContent.redirects must be "same-origin"')
    }
    setPath(config, 'fetchContent.redirects', patch.fetchRedirects)
  }
  for (const key of Object.keys(patch.tools ?? {})) {
    if (!TOOL_KEYS.includes(key as keyof WebSearchToolFlags)) throw new Error(`Unknown web search tool: ${key}`)
  }
  // Both tools share the legacy fallback, so write what it currently implies for the untouched one
  // before dropping the flag: a single source of truth, and no behaviour change.
  const legacyEnabled = getPath(config, 'webSearch.enabled')
  const retiresLegacyFlag = legacyEnabled !== undefined && ('webSearch' in (patch.tools ?? {}) || 'sourceCheck' in (patch.tools ?? {}))
  if (retiresLegacyFlag) {
    for (const key of ['webSearch', 'sourceCheck'] as const) {
      if (key in (patch.tools ?? {}) || typeof getPath(config, `tools.${key}.enabled`) === 'boolean') continue
      setPath(config, `tools.${key}.enabled`, legacyEnabled !== false)
    }
    setPath(config, 'webSearch.enabled', null)
  }
  for (const [key, enabled] of Object.entries(patch.tools ?? {})) {
    if (enabled !== null && typeof enabled !== 'boolean') throw new Error(`tools.${key}.enabled must be a boolean`)
    setPath(config, `tools.${key}.enabled`, enabled)
  }
  for (const [id, providerPatch] of Object.entries(patch.providers ?? {})) {
    if (!isRecord(providerPatch)) throw new Error(`${id} settings must be an object`)
    applyProviderPatch(config, id, providerPatch)
  }
}

/**
 * Cross-field checks for the fields this patch writes. Pig deliberately does not validate the whole
 * file: a hand-edited value elsewhere must not stop the panel from repairing one field at a time.
 */
function validatePatchedFields(config: Config, patch: WebSearchSettingsPatch): void {
  if (patch.provider !== undefined || patch.allowedProviders !== undefined) assertDefaultProviderAllowed(config)
  if (patch.fetchAllowedModes !== undefined || patch.fetchDefaultMode !== undefined) {
    const fetchConfig = isRecord(config.fetch) ? config.fetch : {}
    fetchMode(fetchConfig.defaultMode, fetchModeList(fetchConfig.allowedModes))
  }
}

let mutation: Promise<unknown> = Promise.resolve()

function serialize<T>(action: () => Promise<T>): Promise<T> {
  const result = mutation.then(action)
  mutation = result.then(() => undefined, () => undefined)
  return result
}

export function patchWebSearchSettings(patch: WebSearchSettingsPatch): Promise<WebSearchSettingsState> {
  return serialize(async () => {
    const { config, error, unreadable } = await loadConfig()
    // A read failure is not a broken config the panel can rewrite: saving would replace a file
    // whose contents were never seen, silently dropping credentials and unknown keys.
    if (unreadable) throw new Error(error ?? `Cannot read ${configPath()}`)
    applyPatch(config, patch)
    validatePatchedFields(config, patch)
    const path = configPath()
    await mkdir(pigPath(), { recursive: true })
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, path)
      await chmod(path, 0o600)
    } catch (error) {
      const { rm } = await import('node:fs/promises')
      await rm(temp, { force: true })
      throw error
    }
    return webSearchSettingsState()
  })
}

/** The tool name the extension registers, which the test runner has to look up. */
export async function webSearchToolName(): Promise<string> {
  const { config } = await loadConfig()
  return configString(config, 'toolNames.webSearch') || 'web_search'
}
