import { dialog, ipcMain } from 'electron'
import { t } from '../i18n'
import {
  activateSession,
  closeSession,
  createPendingSession,
  discardDraftSession,
  exportSession,
  forkSessionFromMessage,
  getSessionControls,
  getSessionTokenStats,
  getSessionTrees,
  listSessionCommands,
  openSession,
  prepareSession,
  promoteDraftSession,
  refreshSessionModels,
  renameSession,
  setSessionLabel,
  setSessionModel,
  setSessionThinking,
  updateFollowUpMessage,
  viewSessionBranch,
  type SessionThinkingLevel,
  type SessionTreeView
} from '../pi/session-registry'
import { getDisplayTurns, getTurnMessages, getTurnWindow } from '../pi/session-display'
import { removeSessionFile } from '../pi/session-loader'
import { isChatCwd, isChatsRoot } from '../chats'
import { forgetOpenProjectSession, rememberOpenProjectSession } from '../open-project-sessions'
import { promptSession } from '../pi/session-prompt'
import { windowForEvent } from './window'

/** One window request never reads more than this, however the caller phrases it. */
const MAX_WINDOW_TURNS = 200

export function registerSessionIpc(): void {
  ipcMain.handle('session:create', async (event, cwd: string, sessionId?: string) => {
    const win = windowForEvent(event)
    if (isChatCwd(cwd) || isChatsRoot(cwd)) {
      throw new Error('Chat directories allow only one session')
    }
    const session = createPendingSession(cwd, win, { id: sessionId })
    return { sessionId: session.sessionId, cwd: session.cwd }
  })

  ipcMain.handle('session:promote', async (_event, sessionId: string) => {
    const cwd = promoteDraftSession(sessionId)
    void rememberOpenProjectSession(cwd, sessionId).catch((error) => {
      console.error('Failed to remember open session:', error)
    })
  })

  ipcMain.handle('session:discard-draft', async (_event, sessionId: string) => {
    await discardDraftSession(sessionId)
  })

  ipcMain.handle('session:open', async (event, path: string) => {
    const win = windowForEvent(event)
    const session = await openSession(path, win)
    if (!isChatCwd(session.cwd)) {
      void rememberOpenProjectSession(session.cwd, session.sessionId).catch((error) => {
        console.error('Failed to remember open session:', error)
      })
    }
    return session
  })

  ipcMain.handle('session:prepare', async (_event, sessionId: string) => {
    const { session, created } = await activateSession(sessionId)
    return { sessionId: session.sessionId, cwd: session.cwd, created }
  })

  ipcMain.handle('session:close', async (_event, sessionId: string) => {
    await closeSession(sessionId)
    await forgetOpenProjectSession(sessionId)
  })

  ipcMain.handle(
    'session:delete',
    async (_event, sessionId: string, path: string, cwd: string) => {
      if (!sessionId || !path || !cwd) throw new Error('Session id, path, and cwd are required')
      await closeSession(sessionId)
      await removeSessionFile(path)
      await forgetOpenProjectSession(sessionId)
    }
  )

  ipcMain.handle(
    'session:rename',
    async (_event, sessionId: string, name: string, path?: string) => {
      if (!sessionId || typeof name !== 'string') throw new Error('Session id and name are required')
      await renameSession(sessionId, name, typeof path === 'string' ? path : undefined)
    }
  )

  ipcMain.handle(
    'session:set-label',
    async (_event, sessionId: string, targetId: string, label: string, path?: string) => {
      if (
        typeof sessionId !== 'string' ||
        !sessionId ||
        typeof targetId !== 'string' ||
        typeof label !== 'string'
      ) {
        throw new Error('Session id, target id and label are required')
      }
      await setSessionLabel(sessionId, targetId, label, typeof path === 'string' ? path : undefined)
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

  ipcMain.handle('session:execute-bash', async (_event, sessionId: string, command: string, id: string) => {
    if (!sessionId || typeof command !== 'string' || !command.trim() || typeof id !== 'string' || !id) {
      throw new Error('Session id, command and execution id are required')
    }
    const { agentSession } = (await activateSession(sessionId)).session
    if (agentSession.isStreaming || agentSession.isBashRunning) throw new Error('Session is busy')
    return agentSession.executeBash(command, undefined, { id })
  })

  ipcMain.handle('session:abort-bash', async (_event, sessionId: string) => {
    if (!sessionId) throw new Error('Session id is required')
    const { agentSession } = await prepareSession(sessionId)
    agentSession.abortBash()
  })

  ipcMain.handle('session:abort-compaction', async (_event, sessionId: string) => {
    if (!sessionId) throw new Error('Session id is required')
    const { agentSession } = await prepareSession(sessionId)
    agentSession.abortCompaction()
  })

  ipcMain.handle('session:compact', async (_event, sessionId: string, instructions?: unknown) => {
    if (!sessionId) throw new Error('Session id is required')
    const { agentSession } = await prepareSession(sessionId)
    const customInstructions = typeof instructions === 'string' ? instructions.trim() : ''
    // `compaction_end` carries the message the user needs, and the CLI drops this rejection the same way.
    await agentSession.compact(customInstructions || undefined).catch(() => {})
  })

  ipcMain.handle('session:get-display-turns', async (_event, sessionId: string) => {
    return getDisplayTurns(sessionId)
  })

  ipcMain.handle(
    'session:get-turn-window',
    async (_event, sessionId: string, start: number, count: number) => {
      if (!Number.isInteger(start) || start < 0) throw new Error('Turn window start must be a non-negative integer')
      if (!Number.isFinite(count)) throw new Error('Turn window count must be a number')
      return getTurnWindow(sessionId, start, Math.min(Math.max(1, Math.trunc(count)), MAX_WINDOW_TURNS))
    }
  )

  ipcMain.handle('session:get-turn-messages', async (_event, sessionId: string, turnId: string) => {
    if (!sessionId || !turnId) throw new Error('Session id and turn id are required')
    return getTurnMessages(sessionId, turnId)
  })

  ipcMain.handle('session:get-trees', async (_event, sessionId: string, views?: SessionTreeView[]) => {
    return getSessionTrees(sessionId, views)
  })

  ipcMain.handle('session:view-branch', async (_event, sessionId: string, tipId: string, options?: Parameters<typeof viewSessionBranch>[2]) => {
    if (!sessionId || !tipId) throw new Error('Session id and tip id are required')
    const branch = await viewSessionBranch(sessionId, tipId, options)
    return { ...await getDisplayTurns(sessionId), ...branch }
  })

  ipcMain.handle('session:fork', async (event, sessionId: string, userEntryId: string) => {
    if (!sessionId || !userEntryId) throw new Error('Session id and user entry id are required')
    const forked = await forkSessionFromMessage(sessionId, userEntryId, windowForEvent(event))
    if (forked && !isChatCwd(forked.cwd)) {
      await rememberOpenProjectSession(forked.cwd, forked.sessionId)
    }
    return forked
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

  ipcMain.handle('session:export', async (event, sessionId: string) => {
    if (!sessionId) throw new Error('Session id is required')
    const win = windowForEvent(event)
    const result = await dialog.showSaveDialog(win, {
      title: t('sessions.export'),
      defaultPath: 'session.html',
      filters: [
        { name: 'HTML', extensions: ['html'] },
        { name: 'JSONL', extensions: ['jsonl'] }
      ]
    })
    if (result.canceled || !result.filePath) return null
    return { path: await exportSession(sessionId, result.filePath) }
  })

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
    async (_event, sessionId: string, index: number, action: Parameters<typeof updateFollowUpMessage>[2], mode?: Parameters<typeof updateFollowUpMessage>[3]) => {
      return updateFollowUpMessage(sessionId, index, action, mode)
    }
  )
}
