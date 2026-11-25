import { ipcMain } from 'electron'
import type { ConvertChatToProjectInput } from '../../shared/api'
import { assertBrowserSender } from '../browser/validation'
import { convertChatToProject, getDefaultProjectsLocation } from '../chat-to-project'
import { browseProjectDirectories, searchProjectDirectories } from '../project-directory-browser'
import { openProjectDirectory } from '../project-open'
import { unpinProjectDirectory } from '../project-unpin'
import { closeSessionsForCwd, createPendingSession } from '../pi/session-registry'
import { removeProjectSessions } from '../pi/session-removal'
import { reorderOpenedProjects } from '../opened-projects'
import {
  discoverOpenedWorktrees,
  loadOpenedWorktreeProjects,
  loadProjectForCwd,
  loadWorktreeSessions
} from '../project-worktrees'
import { createChatDir, isChatCwd, listChats, removeChatWorkDir } from '../chats'
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

  ipcMain.handle('project:browse-directories', async (_event, path?: string, showHidden?: boolean, includeFiles?: boolean) =>
    browseProjectDirectories(path, showHidden, includeFiles)
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

  ipcMain.handle('session:open-project', async (_event, path: string) => openProjectDirectory(path))

  ipcMain.handle('project:rename', async (event, cwd: string, name: unknown) => {
    assertBrowserSender(event, windowForEvent(event))
    const { renameProjectDirectory } = await import('../project-relocate')
    return renameProjectDirectory(cwd, name)
  })

  ipcMain.handle('project:relocate', async (event, oldCwd: string, newPath: string) => {
    assertBrowserSender(event, windowForEvent(event))
    const { relocateProjectDirectory } = await import('../project-relocate')
    return relocateProjectDirectory(oldCwd, newPath)
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

  ipcMain.handle('project:default-location', async (event) => {
    assertBrowserSender(event, windowForEvent(event))
    return getDefaultProjectsLocation()
  })

  ipcMain.handle('session:convert-chat-to-project', async (event, input: ConvertChatToProjectInput) => {
    assertBrowserSender(event, windowForEvent(event))
    return convertChatToProject(input)
  })

  ipcMain.handle('session:unpin-project', async (_event, cwd: string) => {
    await unpinProjectDirectory(cwd)
  })

  ipcMain.handle('session:reorder-projects', async (_event, cwds: unknown) => {
    return reorderOpenedProjects(cwds)
  })
}
