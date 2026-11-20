/**
 * IPC boundary for Pig Bot. All endpoints verify the owning Pig UI main frame so guest
 * browser views or untrusted subframes can never invoke Bot controls or read Bot state.
 */
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ThinkingLevel } from '../../shared/api'
import type { PermissionMode } from '../../shared/permissions'
import type { BotEvent, BotImageAttachment, BotSurface, BotTextAttachment } from '../../shared/bot'
import { assertBrowserSender } from '../browser/validation'
import { windowForEvent } from './window'
import { botService } from '../bot/service'

const VALID_SURFACES = new Set<BotSurface>(['workspace', 'bot'])
const VALID_MODES = new Set<PermissionMode>(['read-only', 'default', 'full-access'])
const VALID_THINKING = new Set<ThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function assertUiMainFrame(event: IpcMainInvokeEvent): BrowserWindow {
  const win = windowForEvent(event)
  assertBrowserSender(event, win)
  return win
}

function broadcastBotEvent(event: BotEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('bot:event', event)
    }
  }
}

export function registerBotIpc(): void {
  let subscribed = false
  const ensureSubscribed = () => {
    if (subscribed) return
    subscribed = true
    botService().subscribe(broadcastBotEvent)
  }

  ipcMain.handle('bot:snapshot', async (event) => {
    assertUiMainFrame(event)
    ensureSubscribed()
    return botService().getSnapshot()
  })

  ipcMain.handle('bot:set-surface', async (event, surface: unknown) => {
    assertUiMainFrame(event)
    ensureSubscribed()
    if (typeof surface !== 'string' || !VALID_SURFACES.has(surface as BotSurface)) {
      throw new Error('Invalid bot surface')
    }
    return botService().setSurface(surface as BotSurface)
  })

  ipcMain.handle('bot:send', async (event, input: unknown) => {
    assertUiMainFrame(event)
    ensureSubscribed()
    if (!input || typeof input !== 'object') throw new Error('Invalid bot message payload')
    const payload = input as {
      text?: unknown
      images?: BotImageAttachment[]
      textAttachments?: BotTextAttachment[]
      projectMentions?: string[]
    }
    if (typeof payload.text !== 'string') throw new Error('Message text must be a string')
    return botService().sendMessage({
      text: payload.text,
      images: Array.isArray(payload.images) ? payload.images : undefined,
      textAttachments: Array.isArray(payload.textAttachments) ? payload.textAttachments : undefined,
      projectMentions: Array.isArray(payload.projectMentions)
        ? payload.projectMentions.filter((item): item is string => typeof item === 'string')
        : undefined
    })
  })

  ipcMain.handle('bot:retry-last', async (event) => {
    assertUiMainFrame(event)
    ensureSubscribed()
    return botService().retryLastMessage()
  })

  ipcMain.handle('bot:abort', async (event) => {
    assertUiMainFrame(event)
    ensureSubscribed()
    await botService().abortCurrentTurn()
  })

  ipcMain.handle('bot:set-permission', async (event, mode: unknown) => {
    assertUiMainFrame(event)
    ensureSubscribed()
    if (typeof mode !== 'string' || !VALID_MODES.has(mode as PermissionMode)) {
      throw new Error('Invalid permission mode')
    }
    return botService().setPermissionMode(mode as PermissionMode)
  })

  ipcMain.handle('bot:set-model', async (event, provider: unknown, id: unknown) => {
    assertUiMainFrame(event)
    ensureSubscribed()
    if (typeof provider !== 'string' || !provider || typeof id !== 'string' || !id) {
      throw new Error('Model provider and id are required')
    }
    return botService().setModel(provider, id)
  })

  ipcMain.handle('bot:set-thinking', async (event, level: unknown) => {
    assertUiMainFrame(event)
    ensureSubscribed()
    if (typeof level !== 'string' || !VALID_THINKING.has(level as ThinkingLevel)) {
      throw new Error('Invalid thinking level')
    }
    return botService().setThinking(level as ThinkingLevel)
  })

  ipcMain.handle('bot:reset-context', async (event) => {
    assertUiMainFrame(event)
    ensureSubscribed()
    return botService().resetContext()
  })

  ipcMain.handle('bot:list-tasks', async (event, filter?: unknown) => {
    assertUiMainFrame(event)
    ensureSubscribed()
    const status = filter && typeof filter === 'object' && 'status' in filter && typeof (filter as { status?: unknown }).status === 'string'
      ? (filter as { status: 'active' | 'all' | 'completed' | 'failed' | 'stopped' }).status
      : undefined
    return botService().listTasks(status ? { status } : undefined)
  })

  ipcMain.handle('bot:get-task', async (event, taskId: unknown) => {
    assertUiMainFrame(event)
    ensureSubscribed()
    if (typeof taskId !== 'string' || !taskId) throw new Error('Task id is required')
    return botService().getTask(taskId)
  })

  ipcMain.handle('bot:stop-task', async (event, taskId: unknown) => {
    assertUiMainFrame(event)
    ensureSubscribed()
    if (typeof taskId !== 'string' || !taskId) throw new Error('Task id is required')
    return botService().stopTask(taskId)
  })

  ipcMain.handle('bot:takeover-task', async (event, taskId: unknown) => {
    assertUiMainFrame(event)
    ensureSubscribed()
    if (typeof taskId !== 'string' || !taskId) throw new Error('Task id is required')
    return botService().takeOverTask(taskId)
  })

  ipcMain.handle('bot:followup-task', async (event, taskId: unknown, instruction: unknown) => {
    assertUiMainFrame(event)
    ensureSubscribed()
    if (typeof taskId !== 'string' || !taskId || typeof instruction !== 'string' || !instruction.trim()) {
      throw new Error('Task id and instruction are required')
    }
    return botService().followupTask(taskId, instruction.trim())
  })

  ipcMain.handle('bot:check-worktree-cleanup', async (event, taskId: unknown) => {
    assertUiMainFrame(event)
    ensureSubscribed()
    if (typeof taskId !== 'string' || !taskId) throw new Error('Task id is required')
    return botService().checkWorktreeCleanupSafety(taskId)
  })

  ipcMain.handle('bot:cleanup-worktree', async (event, taskId: unknown, confirmation?: unknown) => {
    assertUiMainFrame(event)
    ensureSubscribed()
    if (typeof taskId !== 'string' || !taskId) throw new Error('Task id is required')
    if (confirmation !== undefined && (typeof confirmation !== 'string' || !/^[a-f0-9]{64}$/.test(confirmation))) {
      throw new Error('Invalid worktree confirmation snapshot')
    }
    return botService().cleanupWorktree(taskId, confirmation)
  })

  ipcMain.handle('bot:managed-session', async (event, sessionId: unknown) => {
    assertUiMainFrame(event)
    ensureSubscribed()
    if (typeof sessionId !== 'string' || !sessionId) return null
    return botService().getManagedSessionInfo(sessionId)
  })
}
