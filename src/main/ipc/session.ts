import { BrowserWindow, ipcMain } from 'electron'
import {
  closeSession,
  closeSessionsForCwd,
  createPendingSession,
  getLive,
  getSessionControls,
  getSessionTree,
  openSession,
  prepareSession,
  setSessionModel,
  setSessionThinking,
  viewSessionBranch,
  type SessionThinkingLevel
} from '../pi/session-registry'
import { getDisplayTurns, getTurnMessages } from '../pi/session-display'
import { listProject, listProjects, removeProjectDir, removeSessionFile } from '../pi/session-loader'

export function registerSessionIpc(): void {
  ipcMain.handle('session:list-projects', async () => listProjects())
  ipcMain.handle('session:list-project', async (_event, cwd: string) => listProject(cwd))

  ipcMain.handle('session:create', async (event, cwd: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('No window attached to sender')
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
    closeSession(sessionId)
  })

  ipcMain.handle('session:delete-project', async (_event, cwd: string) => {
    if (!cwd) throw new Error('Project cwd is required')
    closeSessionsForCwd(cwd)
    await removeProjectDir(cwd)
  })

  ipcMain.handle(
    'session:delete',
    async (_event, sessionId: string, path: string, cwd: string) => {
      if (!sessionId || !path || !cwd) throw new Error('Session id, path, and cwd are required')
      closeSession(sessionId)
      await removeSessionFile(path)
    }
  )

  ipcMain.handle('session:prompt', async (_event, sessionId: string, text: string) => {
    const ls = getLive(sessionId) ?? (await prepareSession(sessionId))
    await ls.agentSession.prompt(text)
  })

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
}