/** Pig-owned tool configuration and management DTOs; credentials never enter session history. */
import type { McpServerConfig } from '@earendil-works/pi-coding-agent'

export type McpConfig = McpServerConfig
export type ToolOverride = boolean | null
export interface ProjectToolSettings {
  codemode?: boolean
  mcp: Record<string, boolean>
}
export interface ToolPreferences {
  codemode: boolean
  projects: Record<string, ProjectToolSettings>
}
export interface McpServerView {
  name: string
  config: McpConfig
  authenticated: boolean
}
export interface McpSettingsState extends ToolPreferences {
  servers: McpServerView[]
  pendingSessions: string[]
}
export interface McpMarketInput {
  key: string
  where: 'env' | 'header' | 'arg' | 'url'
  label: string
  description?: string
  required?: boolean
  secret?: boolean
  format?: string
}
export interface McpMarketServer {
  id: string
  name: string
  title: string
  description: string
  publisher?: string
  homepage?: string
  featured: boolean
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
  setCodemode(enabled: boolean): Promise<McpSettingsState>
  setProjectToolSettings(
    cwd: string,
    patch: { codemode?: ToolOverride; mcp?: Record<string, ToolOverride> }
  ): Promise<McpSettingsState>
  saveMcpServer(name: string, config: McpConfig, replace: boolean): Promise<McpSettingsState>
  removeMcpServer(name: string): Promise<McpSettingsState>
  setMcpEnabled(name: string, enabled: boolean): Promise<McpSettingsState>
  previewMcpImport(json: string, name?: string): Promise<McpImportEntry[]>
  importMcpServers(json: string, replaceNames: string[], name?: string): Promise<McpSettingsState>
  searchMcpMarket(query: string): Promise<McpMarketResult>
  testMcpServer(name: string): Promise<McpProbeResult>
  loginMcpServer(name: string): Promise<McpProbeResult>
  logoutMcpServer(name: string): Promise<McpSettingsState>
  cancelMcpLogin(): Promise<void>
  replyExtensionUI(id: string, value: string | null): Promise<void>
  onExtensionUI(listener: (event: ExtensionUIEvent) => void): () => void
  onMcpChanged(listener: () => void): () => void
}

export function effectiveCodemode(settings: ToolPreferences, project?: string | null): boolean {
  return (project ? settings.projects[project]?.codemode : undefined) ?? settings.codemode
}
export function projectMcpOverride(
  project: ProjectToolSettings | undefined,
  name: string
): boolean | undefined {
  return project && Object.hasOwn(project.mcp, name) ? project.mcp[name] : undefined
}
export function effectiveMcpEnabled(
  config: McpConfig,
  settings: ToolPreferences,
  name: string,
  project?: string | null
): boolean {
  return (
    projectMcpOverride(project ? settings.projects[project] : undefined, name) ??
    config.enabled === true
  )
}
