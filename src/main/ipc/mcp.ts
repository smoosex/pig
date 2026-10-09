/** Pig owns configuration and scope decisions; Pi owns MCP transport, OAuth and tool execution. */
import { BrowserWindow, ipcMain } from 'electron'
import type { McpConfig, McpSettingsState, ToolOverride } from '../../shared/api'
import { windowForEvent } from './window'
import { requireOpenedProject } from '../project-worktrees'
import { pendingToolSessions, refreshToolSessions } from '../pi/session-registry'
import {
  configuredServers,
  flushToolMutations,
  importMcpServers,
  previewMcpImport,
  readToolPreferences,
  removeMcpServer,
  saveMcpServer,
  setCodemode,
  setMcpEnabled,
  setProjectToolSettings
} from '../mcp/settings'
import { mcpCredentials } from '../mcp/sdk'
import { searchMcpMarket } from '../mcp/market'
import {
  cancelMcpLogin,
  cancelMcpOperations,
  loginMcpServer,
  logoutMcpServer,
  testMcpServer
} from '../mcp/manager'
import { emitToolSettingsChanged, onToolSettingsChanged } from '../mcp/events'
import { replyExtensionUI } from '../extension-ui'

export async function mcpSettingsState(): Promise<McpSettingsState> {
  await flushToolMutations()
  const credentials = await mcpCredentials()
  return {
    ...readToolPreferences(),
    pendingSessions: pendingToolSessions(),
    servers: (await configuredServers()).map(({ name, config }) => ({
      name,
      config,
      authenticated: 'url' in config && !!credentials.tokens(name, config.url)
    }))
  }
}
async function changed(project?: string): Promise<McpSettingsState> {
  await refreshToolSessions(project)
  emitToolSettingsChanged()
  return mcpSettingsState()
}
function name(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value) throw new Error('MCP server name is required')
}
export function registerMcpIpc(): void {
  onToolSettingsChanged(() => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('mcp:changed')
    }
  })
  ipcMain.handle('mcp:get', () => mcpSettingsState())
  ipcMain.handle('mcp:codemode', async (_event, enabled: boolean) => {
    await setCodemode(enabled)
    return changed()
  })
  ipcMain.handle(
    'mcp:project',
    async (
      _event,
      cwd: string,
      patch: { codemode?: ToolOverride; mcp?: Record<string, ToolOverride> }
    ) => {
      const project = await requireOpenedProject(cwd)
      await setProjectToolSettings(project, patch)
      return changed(project)
    }
  )
  ipcMain.handle(
    'mcp:save',
    async (_event, server: string, config: McpConfig, replace: boolean) => {
      name(server)
      await cancelMcpOperations(server)
      await saveMcpServer(server, config, replace === true)
      return changed()
    }
  )
  ipcMain.handle('mcp:remove', async (_event, server: string) => {
    name(server)
    await cancelMcpOperations(server)
    await removeMcpServer(server)
    return changed()
  })
  ipcMain.handle('mcp:enable', async (_event, server: string, enabled: boolean) => {
    name(server)
    await setMcpEnabled(server, enabled)
    return changed()
  })
  ipcMain.handle('mcp:preview', (_event, json: string, server?: string) =>
    previewMcpImport(json, server)
  )
  ipcMain.handle(
    'mcp:import',
    async (_event, json: string, replaceNames: string[], server?: string) => {
      if (!Array.isArray(replaceNames) || !replaceNames.every((key) => typeof key === 'string'))
        throw new Error('Expected replacement names')
      const entries = await previewMcpImport(json, server)
      await Promise.all(entries.map((entry) => cancelMcpOperations(entry.name)))
      await importMcpServers(json, replaceNames, server)
      return changed()
    }
  )
  ipcMain.handle('mcp:search', (_event, query: string) => {
    if (typeof query !== 'string') throw new Error('Expected a search query')
    return searchMcpMarket(query)
  })
  ipcMain.handle('mcp:test', (event, server: string) => {
    name(server)
    return testMcpServer(server, windowForEvent(event))
  })
  ipcMain.handle('mcp:login', async (event, server: string) => {
    name(server)
    const result = await loginMcpServer(windowForEvent(event), server)
    await changed()
    return result
  })
  ipcMain.handle('mcp:logout', async (_event, server: string) => {
    name(server)
    await logoutMcpServer(server)
    return changed()
  })
  ipcMain.handle('mcp:cancel-login', () => cancelMcpLogin())
  ipcMain.handle('extensions:reply', (event, id: string, value: string | null) =>
    replyExtensionUI(event.sender, id, value)
  )
}
