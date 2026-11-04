/** Sole writer of web-search.json; saves preserve unrelated legacy keys and never replace unreadable files. */
import { mkdir, readFile } from 'node:fs/promises'
import type { WebSearchSettingsState, WebSearchSettingsPatch, WebSearchProviderState } from '../../shared/api'
import { PROVIDERS, addedProviders, inlineLimit, searchProvider, providerKeySource } from '../plugins/pig-web/config'
import { parseFailure } from '../plugins/pig-web/utils'
import { pigPath } from '../pig-dir'
import { writeFileAtomic } from '../atomic-write'

export const WEB_SEARCH_PROVIDERS = PROVIDERS
export const webSearchConfigPath = (): string => pigPath('web-search.json')
const path = webSearchConfigPath
type Config = Record<string, unknown>

function object(value: unknown): Config {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object')
  return value as Config
}

async function load(): Promise<Config> {
  let text: string
  try { text = await readFile(path(), 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  let value: unknown
  try { value = JSON.parse(text) }
  catch (error) { throw new Error(`Invalid web-search.json: ${parseFailure(error)}`) }
  return object(value)
}

function state(config: Config, initialError: string | null = null): WebSearchSettingsState {
  const issues: string[] = initialError ? [initialError] : []
  const read = <T,>(fn: () => T, fallback: T): T => {
    try { return fn() } catch (error) { issues.push(error instanceof Error ? error.message : 'Invalid web setting'); return fallback }
  }
  return {
    settings: {
      provider: read(() => searchProvider(config.searchProvider ?? config.provider), 'duckduckgo'),
      addedProviders: read(() => addedProviders(config), ['duckduckgo']),
      maxInlineContentChars: read(() => config.maxInlineContentChars === undefined ? null : inlineLimit(config.maxInlineContentChars), null),
    },
    providers: PROVIDERS.map(option => {
      const apiKey = typeof config[option.apiKeyKey!] === 'string' ? config[option.apiKeyKey!] as string : ''
      const envAvailable = Boolean(option.apiKeyEnv && process.env[option.apiKeyEnv]?.trim())
      const apiKeySource = read(() => providerKeySource(option, config), 'config')
      return { ...option, apiKey, envAvailable, apiKeySource, source: apiKeySource === 'env' ? envAvailable ? 'env' : null : apiKey.trim() ? 'config' : null } satisfies WebSearchProviderState
    }),
    error: issues.join('\n') || null,
  }
}

export async function webSearchSettingsState(): Promise<WebSearchSettingsState> {
  try { return state(await load()) }
  catch (error) { return state({}, error instanceof Error ? error.message : 'Cannot read web-search.json') }
}

export function assertProviderSelection(id: string): void { searchProvider(id) }

function set(config: Config, key: string, value: unknown): void {
  if (value === null) delete config[key]
  else config[key] = value
}

function text(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new Error('Provider settings must be strings or null')
  return value.trim() || null
}

function apply(config: Config, input: WebSearchSettingsPatch): void {
  const patch = object(input)
  const allowed = ['provider', 'addedProviders', 'maxInlineContentChars', 'providers']
  if (Object.keys(patch).some(key => !allowed.includes(key))) throw new Error('Unknown web search setting')
  if (patch.provider !== undefined) {
    if (patch.provider !== null && (typeof patch.provider !== 'string' || !patch.provider)) throw new Error('Invalid search provider')
    set(config, 'searchProvider', patch.provider === null ? null : searchProvider(patch.provider))
    delete config.provider
  }
  if (patch.addedProviders !== undefined) config.addedProviders = addedProviders({ ...config, addedProviders: patch.addedProviders })
  if ((patch.provider !== undefined || patch.addedProviders !== undefined) && !addedProviders(config).includes(searchProvider(config.searchProvider ?? config.provider))) throw new Error('The selected search provider must be added first.')
  if (patch.maxInlineContentChars !== undefined) set(config, 'maxInlineContentChars', patch.maxInlineContentChars === null ? null : inlineLimit(patch.maxInlineContentChars))
  if (patch.providers !== undefined) {
    for (const [id, raw] of Object.entries(object(patch.providers))) {
      const option = PROVIDERS.find(provider => provider.id === id)
      if (!option) throw new Error('Unsupported search provider')
      const changes = object(raw)
      for (const [key, value] of Object.entries(changes)) {
        if (key === 'apiKey' && option.apiKeyKey) set(config, option.apiKeyKey, text(value))
        else if (key === 'apiKeySource' && option.kind === 'key') {
          if (value !== 'env' && value !== 'config') throw new Error('Invalid API key source')
          if (value === 'env' && !process.env[option.apiKeyEnv!]?.trim()) throw new Error(`${option.apiKeyEnv} is not available`)
          config[id + 'ApiKeySource'] = value
        }
        else throw new Error('Unsupported provider setting')
      }
    }
  }
}

let mutation: Promise<unknown> = Promise.resolve()
export function patchWebSearchSettings(patch: WebSearchSettingsPatch): Promise<WebSearchSettingsState> {
  const result = mutation.then(async () => {
    const config = await load()
    apply(config, patch)
    await mkdir(pigPath(), { recursive: true })
    await writeFileAtomic(path(), `${JSON.stringify(config, null, 2)}\n`)
    return state(config)
  })
  mutation = result.then(() => undefined, () => undefined)
  return result
}
