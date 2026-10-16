import { ipcMain } from 'electron'
import { basename, resolve } from 'node:path'
import { isChatCwd, isChatsRoot } from '../chats'
import { loadWorktreeProject, requireOpenedProject, worktrees } from '../project-worktrees'
import { git, isGitProject } from '../worktrees'
import { nameWorktreeBranch } from '../pi/branch-namer'
import { closeSessionsForCwd } from '../pi/session-registry'
import { readProjectNamingText } from '../pi/session-loader'
import { removeProjectSessions } from '../pi/session-removal'
import { removeOpenProjectWorkspaces } from '../open-project-sessions'
import { t } from '../i18n'

/** Replay the saved task, or recover the first prompt of the earliest task-bearing legacy session. */
async function namingTextFor(cwd: string): Promise<string> {
  const kept = await worktrees.namingTask(cwd)
  if (kept?.trim()) return kept
  const text = await readProjectNamingText(cwd)
  if (text) return text
  throw new Error(t('error.worktreeNoNamingText'))
}

async function retryWorktreeNaming(projectCwd: string, cwd: string): Promise<void> {
  const path = resolve(cwd)
  const topology = await worktrees.discover(projectCwd)
  if (!topology.some((item) => item.cwd === path)) throw new Error(t('error.worktreeNotOpen'))
  const { attempt } = await worktrees.retryNaming(path, () => namingTextFor(path), nameWorktreeBranch)
  // The rename itself is not awaited: a model call can run for minutes, while the row follows the
  // record through the same pushes the first attempt used. Only refusing it reaches the renderer.
  attempt.catch((error) => console.error('Worktree naming retry failed:', error))
}

async function createInfo(project: string): Promise<{ hasGit: boolean; hasHead: boolean }> {
  const hasGit = await isGitProject(project)
  const hasHead = hasGit && await git(project, ['rev-parse', '--verify', 'HEAD']).then(() => true).catch(() => false)
  return { hasGit, hasHead }
}

export function registerWorktreeIpc(): void {
  ipcMain.handle('project:worktree-create-info', async (_event, projectCwd: string) => {
    const project = await requireOpenedProject(projectCwd)
    if (isChatCwd(project) || isChatsRoot(project)) throw new Error(t('error.chatHasNoWorktree'))
    return createInfo(project)
  })

  ipcMain.handle('project:create-worktree', async (_event, projectCwd: string, options?: { initGit?: boolean }) => {
    const project = await requireOpenedProject(projectCwd)
    if (isChatCwd(project) || isChatsRoot(project)) throw new Error(t('error.chatHasNoWorktree'))
    const { hasGit, hasHead } = await createInfo(project)
    if (!hasHead && !hasGit) {
      if (!options?.initGit) throw new Error(t('error.gitRequired'))
      await worktrees.exclusive(project, () => git(project, ['init']))
    }
    const created = await worktrees.create(project)
    return { cwd: created.cwd, project: await loadWorktreeProject(project) }
  })

  ipcMain.handle('project:retry-worktree-naming', async (_event, projectCwd: string, cwd: string) => {
    const project = await requireOpenedProject(projectCwd)
    if (typeof cwd !== 'string' || !cwd || isChatCwd(cwd) || isChatsRoot(cwd)) throw new Error('Invalid worktree cwd')
    await retryWorktreeNaming(project, cwd)
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

  ipcMain.handle('project:list-worktree-deletions', async () => worktrees.listDeletions())
  ipcMain.handle('project:retry-worktree-deletion', async (_event, cwd: string) => {
    if (typeof cwd !== 'string' || !cwd) throw new Error('Invalid worktree cwd')
    await worktrees.retryDeletion(cwd)
  })

  ipcMain.handle('project:delete-worktree', async (_event, projectCwd: string, cwd: string) => {
    const project = await requireOpenedProject(projectCwd)
    if (typeof cwd !== 'string' || !cwd || isChatCwd(cwd) || isChatsRoot(cwd)) throw new Error('Invalid worktree cwd')
    const info = await worktrees.deletionInfo(project, cwd)
    await worktrees.remove(project, cwd,
      () => closeSessionsForCwd(cwd), () => removeProjectSessions(cwd), { background: true })
    await removeOpenProjectWorkspaces([info.worktree.cwd])
    return { cwd: info.worktree.cwd }
  })
}
