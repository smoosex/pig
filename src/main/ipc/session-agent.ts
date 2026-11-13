/** Correlate main-created sessions with the owning UI, rejecting stale windows and late answers. */
import { randomUUID } from 'node:crypto'
import { ipcMain, type BrowserWindow } from 'electron'
import type { SessionAgentUiAnswer, SessionAgentUiRequest } from '../../shared/session-agent'
import { getLive } from '../pi/session-registry'
import { registerSessionController, type SessionUiAction } from '../pi/session-agent'
import { windowForEvent } from './window'
import { requestReply, type PendingReply } from './pending-reply'

export function registerSessionAgentIpc(): void {
  const reloading = new WeakSet<BrowserWindow>()
  const watched = new WeakSet<BrowserWindow>()
  const pending = new Map<string, PendingReply<void> & { win: BrowserWindow; caller: string; owner: NonNullable<ReturnType<typeof getLive>> }>()
  const assertWindow = (win: BrowserWindow) => {
    if (win.isDestroyed() || win.webContents.isDestroyed() || reloading.has(win)) throw new Error('The Pig window is unavailable or reloading')
  }
  const watch = (win: BrowserWindow) => {
    if (watched.has(win)) return
    watched.add(win)
    const cancel = () => {
      reloading.add(win)
      for (const item of pending.values()) if (item.win === win) item.fail(new Error('Pig window was closed or reloaded'))
    }
    win.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) cancel() })
    win.webContents.on('render-process-gone', cancel)
    win.webContents.on('dom-ready', () => reloading.delete(win))
    win.on('closed', cancel)
  }
  const request = async (caller: string, action: SessionUiAction, signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted()
    const owner = getLive(caller)
    const win = owner?.win
    if (!win) throw new Error('Calling session has no window')
    watch(win)
    assertWindow(win)
    await requestReply(pending, { win, caller, owner }, requestId => {
      win.webContents.send('session:agent-request', { ...action, requestId, callerSessionId: caller } satisfies SessionAgentUiRequest)
    }, { signal, timeoutMs: 20_000, timeoutMessage: 'Timed out waiting for the session UI', cancelError: new Error('Session UI request was cancelled') })
  }
  registerSessionController({
    assertWindow: win => { watch(win); assertWindow(win) }, request,
    remove: (win, sessionId) => {
      if (!win.isDestroyed() && !win.webContents.isDestroyed() && !reloading.has(win)) {
        win.webContents.send('session:agent-request', { action: 'remove', sessionId, callerSessionId: '', requestId: randomUUID() } satisfies SessionAgentUiRequest)
      }
    }
  })
  ipcMain.handle('session:agent-answer', (event, requestId: unknown, answer: SessionAgentUiAnswer) => {
    const win = windowForEvent(event)
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Only the owning UI main frame may answer')
    if (typeof requestId !== 'string') throw new Error('Invalid session request ID')
    const item = pending.get(requestId)
    if (!item || item.win !== win) throw new Error('Session UI request expired or belongs to another window')
    try {
      assertWindow(win)
      if (getLive(item.caller) !== item.owner || item.owner?.win !== win) throw new Error('Calling session was closed or replaced')
      if (!answer || typeof answer !== 'object') throw new Error('Invalid session UI answer')
      if ('error' in answer && typeof answer.error === 'string') throw new Error(answer.error.slice(0, 2000))
      if (!('ok' in answer) || answer.ok !== true) throw new Error('Invalid session UI answer')
      item.settle()
    } catch (error) {
      item.fail(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  })
}
