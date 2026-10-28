/** Background process snapshots for the composer's status button; only a UI main frame may stop or remove. */
import { homedir } from 'node:os'
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { BackgroundProcessUpdate } from '../../shared/processes'
import { assertBrowserSender } from '../browser/validation'
import { isChatCwd } from '../chats'
import { getLive } from '../pi/session-registry'
import { backgroundProcesses, registerBackgroundProcesses } from '../processes'
import { windowForEvent } from './window'
import { sessionPermission } from '../permissions/store'
import { ensureSandbox, sandboxCommand, sessionWorkspace } from '../sandbox/service'
import { createExtensionUI } from '../extension-ui'
import { t } from '../i18n'
import { approve, offerHosts } from '../permissions/approval'

// Output can arrive continuously; one snapshot per session per interval is enough for a glance.
const PUBLISH_INTERVAL_MS = 250

function ids(event: IpcMainInvokeEvent, ...values: unknown[]): string[] {
  assertBrowserSender(event, windowForEvent(event))
  if (values.some((value) => typeof value !== 'string' || !value)) throw new Error('Invalid background process request')
  return values as string[]
}

export function registerProcessIpc(): void {
  const scheduled = new Map<string, ReturnType<typeof setTimeout>>()
  const publish = (sessionId: string) => {
    scheduled.delete(sessionId)
    const update: BackgroundProcessUpdate = { sessionId, processes: backgroundProcesses().snapshot(sessionId) }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('processes:changed', update)
    }
  }
  registerBackgroundProcesses({
    sessionDirectory: (id) => {
      const cwd = getLive(id)?.cwd
      // Chat's working directory is an empty scratch folder; processes start in Home like its terminals.
      return cwd === undefined ? undefined : isChatCwd(cwd) ? homedir() : cwd
    },
    sandbox: async (sessionId, command, shell, signal) => {
      const live = getLive(sessionId)
      if (!live) throw new Error('This session is no longer open')
      const { mode } = sessionPermission(sessionId)
      signal?.throwIfAborted()
      if (mode === 'full-access') return null
      const sandbox = await ensureSandbox()
      if (sandbox.state !== 'ready') {
        if (mode === 'read-only') throw new Error('Read-only mode needs the sandbox, which is unavailable')
        if (!live.win || live.win.isDestroyed()) throw new Error('No window is available to approve this process')
        const ui = await createExtensionUI(live.win, sessionId)
        await approve(ui, sessionId, ['no-sandbox'], t('permissions.noSandboxTitle'), t('permissions.noSandboxMessage', { command, detail: sandbox.detail ?? t('permissions.unsupported') }), signal)
        return null
      }
      return sandboxCommand(command, { shell, mode, workspace: await sessionWorkspace(live.cwd), sessionId, signal })
    },
    networkPermission: async (sessionId, hosts, signal) => {
      const live = getLive(sessionId)
      if (!live || !live.win || live.win.isDestroyed()) return offerHosts(undefined, sessionId, hosts, null, signal)
      const ui = await createExtensionUI(live.win, sessionId, 'process')
      const workspace = await sessionWorkspace(live.cwd)
      signal.throwIfAborted()
      return offerHosts(ui, sessionId, hosts, workspace.gitCommonDir, signal)
    },
    changed: (sessionId) => {
      if (!scheduled.has(sessionId)) scheduled.set(sessionId, setTimeout(() => publish(sessionId), PUBLISH_INTERVAL_MS))
    }
  })
  ipcMain.handle('processes:list', (event, sessionId: unknown) => {
    const [id] = ids(event, sessionId)
    return backgroundProcesses().snapshot(id!)
  })
  ipcMain.handle('processes:stop', async (event, sessionId: unknown, processId: unknown) => {
    const [session, proc] = ids(event, sessionId, processId)
    await backgroundProcesses().stopByUser(session!, proc!)
  })
  ipcMain.handle('processes:remove', (event, sessionId: unknown, processId: unknown) => {
    const [session, proc] = ids(event, sessionId, processId)
    backgroundProcesses().remove(session!, proc!)
  })
}
