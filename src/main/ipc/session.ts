import { BrowserWindow, dialog, ipcMain } from 'electron'
import {
  closeSession,
  closeSessionsForCwd,
  createPendingSession,
  exportSession,
  getLive,
  getSessionControls,
  getSessionTree,
  listSessionCommands,
  openSession,
  prepareSession,
  refreshSessionModels,
  setSessionModel,
  setSessionThinking,
  viewSessionBranch,
  type SessionThinkingLevel
} from '../pi/session-registry'
import { getDisplayTurns, getTurnMessages } from '../pi/session-display'
import { listOpenedProjects, listProject, removeProjectDir, removeSessionFile } from '../pi/session-loader'
import { addOpenedProject, listOpenedCwds, removeOpenedProject } from '../opened-projects'
import {
  createChatDir,
  isChatCwd,
  isChatsRoot,
  listChats,
  removeChatWorkDir
} from '../chats'

export function registerSessionIpc(): void {
  ipcMain.handle('session:list-projects', async () => listOpenedProjects(await listOpenedCwds()))
  ipcMain.handle('session:list-project', async (_event, cwd: string) => listProject(cwd))

  ipcMain.handle('session:open-project', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('No window attached to sender')
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    const picked = result.filePaths[0]
    if (isChatCwd(picked) || isChatsRoot(picked)) return null
    const cwd = await addOpenedProject(picked)
    return listProject(cwd)
  })

  ipcMain.handle('session:list-chats', async () => listChats())
  ipcMain.handle('session:is-chat-cwd', async (_event, cwd: string) => isChatCwd(cwd))

  ipcMain.handle('session:create-chat', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('No window attached to sender')
    const cwd = await createChatDir()
    const session = createPendingSession(cwd, win)
    return { sessionId: session.sessionId, cwd: session.cwd }
  })

  ipcMain.handle('session:delete-chat', async (_event, cwd: string) => {
    if (!cwd || !isChatCwd(cwd)) throw new Error('Chat cwd is required')
    await closeSessionsForCwd(cwd)
    await removeProjectDir(cwd)
    await removeChatWorkDir(cwd)
  })

  ipcMain.handle('session:unpin-project', async (_event, cwd: string) => {
    if (!cwd) throw new Error('Project cwd is required')
    await removeOpenedProject(cwd)
  })

  ipcMain.handle('session:create', async (event, cwd: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('No window attached to sender')
    if (isChatCwd(cwd) || isChatsRoot(cwd)) {
      throw new Error('Chat directories allow only one session')
    }
    const session = createPendingSession(cwd, win)
    return { sessionId: session.sessionId, cwd: session.cwd }
  })

  ipcMain.handle('session:open', async (event, path: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('No window attached to sender')
    const ls = await openSession(path, win)
    return { sessionId: ls.sessionId, cwd: ls.cwd }
  })

  ipcMain.handle('session:prepare', async (_event, sessionId: string) => {
    const created = !getLive(sessionId)
    const session = await prepareSession(sessionId)
    return { sessionId: session.sessionId, cwd: session.cwd, created }
  })

  ipcMain.handle('session:close', async (_event, sessionId: string) => {
    await closeSession(sessionId)
  })

  ipcMain.handle('session:delete-project', async (_event, cwd: string) => {
    if (!cwd) throw new Error('Project cwd is required')
    await closeSessionsForCwd(cwd)
    await removeProjectDir(cwd)
    await removeOpenedProject(cwd)
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
    async (
      _event,
      sessionId: string,
      text: string,
      images?: { mimeType: string; data: string }[]
    ) => {
      const ls = getLive(sessionId) ?? (await prepareSession(sessionId))
      const attachments = (Array.isArray(images) ? images : [])
        .filter(
          (image) =>
            typeof image?.mimeType === 'string' &&
            image.mimeType.startsWith('image/') &&
            typeof image?.data === 'string' &&
            image.data.length > 0
        )
        .map((image) => ({
          type: 'image' as const,
          mimeType: image.mimeType,
          data: image.data.includes(',') ? image.data.slice(image.data.indexOf(',') + 1) : image.data
        }))
      await ls.agentSession.prompt(text, attachments.length > 0 ? { images: attachments } : undefined)
    }
  )

  ipcMain.handle('session:abort', async (_event, sessionId: string) => {
    const ls = getLive(sessionId)
    if (!ls) throw new Error(`Session not found: ${sessionId}`)
    await ls.agentSession.abort()
  })

  ipcMain.handle('session:get-messages', async (_event, sessionId: string) => {
    const ls = getLive(sessionId)
    if (!ls) throw new Error(`Session not found: ${sessionId}`)
    return ls.agentSession.messages
  })

  ipcMain.handle('session:get-display-turns', async (_event, sessionId: string) => {
    return getDisplayTurns(sessionId)
  })

  ipcMain.handle('session:get-turn-messages', async (_event, sessionId: string, turnId: string) => {
    if (!sessionId || !turnId) throw new Error('Session id and turn id are required')
    return getTurnMessages(sessionId, turnId)
  })

  ipcMain.handle('session:get-tree', async (_event, sessionId: string) => {
    return getSessionTree(sessionId)
  })

  ipcMain.handle('session:view-branch', async (_event, sessionId: string, tipId: string) => {
    if (!sessionId || !tipId) throw new Error('Session id and tip id are required')
    viewSessionBranch(sessionId, tipId)
  })

  ipcMain.handle('session:get-controls', async (_event, sessionId: string) => {
    return getSessionControls(sessionId)
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
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win) throw new Error('No window attached to sender')
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
}