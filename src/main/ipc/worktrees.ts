import { ipcMain } from 'electron'
import { basename } from 'node:path'
import { isChatCwd, isChatsRoot } from '../chats'
import { loadWorktreeProject, requireOpenedProject, worktrees } from '../project-worktrees'
import { git, isGitProject } from '../worktrees'
import { closeSessionsForCwd } from '../pi/session-registry'
import { removeProjectDir } from '../pi/session-loader'
import { removeOpenProjectWorkspaces } from '../open-project-sessions'

async function createInfo(project: string): Promise<{ hasGit: boolean; hasHead: boolean }> {
  const hasGit = await isGitProject(project)
  const hasHead = hasGit && await git(project, ['rev-parse', '--verify', 'HEAD']).then(() => true).catch(() => false)
  return { hasGit, hasHead }
}

export function registerWorktreeIpc(): void {
  ipcMain.handle('project:worktree-create-info', async (_event, projectCwd: string) => {
    const project = await requireOpenedProject(projectCwd)
    if (isChatCwd(project) || isChatsRoot(project)) throw new Error('独立对话不支持 Worktree')
    return createInfo(project)
  })

  ipcMain.handle('project:create-worktree', async (_event, projectCwd: string, options?: { initGit?: boolean }) => {
    const project = await requireOpenedProject(projectCwd)
    if (isChatCwd(project) || isChatsRoot(project)) throw new Error('独立对话不支持 Worktree')
    const { hasGit, hasHead } = await createInfo(project)
    if (!hasHead && !hasGit) {
      if (!options?.initGit) throw new Error('请先初始化 Git')
      await worktrees.exclusive(project, () => git(project, ['init']))
    }
    const created = await worktrees.create(project)
    return { cwd: created.cwd, project: await loadWorktreeProject(project) }
  })

  ipcMain.handle('project:worktree-deletion-info', async (_event, projectCwd: string, cwd: string) => {
    const project = await requireOpenedProject(projectCwd)
    if (typeof cwd !== 'string' || !cwd || isChatCwd(cwd) || isChatsRoot(cwd)) throw new Error('Invalid worktree cwd')
    const info = await worktrees.deletionInfo(project, cwd)
    return {
      cwd: info.worktree.cwd,
      branch: info.worktree.branch || basename(cwd),
      dirty: info.dirty,
      unmerged: info.unmerged,
      missing: info.worktree.missing
    }
  })

  ipcMain.handle('project:delete-worktree', async (_event, projectCwd: string, cwd: string, force = false) => {
    const project = await requireOpenedProject(projectCwd)
    if (typeof cwd !== 'string' || !cwd || isChatCwd(cwd) || isChatsRoot(cwd)) throw new Error('Invalid worktree cwd')
    const info = await worktrees.deletionInfo(project, cwd)
    await worktrees.remove(project, cwd, Boolean(force),
      () => closeSessionsForCwd(cwd), () => removeProjectDir(cwd))
    await removeOpenProjectWorkspaces([info.worktree.cwd])
    return { cwd: info.worktree.cwd, project: await loadWorktreeProject(project) }
  })
}
