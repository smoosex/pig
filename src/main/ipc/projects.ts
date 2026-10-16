import { dialog, ipcMain } from 'electron'
import { closeSessionsForCwd, createPendingSession } from '../pi/session-registry'
import { removeProjectSessions } from '../pi/session-removal'
import { addOpenedProject, removeOpenedProject, reorderOpenedProjects } from '../opened-projects'
import { canonicalProject } from '../worktrees'
import {
  discoverOpenedWorktrees,
  loadOpenedWorktreeProjects,
  loadProjectForCwd,
  loadWorktreeProject,
  loadWorktreeSessions,
  requireOpenedProject,
  worktrees
} from '../project-worktrees'
import { createChatDir, isChatCwd, isChatsRoot, listChats, removeChatWorkDir } from '../chats'
import { removeOpenProjectWorkspaces } from '../open-project-sessions'
import { registerWorktreeIpc } from './worktrees'
import { windowForEvent } from './window'

export function registerProjectIpc(): void {
  registerWorktreeIpc()
  ipcMain.handle('session:list-projects', async () => loadOpenedWorktreeProjects())
  ipcMain.handle('project:discover-opened-worktrees', async () => discoverOpenedWorktrees())
  ipcMain.handle('project:list-worktree-sessions', async (_event, projectCwd: string, cwd: string) =>
    loadWorktreeSessions(projectCwd, cwd)
  )
  ipcMain.handle('session:list-project', async (_event, cwd: string) => loadProjectForCwd(cwd))

  ipcMain.handle('session:open-project', async (event) => {
    const win = windowForEvent(event)
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    const picked = result.filePaths[0]
    if (isChatCwd(picked) || isChatsRoot(picked)) return null
    const cwd = await addOpenedProject(await canonicalProject(picked))
    return loadWorktreeProject(cwd)
  })

  ipcMain.handle('session:list-chats', async () => listChats())
  ipcMain.handle('session:is-chat-cwd', async (_event, cwd: string) => isChatCwd(cwd))

  ipcMain.handle('session:create-chat', async (event) => {
    const win = windowForEvent(event)
    const cwd = await createChatDir()
    const session = createPendingSession(cwd, win, { draft: false })
    return { sessionId: session.sessionId, cwd: session.cwd }
  })

  ipcMain.handle('session:delete-chat', async (_event, cwd: string) => {
    if (!cwd || !isChatCwd(cwd)) throw new Error('Chat cwd is required')
    await closeSessionsForCwd(cwd)
    await removeProjectSessions(cwd)
    await removeChatWorkDir(cwd)
  })

  ipcMain.handle('session:unpin-project', async (_event, cwd: string) => {
    if (!cwd) throw new Error('Project cwd is required')
    const project = await requireOpenedProject(cwd)
    const cwds = new Set([project, ...(await worktrees.discover(project)).map((item) => item.cwd)])
    await Promise.all([...cwds].map(closeSessionsForCwd))
    await removeOpenProjectWorkspaces(cwds)
    await removeOpenedProject(project)
  })

  ipcMain.handle('session:reorder-projects', async (_event, cwds: unknown) => {
    return reorderOpenedProjects(cwds)
  })

  ipcMain.handle('session:delete-project', async (_event, cwd: string) => {
    const project = await requireOpenedProject(cwd)
    await worktrees.exclusive(project, async () => {
      const cwds = new Set([project, ...(await worktrees.discover(project)).map((w) => w.cwd)])
      await worktrees.withBlockedCwds([...cwds], async () => {
        for (const path of cwds) {
          await closeSessionsForCwd(path)
          await removeProjectSessions(path)
        }
        await removeOpenProjectWorkspaces(cwds)
        await removeOpenedProject(project)
      })
    })
    return true
  })
}
