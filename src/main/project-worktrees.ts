import { BrowserWindow } from 'electron'
import { watch } from 'node:fs'
import { resolve } from 'node:path'
import { createHeadWatchManager } from './git/head-watch'
import { listOpenedCwds } from './opened-projects'
import { pigPath } from './pig-dir'
import { listProject } from './pi/session-loader'
import { git, isGitProject, WorktreeService, type GitWorktree } from './worktrees'
import type { ProjectGroup, ProjectWorktreeDiscovery, SessionMeta, WorktreeGroup } from '../shared/api'
import { t } from './i18n'

export type { WorktreeGroup } from '../shared/api'

export interface WorktreeProject extends ProjectGroup {
  worktrees: WorktreeGroup[]
}

function sendProjectChanged(projectCwd: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('projects:changed', projectCwd)
    }
  }
}

const branchWatch = createHeadWatchManager({
  watch: (path, listener) => watch(path, listener),
  gitDir: (cwd) => git(cwd, ['rev-parse', '--absolute-git-dir'], { locale: 'C' }),
  onChange: sendProjectChanged
})

/** Follows the branches of the worktrees a listing just reported; anything else stops being watched. */
async function watchBranches(projectCwd: string, hasGit: boolean | null, items: GitWorktree[] | null): Promise<void> {
  const cwds = hasGit && items ? items.filter((item) => !item.missing).map((item) => item.cwd) : []
  // A listing that began before the project was closed must not re-register it. The check waits for
  // queued membership writes, and nothing awaits between it and sync, so a close that lands later
  // still finds this entry to forget.
  if (!(await listOpenedCwds()).includes(projectCwd)) return
  void branchWatch.sync(projectCwd, cwds)
}

export const forgetProjectBranches = branchWatch.forget

export const worktrees = new WorktreeService(pigPath('worktrees'), sendProjectChanged, (jobs) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('worktrees:deletions-changed', jobs)
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
    const branches = await worktrees.discover(cwd, hasGit)
    void watchBranches(cwd, hasGit, branches)
    const groups = await Promise.all(branches.map(async (branch) => ({
      ...branch,
      sessions: branch.cwd === base.cwd ? base.sessions : (await listProject(branch.cwd))?.sessions ?? []
    })))
    return { ...base, hasGit, worktrees: groups, sessions: groups.flatMap((group) => group.sessions) }
  } catch (error) {
    void watchBranches(cwd, hasGit, null)
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
  const opened = await listOpenedCwds()
  branchWatch.retain(opened)
  return Promise.all(opened.map(async (cwd) => {
    let hasGit: boolean | null = null
    try {
      hasGit = await isGitProject(cwd)
      const items = await worktrees.discover(cwd, hasGit)
      void watchBranches(cwd, hasGit, items)
      return { cwd, hasGit, worktrees: items }
    } catch (error) {
      void watchBranches(cwd, hasGit, null)
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
