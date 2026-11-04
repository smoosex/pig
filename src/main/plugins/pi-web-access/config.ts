/** Search/fetch configuration shared by the extension and Pig's settings writer. */
import type { WebSearchProviderOption } from '../../../shared/api.ts';
import { createConfigFileReader } from './config-file.ts';

export const SEARCH_PROVIDERS = ['exa', 'deepseek', 'brave', 'tavily', 'duckduckgo'] as const;
export type SearchProvider = typeof SEARCH_PROVIDERS[number];
export const PROVIDERS: WebSearchProviderOption[] = [
  { id: 'exa', name: 'Exa', kind: 'key', apiKeyKey: 'exaApiKey', apiKeyEnv: 'EXA_API_KEY' },
  { id: 'deepseek', name: 'DeepSeek', kind: 'key', apiKeyKey: 'deepseekApiKey', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  { id: 'brave', name: 'Brave', kind: 'key', apiKeyKey: 'braveApiKey', apiKeyEnv: 'BRAVE_API_KEY' },
  { id: 'tavily', name: 'Tavily', kind: 'key', apiKeyKey: 'tavilyApiKey', apiKeyEnv: 'TAVILY_API_KEY' },
  { id: 'duckduckgo', name: 'DuckDuckGo', kind: 'none' },
];
const BASE_URLS = {
  exa: 'https://api.exa.ai',
  deepseek: 'https://api.deepseek.com/v1/tools',
  brave: 'https://api.search.brave.com/res/v1/web',
  tavily: 'https://api.tavily.com',
};
export const readConfig = createConfigFileReader<Record<string, unknown>>();

export function searchProvider(value: unknown): SearchProvider {
  if (value === undefined || value === null || value === '') return 'duckduckgo';
  if (typeof value === 'string' && SEARCH_PROVIDERS.includes(value as SearchProvider)) return value as SearchProvider;
  throw new Error('Select a supported search provider in Web Access settings; auto/all and legacy providers are no longer supported.');
}

export function selectedSearchProvider(config = readConfig()): SearchProvider {
  return searchProvider(config.searchProvider ?? config.provider);
}

/** Explicit UI membership, or the selected/configured providers for older files. */
export function addedProviders(config: Record<string, unknown>): SearchProvider[] {
  if (config.addedProviders === undefined) {
    return [...new Set([selectedSearchProvider(config), ...PROVIDERS.filter(option =>
      option.apiKeyKey && (config[option.apiKeyKey] || process.env[option.apiKeyEnv!])
    ).map(option => option.id as SearchProvider)])];
  }
  const value = config.addedProviders;
  if (!Array.isArray(value) || !value.length || value.some(id => typeof id !== 'string' || !SEARCH_PROVIDERS.includes(id as SearchProvider)) || new Set(value).size !== value.length) {
    throw new Error('addedProviders must be a non-empty list of unique supported providers.');
  }
  return value as SearchProvider[];
}

export function inlineLimit(value: unknown): number {
  if (value === undefined || value === null) return 20_000;
  if (!Number.isInteger(value) || typeof value !== 'number' || value < 1_000 || value > 50_000) {
    throw new Error('maxInlineContentChars must be an integer between 1000 and 50000');
  }
  return value;
}

export function providerKeySource(option: WebSearchProviderOption, config: Record<string, unknown>): 'env' | 'config' {
  if (option.kind === 'none') return 'config';
  const value = config[option.id + 'ApiKeySource'];
  if (value !== undefined && value !== 'env' && value !== 'config') throw new Error(`${option.name} API key source must be env or config.`);
  if (value) return value;
  return typeof config[option.apiKeyKey!] === 'string' && (config[option.apiKeyKey!] as string).trim() ? 'config' : process.env[option.apiKeyEnv!]?.trim() ? 'env' : 'config';
}

export function providerConnection(id: Exclude<SearchProvider, 'duckduckgo'>, config: Record<string, unknown>): { baseUrl: string; apiKey: string } {
  const option = PROVIDERS.find(provider => provider.id === id)!;
  const configured = config[option.apiKeyKey!];
  const source = providerKeySource(option, config);
  if (source === 'config' && configured !== undefined && typeof configured !== 'string') throw new Error(`${id} API key must be a string`);
  // Literal keys only: never execute a config value as a shell command.
  const apiKey = source === 'env' ? process.env[option.apiKeyEnv!]?.trim() : typeof configured === 'string' ? configured.trim() : '';
  if (!apiKey) throw new Error(`${option.name} API key is missing; configure it in Web Access settings or ${option.apiKeyEnv}.`);
  return { baseUrl: BASE_URLS[id], apiKey };
}
