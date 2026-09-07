import { BrowserWindow } from 'electron'
import { resolve } from 'node:path'
import { listOpenedCwds } from './opened-projects'
import { pigPath } from './pig-dir'
import { listProject, type ProjectGroup, type SessionMeta } from './pi/session-loader'
import { isGitProject, WorktreeService, type GitWorktree } from './worktrees'

export interface WorktreeGroup extends GitWorktree {
  sessions: SessionMeta[]
}

export interface WorktreeProject extends ProjectGroup {
  worktrees: WorktreeGroup[]
  hasGit?: boolean
  gitError?: string
}

export const worktrees = new WorktreeService(pigPath('worktrees'), (projectCwd) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('projects:changed', projectCwd)
    }
  }
})

export async function requireOpenedProject(cwd: string): Promise<string> {
  if (typeof cwd !== 'string' || !cwd) throw new Error('Project cwd is required')
  const path = resolve(cwd)
  if (!(await listOpenedCwds()).includes(path)) throw new Error('只能操作已打开的项目')
  return path
}

export async function loadWorktreeProject(cwd: string): Promise<WorktreeProject> {
  const base = await listProject(cwd)
  if (!base) throw new Error('项目不存在')
  const hasGit = await isGitProject(cwd)
  try {
    const branches = await worktrees.discover(cwd)
    const groups = await Promise.all(branches.map(async (branch) => ({
      ...branch,
      sessions: branch.cwd === base.cwd ? base.sessions : (await listProject(branch.cwd))?.sessions ?? []
    })))
    return { ...base, hasGit, worktrees: groups, sessions: groups.flatMap((group) => group.sessions) }
  } catch (error) {
    return {
      ...base,
      hasGit,
      worktrees: [{ cwd: base.cwd, branch: base.name, isPrimary: true, locked: false, missing: false, managed: false, sessions: base.sessions }],
      gitError: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function loadOpenedWorktreeProjects(): Promise<WorktreeProject[]> {
  return Promise.all((await listOpenedCwds()).map(loadWorktreeProject))
}

export async function loadProjectForCwd(cwd: string): Promise<ProjectGroup | null> {
  const path = resolve(cwd)
  const opened = await listOpenedCwds()
  if (opened.includes(path)) return loadWorktreeProject(path)
  for (const projectCwd of opened) {
    const branches = await worktrees.discover(projectCwd).catch(() => [])
    if (branches.some((branch) => branch.cwd === path)) return loadWorktreeProject(projectCwd)
  }
  return listProject(cwd)
}
