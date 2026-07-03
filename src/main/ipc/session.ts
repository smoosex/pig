import { BrowserWindow, ipcMain } from 'electron'
import { closeSession, createSession, getLive, openSession } from '../pi/session-registry'
import { listProjects } from '../pi/session-loader'

export function registerSessionIpc(): void {
  ipcMain.handle('session:list-projects', async () => listProjects())

  ipcMain.handle('session:create', async (event, cwd: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('No window attached to sender')
    const ls = await createSession(cwd, win)
    return { sessionId: ls.sessionId, cwd: ls.cwd }
  })

  ipcMain.handle('session:open', async (event, path: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('No window attached to sender')
    const ls = await openSession(path, win)
    return { sessionId: ls.sessionId, cwd: ls.cwd }
  })

  ipcMain.handle('session:close', async (_event, sessionId: string) => {
    closeSession(sessionId)
  })

  ipcMain.handle('session:prompt', async (_event, sessionId: string, text: string) => {
    const ls = getLive(sessionId)
    if (!ls) throw new Error(`Session not found: ${sessionId}`)
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
}