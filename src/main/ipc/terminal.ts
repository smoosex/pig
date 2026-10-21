/** Terminal panes: requests come only from the owning UI main frame; shells live in the PTY host. */
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, ipcMain, utilityProcess, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { t } from '../i18n'
import { TerminalHost, type PtyHostProcess } from '../terminal/host'
import { TerminalAgentController, type TerminalAgentDeps } from '../terminal/agent'
import { registerTerminalAgentHost } from '../plugins/pig-terminal-host'
import type { TerminalAgentOpenAnswer, TerminalAgentOpenRequest } from '../../shared/terminal-agent'
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

export function registerTerminalIpc(sessions?: Pick<TerminalAgentDeps, 'sessionWindow' | 'isSessionLive'>): void {
  const host = terminalHost = new TerminalHost(forkPtyHost, app.getVersion())
  const watched = new WeakSet<BrowserWindow>()
  const reloading = new WeakSet<BrowserWindow>()
  const pendingOpens = new Map<string, { win: BrowserWindow; sessionId: string; settle(result: TerminalAgentOpenAnswer): void; fail(error: unknown): void }>()
  const controller = sessions ? new TerminalAgentController({
    host, ...sessions,
    requestTab: (win, sessionId, signal) => {
      signal?.throwIfAborted()
      if (reloading.has(win) || win.isDestroyed() || win.webContents.isDestroyed()) throw new Error('Terminal UI is reloading')
      watch(win)
      return new Promise((resolve, reject) => {
        const requestId = randomUUID()
        const finish = (settle: () => void) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
          pendingOpens.delete(requestId)
          settle()
        }
        const abort = () => finish(() => reject(signal!.reason))
        const timer = setTimeout(() => finish(() => reject(new Error('The window did not open a terminal in time'))), 15_000)
        signal?.addEventListener('abort', abort, { once: true })
        pendingOpens.set(requestId, {
          win, sessionId,
          settle: result => finish(() => 'error' in result ? reject(new Error(result.error)) : resolve(result.terminalId)),
          fail: error => finish(() => reject(error))
        })
        const request: TerminalAgentOpenRequest = { requestId, sessionId }
        win.webContents.send('terminal:agent-open-request', request)
      })
    },
    changed: (win, state) => { if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('terminal:agent-state', state) }
  }) : undefined
  registerTerminalAgentHost(controller)

  function watch(win: BrowserWindow): void {
    if (watched.has(win)) return
    watched.add(win)
    const clear = () => {
      for (const pending of [...pendingOpens.values()]) if (pending.win === win) pending.fail(new Error('Terminal UI was reloaded or closed'))
      controller?.closeWindow(win)
      host.closeWindow(win)
    }
    win.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) { reloading.add(win); clear() }
    })
    win.webContents.on('render-process-gone', () => { reloading.add(win); clear() })
    win.webContents.on('dom-ready', () => reloading.delete(win))
    win.once('closed', clear)
  }

  function ui(event: IpcMainInvokeEvent, id: unknown): BrowserWindow {
    const win = windowForEvent(event)
    assertBrowserSender(event, win)
    if (reloading.has(win)) throw new Error('Terminal UI is reloading')
    if (typeof id !== 'string' || !TERMINAL_ID_PATTERN.test(id)) throw new Error('Invalid terminal id')
    return win
  }

  ipcMain.handle('terminal:create', (event, id: string, cwd: string | null, cols: number, rows: number) => {
    const win = ui(event, id)
    watch(win)
    return host.create(win, id, directory(cwd), size(cols, TERMINAL_COLS), size(rows, TERMINAL_ROWS))
  })
  ipcMain.handle('terminal:write', (event, id: string, data: string, binary?: boolean) => {
    if (typeof data !== 'string' || data.length > TERMINAL_MAX_WRITE) throw new Error('Invalid terminal input')
    if (binary !== undefined && typeof binary !== 'boolean') throw new Error('Invalid terminal binary flag')
    if (binary && /[^\x00-\xff]/.test(data)) throw new Error('Invalid terminal binary input')
    host.write(ui(event, id), id, data, binary)
  })
  ipcMain.handle('terminal:clear', (event, id: string) => host.clear(ui(event, id), id))
  ipcMain.handle('terminal:resize', (event, id: string, cols: number, rows: number) => {
    host.resize(ui(event, id), id, size(cols, TERMINAL_COLS), size(rows, TERMINAL_ROWS))
  })
  ipcMain.handle('terminal:ack', (event, id: string, length: number) => {
    if (!Number.isInteger(length) || length < 0) throw new Error('Invalid terminal acknowledgement')
    host.ack(ui(event, id), id, length)
  })
  ipcMain.handle('terminal:get-agent-state', (event, id: string) => {
    const win = ui(event, id)
    if (!controller) throw new Error('Terminal Agent tools are unavailable')
    return controller.state(win, id)
  })
  ipcMain.handle('terminal:release-agent', (event, id: string, expectedSessionId: string) => {
    const win = ui(event, id)
    if (typeof expectedSessionId !== 'string' || !expectedSessionId) throw new Error('Invalid terminal session id')
    if (!controller) throw new Error('Terminal Agent tools are unavailable')
    controller.releaseAgent(win, id, expectedSessionId)
  })
  ipcMain.handle('terminal:agent-open-answer', (event, requestId: string, result: TerminalAgentOpenAnswer) => {
    const win = windowForEvent(event)
    assertBrowserSender(event, win)
    const pending = typeof requestId === 'string' ? pendingOpens.get(requestId) : undefined
    if (!pending || pending.win !== win) throw new Error('Unknown terminal open request')
    if (!sessions?.isSessionLive(pending.sessionId) || sessions.sessionWindow(pending.sessionId) !== win) {
      const error = new Error('The requesting session is no longer open')
      pending.fail(error)
      throw error
    } else if (result && typeof result === 'object' && 'error' in result && typeof result.error === 'string') {
      pending.settle({ error: result.error.slice(0, 1000) })
    } else if (result && typeof result === 'object' && 'terminalId' in result && typeof result.terminalId === 'string'
      && host.list(win).some(tab => tab.terminalId === result.terminalId && tab.info.pid > 0 && !tab.exited)) {
      pending.settle({ terminalId: result.terminalId })
    } else {
      pending.fail(new Error('Invalid terminal open answer'))
      throw new Error('Invalid terminal open answer')
    }
  })
  ipcMain.handle('terminal:close', (event, id: string) => {
    const win = ui(event, id)
    host.close(win, id)
    controller?.terminalClosed(win, id)
  })
}
