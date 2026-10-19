import { ipcMain } from 'electron'
import { browseProjectDirectories, resolveProjectDirectory, searchProjectDirectories } from '../project-directory-browser'
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

  ipcMain.handle('project:browse-directories', async (_event, path?: string, showHidden?: boolean) =>
    browseProjectDirectories(path, showHidden)
  )
  // At most one folder walk per window: a new request or an explicit cancel aborts the previous one,
  // so pauses while typing cannot pile up concurrent walks on the libuv threadpool.
  const searches = new Map<number, AbortController>()
  ipcMain.handle('project:search-directories', async (event, path: string, query: string, showHidden: boolean) => {
    const id = event.sender.id
    searches.get(id)?.abort()
    const controller = new AbortController()
    searches.set(id, controller)
    const abort = () => controller.abort()
    event.sender.once('destroyed', abort)
    try {
      return await searchProjectDirectories(path, query, showHidden, controller.signal)
    } finally {
      event.sender.off('destroyed', abort)
      if (searches.get(id) === controller) searches.delete(id)
    }
  })
  ipcMain.handle('project:cancel-directory-search', (event) => {
    searches.get(event.sender.id)?.abort()
  })

  ipcMain.handle('session:open-project', async (_event, path: string) => {
    const picked = await resolveProjectDirectory(path)
    if (isChatCwd(picked) || isChatsRoot(picked)) throw new Error('Chat directories cannot be opened as projects')
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
