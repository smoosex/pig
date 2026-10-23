/** Background process snapshots for the composer's status button; only a UI main frame may stop or remove. */
import { homedir } from 'node:os'
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { BackgroundProcessUpdate } from '../../shared/processes'
import { assertBrowserSender } from '../browser/validation'
import { isChatCwd } from '../chats'
import { getLive } from '../pi/session-registry'
import { backgroundProcesses, registerBackgroundProcesses } from '../processes'
import { windowForEvent } from './window'

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
