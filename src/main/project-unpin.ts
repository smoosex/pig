/** Unregister a project without deleting source files, worktrees, or session history. */
import { closeSessionsForCwd } from './pi/session-registry'
import { removeOpenProjectWorkspaces } from './open-project-sessions'
import { removeOpenedProject } from './opened-projects'
import { forgetProjectBranches, requireOpenedProject, worktrees } from './project-worktrees'

export async function unpinProjectDirectory(cwd: string, options: {
  check?: () => void
  prepare?: (project: string, cwds: Set<string>) => Promise<() => void>
} = {}): Promise<{ cwd: string; cwds: string[] }> {
  const project = await requireOpenedProject(cwd)
  return worktrees.exclusive(project, async () => {
    options.check?.()
    await requireOpenedProject(project)
    const cwds = new Set([project, ...(await worktrees.discover(project)).map(item => item.cwd)])
    options.check?.()
    const release = await options.prepare?.(project, cwds)
    let changed = false
    try {
      return await worktrees.withBlockedCwds([...cwds], async () => {
        for (const path of cwds) {
          options.check?.()
          changed = true
          await closeSessionsForCwd(path)
        }
        options.check?.()
        await removeOpenProjectWorkspaces(cwds)
        options.check?.()
        await removeOpenedProject(project)
        forgetProjectBranches(project)
        return { cwd: project, cwds: [...cwds] }
      })
    } catch (error) {
      if (!changed) throw error
      throw new Error('Project removal did not finish; some sessions or saved membership may already have changed. No source files or session history were deleted.', { cause: error })
    } finally { release?.() }
  })
}
