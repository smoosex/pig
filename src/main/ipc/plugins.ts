import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { MemoryPluginSettingsPatch, PluginScope, WebSearchSettingsPatch } from '../../shared/api'
import { windowForEvent } from './window'
import {
  getMemoryPluginDefaults,
  getMemoryPluginSettings,
  getPluginSettings,
  installPlugin,
  isMemoryPluginEnabled,
  listPlugins,
  removePlugin,
  setMemoryPluginSettings,
  setPluginScopes,
  setPluginSettings,
  updatePlugin
} from '../pi/plugins'
import { getLive, hasBusyPluginSessions, refreshPluginSessions, sessionCwd, sessionSourceFor } from '../pi/session-registry'
import { isChatCwd } from '../chats'
import { assertProviderSelection, patchWebSearchSettings, webSearchSettingsState } from '../pi/web-search-settings'
import { testWebSearchProvider } from '../pi/web-search-test'
import { memoryStatus, memoryView } from '../plugins/observational-memory/details'
import type { Entry } from '../plugins/observational-memory/session-ledger'
import { replyReviewUI } from '../pi/system-plugin-ui'
import { registerPersonaIpc } from './persona'

function changed(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('plugins:changed')
  }
}

export function registerPluginIpc(): void {
  registerPersonaIpc()
  ipcMain.handle('plugins:list', () => listPlugins())
  ipcMain.handle('plugins:pick-path', async (event) => {
    const result = await dialog.showOpenDialog(windowForEvent(event), {
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'Pi extension', extensions: ['ts', 'js', 'mjs', 'cjs', 'json'] }]
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  ipcMain.handle('plugins:install', async (_event, source: string) => {
    if (typeof source !== 'string' || !source.trim()) throw new Error('Plugin source is required')
    await installPlugin(source)
    changed()
    return listPlugins()
  })
  ipcMain.handle('plugins:scopes', async (_event, id: string, scopes: PluginScope[]) => {
    if (typeof id !== 'string') throw new Error('Plugin id is required')
    await setPluginScopes(id, scopes)
    changed()
    await refreshPluginSessions()
    return listPlugins()
  })
  ipcMain.handle('plugins:update', async (_event, id: string) => {
    if (typeof id !== 'string') throw new Error('Plugin id is required')
    if (hasBusyPluginSessions()) throw new Error('Wait for active plugin sessions to finish before updating a package')
    await updatePlugin(id)
    await refreshPluginSessions(true)
    changed()
    return listPlugins()
  })
  ipcMain.handle('plugins:remove', async (_event, id: string) => {
    if (typeof id !== 'string') throw new Error('Plugin id is required')
    if (hasBusyPluginSessions()) throw new Error('Wait for active plugin sessions to finish before removing a package')
    await removePlugin(id)
    changed()
    return listPlugins()
  })
  ipcMain.handle('plugins:memory-enabled', (_event, sessionId: string) => {
    if (typeof sessionId !== 'string') throw new Error('Session id is required')
    return isMemoryPluginEnabled(isChatCwd(sessionCwd(sessionId)) ? 'chat' : 'project')
  })
  ipcMain.handle('plugins:memory-defaults', () => getMemoryPluginDefaults())
  ipcMain.handle('plugins:memory-get', () => getMemoryPluginSettings())
  ipcMain.handle('plugins:memory-set', async (_event, patch: MemoryPluginSettingsPatch) => {
    const settings = await setMemoryPluginSettings(patch)
    await refreshPluginSessions(true)
    changed()
    return settings
  })
  ipcMain.handle('plugins:memory-detail', async (_event, sessionId: string, kind: 'status' | 'view', full?: boolean) => {
    if (typeof sessionId !== 'string' || !['status', 'view'].includes(kind) || (full !== undefined && typeof full !== 'boolean')) {
      throw new Error('Invalid memory detail request')
    }
    if (!(await isMemoryPluginEnabled(isChatCwd(sessionCwd(sessionId)) ? 'chat' : 'project'))) {
      throw new Error('Observational memory is not enabled for this session')
    }
    const entries = (await sessionSourceFor(sessionId)).branch() as Entry[]
    if (kind === 'view') return memoryView(entries, full)
    return memoryStatus(sessionId, entries, getLive(sessionId)?.agentSession.model?.contextWindow, sessionCwd(sessionId))
  })
  ipcMain.handle('plugins:config-get', async (_event, id: string) => {
    if (typeof id !== 'string') throw new Error('Plugin id is required')
    return getPluginSettings(id)
  })
  ipcMain.handle('plugins:config-set', async (_event, id: string, patch: Record<string, string | number | boolean | null>) => {
    if (typeof id !== 'string') throw new Error('Plugin id is required')
    const result = await setPluginSettings(id, patch)
    await refreshPluginSessions(true)
    changed()
    return result
  })
  ipcMain.handle('plugins:web-search-get', () => webSearchSettingsState())
  ipcMain.handle('plugins:web-search-set', async (_event, patch: WebSearchSettingsPatch) => {
    if (!patch || typeof patch !== 'object') throw new Error('Invalid web search settings')
    const state = await patchWebSearchSettings(patch)
    // Provider routing and tool registration are cached when the extension loads.
    await refreshPluginSessions(true)
    changed()
    return state
  })
  ipcMain.handle('plugins:web-search-test', async (_event, provider: string | null) => {
    if (provider !== null && typeof provider !== 'string') throw new Error('Invalid search provider')
    if (provider) assertProviderSelection(provider)
    return testWebSearchProvider(provider)
  })
  ipcMain.handle('system-plugins:review-reply', async (event, id: string, value: string | null) => {
    if (typeof id !== 'string' || (typeof value !== 'string' && value !== null)) {
      throw new Error('Invalid review response')
    }
    replyReviewUI(event.sender, id, value)
  })
}
