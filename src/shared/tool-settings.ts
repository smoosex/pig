/** Pig-owned tool configuration and management DTOs; credentials never enter session history. */
import type { McpServerConfig } from '@earendil-works/pi-coding-agent'
import type { MessageKey } from './i18n'

export type McpConfig = McpServerConfig
export interface McpServerView {
  name: string
  config: McpConfig
  authenticated: boolean
  /** HTTPS icon source remembered from the catalog entry this server was added from. */
  icon?: string
  /** The recipe's description in the dictionary, when this server is one the catalog offers. */
  descriptionKey?: MessageKey
}
export interface McpSettingsState {
  servers: McpServerView[]
  pendingSessions: string[]
}
export interface McpMarketInput {
  key: string
  where: 'env' | 'header' | 'arg'
  label: string
  description?: string
  /** Sample value shown as the input's placeholder; never saved. */
  placeholder?: string
  /** Dictionary keys for the featured listing's own copy; a Registry listing ships English only. */
  labelKey?: MessageKey
  descriptionKey?: MessageKey
  required?: boolean
  secret?: boolean
  format?: string
}
export interface McpMarketServer {
  id: string
  name: string
  title: string
  description: string
  /** The featured listing's description in the dictionary; the Registry writes its own text. */
  descriptionKey?: MessageKey
  publisher?: string
  homepage?: string
  featured: boolean
  /** HTTPS source of the listing's icon, shown through the `pig-mcp-icon` scheme. */
  icon?: string
  config: McpConfig
  inputs: McpMarketInput[]
}
export interface McpMarketResult {
  servers: McpMarketServer[]
  error?: string
}
export interface McpImportEntry {
  name: string
  config: McpConfig
  conflict: boolean
}
export interface McpProbeResult {
  state: 'ready' | 'needs-auth' | 'failed'
  message?: string
  tools: { name: string; description?: string }[]
}
export type ExtensionUIEvent =
  | {
      kind: 'prompt'
      id: string
      owner: string
      method: 'input' | 'editor' | 'select' | 'confirm'
      title: string
      message?: string
      options?: string[]
      prefill?: string
    }
  | { kind: 'dismiss'; id: string }
  | { kind: 'notify'; owner: string; message: string; level: 'info' | 'warning' | 'error' }

export interface ToolSettingsApi {
  getMcpSettings(): Promise<McpSettingsState>
  saveMcpServer(name: string, config: McpConfig, replace: boolean, icon?: string): Promise<McpSettingsState>
  removeMcpServer(name: string): Promise<McpSettingsState>
  setMcpEnabled(name: string, enabled: boolean): Promise<McpSettingsState>
  previewMcpImport(json: string, name?: string): Promise<McpImportEntry[]>
  importMcpServers(json: string, replaceNames: string[], name?: string, icon?: string): Promise<McpSettingsState>
  searchMcpMarket(query: string): Promise<McpMarketResult>
  testMcpServer(name: string): Promise<McpProbeResult>
  loginMcpServer(name: string): Promise<McpProbeResult>
  logoutMcpServer(name: string): Promise<McpSettingsState>
  cancelMcpLogin(): Promise<void>
  replyExtensionUI(id: string, value: string | null): Promise<void>
  onExtensionUI(listener: (event: ExtensionUIEvent) => void): () => void
  onMcpChanged(listener: () => void): () => void
}
