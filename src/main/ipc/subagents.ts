import { BrowserWindow, ipcMain } from 'electron'
import type { SubagentSettingsPatch } from '../../shared/api'
import { manager, setSubagentPublisher, setSubagentErrorPublisher, setSubagentParentSession, startSubagents } from '../subagents/service'
import { readSubagentSettings, writeSubagentSettings } from '../subagents/settings'

function assertIds(...values: unknown[]): void {
  if (values.some((value) => typeof value !== 'string' || !value)) throw new Error('Invalid subagent request')
}

export function registerSubagentIpc(parentSession: (sessionId: string) => { win?: BrowserWindow } | undefined): void {
  setSubagentParentSession(parentSession)
  setSubagentErrorPublisher((sessionId, error) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue
      win.webContents.send('system-plugins:ui', {
        kind: 'notify', sessionId, plugin: 'host', level: 'error',
        message: error instanceof Error ? error.message : String(error)
      })
    }
  })
  startSubagents()
  setSubagentPublisher((updates) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue
      for (const update of updates) win.webContents.send('subagents:changed', update)
    }
  })
  ipcMain.handle('subagents:list', (_event, parentSessionId: string) => {
    assertIds(parentSessionId)
    return manager.list(parentSessionId)
  })
  ipcMain.handle('subagents:abort', (_event, parentSessionId: string, id: string) => {
    assertIds(parentSessionId, id)
    manager.abort(parentSessionId, id)
  })
  ipcMain.handle('subagents:abort-all', (_event, parentSessionId: string) => {
    assertIds(parentSessionId)
    manager.abortAll(parentSessionId)
  })
  ipcMain.handle('subagents:clear-finished', (_event, parentSessionId: string) => {
    assertIds(parentSessionId)
    return manager.clearFinished(parentSessionId)
  })
  ipcMain.handle('subagents:transcript', (_event, parentSessionId: string, id: string) => {
    assertIds(parentSessionId, id)
    return manager.transcript(parentSessionId, id)
  })
  ipcMain.handle('subagents:settings-get', () => readSubagentSettings())
  ipcMain.handle('subagents:settings-set', (_event, patch: SubagentSettingsPatch) => writeSubagentSettings(patch))
}
