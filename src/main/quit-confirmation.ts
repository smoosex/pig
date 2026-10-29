/**
 * Asks before a quit would stop running sessions, background subagents or background processes.
 *
 * The prompt is the renderer's own dialog: a window becomes eligible once its UI subscribes, and
 * stops being so when it closes, crashes or reloads (an unanswered prompt there counts as cancel).
 * The native message box stands in only when no window can show it: none comes up in time, the
 * renderer is gone, or it does not acknowledge the prompt promptly.
 *
 * Once the user confirms, the answer holds for the rest of the process: the quit that follows (or the
 * last-window close that leads to it on Windows/Linux) must not ask again. A cancelled prompt leaves
 * nothing behind, so the next attempt checks afresh.
 */
import { randomUUID } from 'node:crypto'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { t } from './i18n'
import { runningSessionCount } from './pi/session-registry'
import { manager as subagents } from './subagents/service'
import { runningProcessCount } from './processes'
import { windowForEvent } from './ipc/window'
import { assertBrowserSender } from './browser/validation'
import { isLive, UiWindowTracker } from './ui-window-tracker'
import { describeQuitActivity, type QuitActivity, type QuitConfirmRequest } from '../shared/quit'

const READY_TIMEOUT_MS = 10_000
const ACK_TIMEOUT_MS = 3_000

interface PendingPrompt {
  win: BrowserWindow
  acked: boolean
  /** `undefined` means the UI never showed the prompt, so the native box has to ask instead. */
  settle: (answer: boolean | undefined) => void
}

const pending = new Map<string, PendingPrompt>()
const readyWaiters = new Set<() => void>()
// Before its ack nobody saw the prompt, so a lost window falls back; after it, closing reads as cancel.
const windows = new UiWindowTracker((win) => {
  for (const prompt of [...pending.values()]) if (prompt.win === win) prompt.settle(prompt.acked ? false : undefined)
})
let confirmed = false
let asking: Promise<boolean> | undefined

function quitActivity(): QuitActivity {
  return { sessions: runningSessionCount(), subagents: subagents.runningBackgroundCount(), processes: runningProcessCount() }
}

function hasActivity(activity: QuitActivity): boolean {
  return activity.sessions + activity.subagents + activity.processes > 0
}

export function needsQuitConfirmation(): boolean {
  return !confirmed && hasActivity(quitActivity())
}

function senderWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow {
  const win = windowForEvent(event)
  assertBrowserSender(event, win)
  return win
}

export function registerQuitConfirmIpc(): void {
  ipcMain.handle('quit:listen', (event) => {
    windows.add(senderWindow(event))
    for (const wake of [...readyWaiters]) wake()
  })
  ipcMain.handle('quit:unlisten', (event) => windows.remove(senderWindow(event)))
  ipcMain.handle('quit:ack', (event, requestId: unknown) => {
    const win = senderWindow(event)
    if (typeof requestId !== 'string') throw new Error('Invalid quit confirmation ack')
    const prompt = pending.get(requestId)
    if (prompt?.win === win) prompt.acked = true
  })
  ipcMain.handle('quit:reply', (event, requestId: unknown, answer: unknown) => {
    const win = senderWindow(event)
    if (typeof requestId !== 'string' || typeof answer !== 'boolean') throw new Error('Invalid quit confirmation reply')
    const prompt = pending.get(requestId)
    if (prompt?.win === win) prompt.settle(answer)
  })
}

function readyWindow(preferred?: BrowserWindow): BrowserWindow | undefined {
  const candidates = [preferred, BrowserWindow.getFocusedWindow() ?? undefined, ...windows.windows()]
  return candidates.find((win): win is BrowserWindow => !!win && windows.has(win))
}

/**
 * macOS keeps running with no window, so one is opened for the prompt. Otherwise only a window still
 * loading its UI can subscribe soon; a crashed renderer never will, and waiting on it would stall the quit.
 */
async function windowForPrompt(preferred: BrowserWindow | undefined, openWindow: () => void): Promise<BrowserWindow | undefined> {
  const existing = readyWindow(preferred)
  if (existing) return existing
  const live = BrowserWindow.getAllWindows().filter(isLive)
  if (!live.length) openWindow()
  else if (!live.some((win) => win.webContents.isLoading())) return undefined
  return new Promise((resolve) => {
    const finish = () => {
      const win = readyWindow(preferred)
      if (!win) return
      cleanup()
      resolve(win)
    }
    const timer = setTimeout(() => { cleanup(); resolve(undefined) }, READY_TIMEOUT_MS)
    const cleanup = () => { clearTimeout(timer); readyWaiters.delete(finish) }
    readyWaiters.add(finish)
  })
}

/**
 * Only the shown-ack is timed: a renderer stuck in a long task must not hold the quit hostage. The
 * user's answer itself is never timed out.
 */
function askInWindow(win: BrowserWindow, activity: QuitActivity): Promise<boolean | undefined> {
  const requestId = randomUUID()
  return new Promise((resolve) => {
    const prompt: PendingPrompt = {
      win,
      acked: false,
      settle: (answer) => {
        if (!pending.delete(requestId)) return
        clearTimeout(timer)
        resolve(answer)
      }
    }
    const timer = setTimeout(() => {
      if (prompt.acked) return
      prompt.settle(undefined)
      send(win, { type: 'dismiss', requestId })
    }, ACK_TIMEOUT_MS)
    pending.set(requestId, prompt)
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    send(win, { type: 'ask', requestId, activity })
  })
}

function send(win: BrowserWindow, request: QuitConfirmRequest): void {
  if (isLive(win)) win.webContents.send('quit:confirm', request)
}

async function askNatively(activity: QuitActivity): Promise<boolean> {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    message: t('quit.title'),
    detail: describeQuitActivity(activity, t),
    buttons: [t('quit.confirm'), t('common.cancel')],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  })
  return response === 0
}

async function ask(preferred: BrowserWindow | undefined, openWindow: () => void): Promise<boolean> {
  if (!hasActivity(quitActivity())) return true
  const win = await windowForPrompt(preferred, openWindow)
  // Waiting for a window may have outlasted the work.
  const activity = quitActivity()
  if (!hasActivity(activity)) return true
  const answer = win ? await askInWindow(win, activity) : undefined
  confirmed = answer ?? await askNatively(activity)
  return confirmed
}

/** Concurrent quit requests share one prompt instead of stacking dialogs. */
export function confirmQuit(openWindow: () => void, preferred?: BrowserWindow): Promise<boolean> {
  asking ??= ask(preferred, openWindow).finally(() => { asking = undefined })
  return asking
}
