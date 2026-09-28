import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { MemoryPluginSettingsPatch } from '../../shared/api'
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
  setPluginEnabled,
  setPluginSettings,
  updatePlugin
} from '../pi/plugins'
import { getLive, hasBusyPluginSessions, refreshPluginSessions, sessionCwd, sessionSourceFor } from '../pi/session-registry'
import { isChatCwd } from '../chats'
import { memoryStatus, memoryView } from '../plugins/observational-memory/details'
import type { Entry } from '../plugins/observational-memory/session-ledger'
import { replyPluginUI } from '../pi/plugin-ui'

function changed(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('plugins:changed')
  }
}

export function registerPluginIpc(): void {
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
  ipcMain.handle('plugins:enable', async (_event, id: string, enabled: boolean) => {
    if (typeof id !== 'string' || typeof enabled !== 'boolean') throw new Error('Invalid plugin change')
    await setPluginEnabled(id, enabled)
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
  ipcMain.handle('plugins:memory-enabled', () => isMemoryPluginEnabled())
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
    if (isChatCwd(sessionCwd(sessionId)) || !(await isMemoryPluginEnabled())) {
      throw new Error('Observational memory is not enabled for this session')
    }
    const entries = (await sessionSourceFor(sessionId)).branch() as Entry[]
    if (kind === 'view') return memoryView(entries, full)
    return memoryStatus(sessionId, entries, getLive(sessionId)?.agentSession.model?.contextWindow)
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
  ipcMain.handle('plugins:ui-reply', async (event, id: string, value: string | boolean | null) => {
    if (typeof id !== 'string' || (typeof value !== 'string' && typeof value !== 'boolean' && value !== null)) {
      throw new Error('Invalid plugin UI response')
    }
    replyPluginUI(event.sender, id, value)
  })
}
