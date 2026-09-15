import { dialog, ipcMain } from 'electron'
import {
  closeSession,
  createPendingSession,
  exportSession,
  getSessionControls,
  getSessionTokenStats,
  isPendingDraft,
  getSessionTree,
  listSessionCommands,
  openSession,
  prepareSession,
  refreshSessionModels,
  setSessionModel,
  setSessionThinking,
  updateFollowUpMessage,
  viewSessionBranch,
  type SessionThinkingLevel
} from '../pi/session-registry'
import { getDisplayTurns, getTurnMessages, getTurnWindow } from '../pi/session-display'
import { removeSessionFile } from '../pi/session-loader'
import { isChatCwd, isChatsRoot } from '../chats'
import { promptSession } from '../pi/session-prompt'
import { windowForEvent } from './window'

export function registerSessionIpc(): void {
  ipcMain.handle('session:create', async (event, cwd: string) => {
    const win = windowForEvent(event)
    if (isChatCwd(cwd) || isChatsRoot(cwd)) {
      throw new Error('Chat directories allow only one session')
    }
    const session = createPendingSession(cwd, win)
    return { sessionId: session.sessionId, cwd: session.cwd }
  })

  ipcMain.handle('session:open', async (event, path: string) => {
    const win = windowForEvent(event)
    return openSession(path, win)
  })

  ipcMain.handle('session:prepare', async (_event, sessionId: string) => {
    const created = isPendingDraft(sessionId)
    const session = await prepareSession(sessionId)
    return { sessionId: session.sessionId, cwd: session.cwd, created }
  })

  ipcMain.handle('session:close', async (_event, sessionId: string) => {
    await closeSession(sessionId)
  })

  ipcMain.handle(
    'session:delete',
    async (_event, sessionId: string, path: string, cwd: string) => {
      if (!sessionId || !path || !cwd) throw new Error('Session id, path, and cwd are required')
      await closeSession(sessionId)
      await removeSessionFile(path)
    }
  )

  ipcMain.handle(
    'session:prompt',
    async (_event, sessionId: string, text: unknown, images?: unknown, textAttachments?: unknown, streamingBehavior?: unknown) => {
      await promptSession(sessionId, { text, images, textAttachments, streamingBehavior })
    }
  )

  ipcMain.handle('session:abort', async (_event, sessionId: string) => {
    const ls = await prepareSession(sessionId)
    await ls.agentSession.abort()
  })

  ipcMain.handle('session:get-display-turns', async (_event, sessionId: string) => {
    return getDisplayTurns(sessionId)
  })

  ipcMain.handle(
    'session:get-turn-window',
    async (_event, sessionId: string, start: number, count: number) => {
      return getTurnWindow(sessionId, start, count)
    }
  )

  ipcMain.handle('session:get-turn-messages', async (_event, sessionId: string, turnId: string) => {
    if (!sessionId || !turnId) throw new Error('Session id and turn id are required')
    return getTurnMessages(sessionId, turnId)
  })

  ipcMain.handle('session:get-tree', async (_event, sessionId: string) => {
    return getSessionTree(sessionId)
  })

  ipcMain.handle('session:view-branch', async (_event, sessionId: string, tipId: string) => {
    if (!sessionId || !tipId) throw new Error('Session id and tip id are required')
    await viewSessionBranch(sessionId, tipId)
    return getDisplayTurns(sessionId)
  })

  ipcMain.handle('session:get-controls', async (_event, sessionId: string) => {
    return getSessionControls(sessionId)
  })

  ipcMain.handle('session:get-token-stats', async (_event, sessionId: string) => {
    if (!sessionId) throw new Error('Session id is required')
    return getSessionTokenStats(sessionId)
  })

  ipcMain.handle('session:get-commands', async (_event, sessionId: string) => {
    if (!sessionId) throw new Error('Session id is required')
    return listSessionCommands(sessionId)
  })

  ipcMain.handle(
    'session:export',
    async (event, sessionId: string, outputPath?: string) => {
      if (!sessionId) throw new Error('Session id is required')
      let target = typeof outputPath === 'string' ? outputPath.trim() : ''
      if (!target) {
        const win = windowForEvent(event)
        const result = await dialog.showSaveDialog(win, {
          title: '导出会话',
          defaultPath: 'session.html',
          filters: [
            { name: 'HTML', extensions: ['html'] },
            { name: 'JSONL', extensions: ['jsonl'] }
          ]
        })
        if (result.canceled || !result.filePath) return null
        target = result.filePath
      }
      return { path: await exportSession(sessionId, target) }
    }
  )

  ipcMain.handle(
    'session:set-model',
    async (_event, sessionId: string, provider: string, id: string) => {
      return setSessionModel(sessionId, provider, id)
    }
  )

  ipcMain.handle(
    'session:set-thinking',
    async (_event, sessionId: string, level: SessionThinkingLevel) => {
      return setSessionThinking(sessionId, level)
    }
  )

  ipcMain.handle('session:refresh-models', async (_event, sessionId: string) => {
    return refreshSessionModels(sessionId)
  })

  ipcMain.handle(
    'session:follow-up-action',
    async (_event, sessionId: string, index: number, action: 'steer' | 'edit' | 'dismiss') => {
      return updateFollowUpMessage(sessionId, index, action)
    }
  )
}
