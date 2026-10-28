/* Permission modes and allowed hosts; only a window's UI main frame may change them. */
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { isMcpApproval, isPermissionDomain, isPermissionMode, type PermissionsSnapshot } from '../../shared/permissions'
import { assertBrowserSender } from '../browser/validation'
import {
  onPermissionsChanged, readPermissionSettings, saveSessionPermission, sessionPermission, updatePermissionSettings
} from '../permissions/store'
import { ensureSandbox, refreshSandboxHosts } from '../sandbox/service'
import { windowForEvent } from './window'

function assertUi(event: IpcMainInvokeEvent): void {
  assertBrowserSender(event, windowForEvent(event))
}

function sessionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w-]+$/.test(value)) throw new Error('Invalid session id')
  return value
}

async function snapshot(): Promise<PermissionsSnapshot> {
  return { ...readPermissionSettings(), sandbox: await ensureSandbox() }
}

export function registerPermissionsIpc(): void {
  onPermissionsChanged(() => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('permissions:changed')
    }
  })
  ipcMain.handle('permissions:get', (event) => {
    assertUi(event)
    return snapshot()
  })
  ipcMain.handle('permissions:set-default-mode', async (event, mode: unknown) => {
    assertUi(event)
    if (!isPermissionMode(mode)) throw new Error('Invalid permission mode')
    await updatePermissionSettings((current) => ({ ...current, defaultMode: mode }))
    return snapshot()
  })
  ipcMain.handle('permissions:remove-domain', async (event, project: unknown, domain: unknown) => {
    assertUi(event)
    if ((project !== null && typeof project !== 'string') || !isPermissionDomain(domain)) throw new Error('Invalid permission host')
    await updatePermissionSettings((current) => project === null
      ? { ...current, domains: current.domains.filter((entry) => entry !== domain) }
      : { ...current, projects: current.projects.map((entry) => entry.root === project ? { ...entry, domains: entry.domains.filter((host) => host !== domain) } : entry) })
    // Project hosts apply per command, so only the global list is live in the proxy.
    if (project === null) refreshSandboxHosts()
    return snapshot()
  })
  ipcMain.handle('permissions:set-mcp-approval', async (event, server: unknown, approval: unknown) => {
    assertUi(event)
    if (typeof server !== 'string' || !server || !isMcpApproval(approval)) throw new Error('Invalid MCP approval')
    await updatePermissionSettings((current) => {
      const { [server]: _previous, ...rest } = current.mcp
      return { ...current, mcp: approval === 'auto' ? rest : { ...rest, [server]: approval } }
    })
    return snapshot()
  })
  ipcMain.handle('permissions:get-session', (event, id: unknown) => {
    assertUi(event)
    return sessionPermission(sessionId(id))
  })
  ipcMain.handle('permissions:set-session', async (event, id: unknown, mode: unknown) => {
    assertUi(event)
    if (mode !== null && !isPermissionMode(mode)) throw new Error('Invalid permission mode')
    await saveSessionPermission(sessionId(id), mode)
    return sessionPermission(sessionId(id))
  })
}
