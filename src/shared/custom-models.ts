/**
 * Contracts for user-configured compatible providers and models stored in Pi's `models.json`.
 *
 * Raw API keys and literal header values stay in the main process: renderer views receive only
 * credential source metadata and boolean presence flags, while edits preserve untouched fields.
 */

export const CUSTOM_MODEL_APIS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai'
] as const

export type KnownCustomModelApi = (typeof CUSTOM_MODEL_APIS)[number]

export type CustomProviderAuthMode = 'api_key' | 'env' | 'none'

export interface CustomModelCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface CustomModelView {
  id: string
  name: string
  reasoning: boolean
  vision: boolean
  contextWindow: number
  maxTokens: number
  cost?: CustomModelCost
}

export interface CustomModelInput {
  /** Original model ID when editing an existing model entry; omitted when adding a new model. */
  previousId?: string
  id: string
  name?: string
  reasoning: boolean
  vision: boolean
  contextWindow: number
  maxTokens: number
  /** Omit to keep an existing cost object; pass null to remove custom cost metadata. */
  cost?: CustomModelCost | null
}

export interface CustomHeaderView {
  name: string
  /** Set only when the header references `$VAR` / `${VAR}`; literal values stay masked in main. */
  envVar?: string
  hasSavedValue: boolean
}

export interface CustomHeaderInput {
  name: string
  value?: string
  /** Preserve the previously saved value for `name` without resending it through the renderer. */
  keepSaved?: boolean
}

export interface CustomProviderView {
  id: string
  name: string
  api: string
  baseUrl: string
  authMode: CustomProviderAuthMode
  hasSavedKey: boolean
  envVar?: string
  envDetected?: boolean
  authHeader: boolean
  headers: CustomHeaderView[]
  models: CustomModelView[]
  configured: boolean
}

export interface CustomModelsState {
  providers: CustomProviderView[]
  /** Parse/IO error preventing `models.json` reads or writes. */
  error: string | null
  /** Composition or schema warning reported by `ModelRuntime.getError()`. */
  runtimeError: string | null
}

export interface CustomProviderInput {
  /** Original provider ID when editing an existing custom provider; omitted when creating. */
  previousId?: string
  id: string
  name?: string
  api: string
  baseUrl: string
  authMode: CustomProviderAuthMode
  /** New literal API key when `authMode === 'api_key'`; omit to keep an already-saved key. */
  apiKey?: string
  /** Environment variable name when `authMode === 'env'`. */
  envVar?: string
  authHeader: boolean
  headers?: CustomHeaderInput[]
  /** Optional model list to persist atomically when creating a provider. */
  models?: CustomModelInput[]
}

export interface DiscoveredRemoteModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  vision?: boolean
}

export interface DiscoverModelsInput {
  /** Existing custom provider ID so main can reuse stored credentials/headers without exposing them. */
  providerId?: string
  api: string
  baseUrl: string
  authMode: CustomProviderAuthMode
  apiKey?: string
  envVar?: string
  authHeader?: boolean
  headers?: CustomHeaderInput[]
}

export interface CustomModelsApi {
  getCustomModels: () => Promise<CustomModelsState>
  saveCustomProvider: (input: CustomProviderInput) => Promise<CustomModelsState>
  removeCustomProvider: (providerId: string) => Promise<CustomModelsState>
  saveCustomModel: (providerId: string, model: CustomModelInput | CustomModelInput[]) => Promise<CustomModelsState>
  removeCustomModel: (providerId: string, modelId: string) => Promise<CustomModelsState>
  discoverCustomModels: (input: DiscoverModelsInput) => Promise<DiscoveredRemoteModel[]>
}
