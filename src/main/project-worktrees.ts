import { BrowserWindow } from 'electron'
import { resolve } from 'node:path'
import { listOpenedCwds } from './opened-projects'
import { pigPath } from './pig-dir'
import { listProject } from './pi/session-loader'
import { isGitProject, WorktreeService } from './worktrees'
import type { ProjectGroup, ProjectWorktreeDiscovery, SessionMeta, WorktreeGroup } from '../shared/api'
import { t } from './i18n'

export type { WorktreeGroup } from '../shared/api'

export interface WorktreeProject extends ProjectGroup {
  worktrees: WorktreeGroup[]
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
  if (!(await listOpenedCwds()).includes(path)) throw new Error(t('error.projectNotOpen'))
  return path
}

export async function loadWorktreeProject(cwd: string): Promise<WorktreeProject> {
  const base = await listProject(cwd)
  if (!base) throw new Error(t('error.projectMissing'))
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

export async function discoverOpenedWorktrees(): Promise<ProjectWorktreeDiscovery[]> {
  return Promise.all((await listOpenedCwds()).map(async (cwd) => {
    let hasGit: boolean | null = null
    try {
      hasGit = await isGitProject(cwd)
      return { cwd, hasGit, worktrees: await worktrees.discover(cwd, hasGit) }
    } catch (error) {
      return {
        cwd,
        hasGit,
        worktrees: null,
        gitError: error instanceof Error ? error.message : String(error)
      }
    }
  }))
}

export async function loadWorktreeSessions(projectCwd: string, cwd: string): Promise<SessionMeta[]> {
  const project = await requireOpenedProject(projectCwd)
  const target = resolve(cwd)
  const topology = await worktrees.discover(project)
  if (!topology.some((worktree) => worktree.cwd === target)) {
    throw new Error(t('error.worktreeNotOpen'))
  }
  return (await listProject(target))?.sessions ?? []
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
