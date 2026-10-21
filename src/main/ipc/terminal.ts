/** Terminal panes: requests come only from the owning UI main frame; shells live in the PTY host. */
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, ipcMain, utilityProcess, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { t } from '../i18n'
import { TerminalHost, type PtyHostProcess } from '../terminal/host'
import { assertBrowserSender } from '../browser/validation'
import { windowForEvent } from './window'
import { TERMINAL_COLS, TERMINAL_ID_PATTERN, TERMINAL_MAX_WRITE, TERMINAL_ROWS } from '../../shared/terminal'

function forkPtyHost(): PtyHostProcess {
  const child = utilityProcess.fork(fileURLToPath(new URL('./pty-host-worker.js', import.meta.url)), [], {
    serviceName: 'Pig terminal', stdio: 'inherit'
  })
  return child as unknown as PtyHostProcess
}

function size(value: unknown, range: { min: number; max: number }): number {
  if (!Number.isInteger(value) || (value as number) < range.min || (value as number) > range.max) throw new Error('Invalid terminal size')
  return value as number
}

function directory(cwd: unknown): string {
  if (cwd === null) return homedir()
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('Invalid terminal directory')
  let stat
  try {
    stat = statSync(cwd)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(t('terminal.directoryMissing', { path: cwd }))
    throw error
  }
  if (!stat.isDirectory()) throw new Error(t('terminal.directoryMissing', { path: cwd }))
  return cwd
}

let terminalHost: TerminalHost | undefined

export function shutdownTerminals(): Promise<void> {
  return terminalHost ? terminalHost.shutdown() : Promise.resolve()
}

export function registerTerminalIpc(): void {
  const host = terminalHost = new TerminalHost(forkPtyHost, app.getVersion())
  const watched = new WeakSet<BrowserWindow>()

  function ui(event: IpcMainInvokeEvent, id: unknown): BrowserWindow {
    const win = windowForEvent(event)
    assertBrowserSender(event, win)
    if (typeof id !== 'string' || !TERMINAL_ID_PATTERN.test(id)) throw new Error('Invalid terminal id')
    return win
  }

  ipcMain.handle('terminal:create', (event, id: string, cwd: string | null, cols: number, rows: number) => {
    const win = ui(event, id)
    if (!watched.has(win)) {
      watched.add(win)
      // Shells must not outlive the UI document that shows them; React cleanup does not run on reload.
      const clear = () => host.closeWindow(win)
      win.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) clear()
      })
      win.webContents.on('render-process-gone', clear)
      win.once('closed', clear)
    }
    return host.create(win, id, directory(cwd), size(cols, TERMINAL_COLS), size(rows, TERMINAL_ROWS))
  })
  ipcMain.handle('terminal:write', (event, id: string, data: string, binary?: boolean) => {
    if (typeof data !== 'string' || data.length > TERMINAL_MAX_WRITE) throw new Error('Invalid terminal input')
    if (binary !== undefined && typeof binary !== 'boolean') throw new Error('Invalid terminal binary flag')
    if (binary && /[^\x00-\xff]/.test(data)) throw new Error('Invalid terminal binary input')
    host.write(ui(event, id), id, data, binary)
  })
  ipcMain.handle('terminal:resize', (event, id: string, cols: number, rows: number) => {
    host.resize(ui(event, id), id, size(cols, TERMINAL_COLS), size(rows, TERMINAL_ROWS))
  })
  ipcMain.handle('terminal:ack', (event, id: string, length: number) => {
    if (!Number.isInteger(length) || length < 0) throw new Error('Invalid terminal acknowledgement')
    host.ack(ui(event, id), id, length)
  })
  ipcMain.handle('terminal:close', (event, id: string) => host.close(ui(event, id), id))
}
