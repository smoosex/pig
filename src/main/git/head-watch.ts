/**
 * Keeps the sidebar's branch names current while Pig keeps focus.
 *
 * Window focus already re-lists every opened project's worktrees, which catches whatever changed
 * outside Pig; a checkout in Pig's own terminal or an Agent's bash never blurs the window, so each
 * worktree's HEAD is watched as well. Only HEAD: worktree membership, missing directories and locks
 * stay with the focus re-list, which is also the fallback when a watch cannot be set up or fails.
 *
 * git lands HEAD by renaming HEAD.lock over it, which orphans a watch on the file itself, so the
 * worktree's git directory is watched and its events filtered by name.
 */
import type { FSWatcher } from 'node:fs'

export interface HeadWatchOptions {
  watch: (path: string, listener: (event: string, filename: string | null) => void) => FSWatcher
  gitDir: (cwd: string) => Promise<string>
  onChange: (projectCwd: string) => void
  debounceMs?: number
}

interface Project {
  watchers: Map<string, FSWatcher>
  timer?: ReturnType<typeof setTimeout>
  /** Reconciles run in call order, so an older listing cannot re-add a worktree a newer one dropped. */
  queue: Promise<void>
  closed: boolean
}

export function createHeadWatchManager(options: HeadWatchOptions): {
  sync: (projectCwd: string, worktreeCwds: string[]) => Promise<void>
  retain: (projectCwds: string[]) => void
  forget: (projectCwd: string) => void
} {
  const projects = new Map<string, Project>()
  const debounceMs = options.debounceMs ?? 300

  const notify = (projectCwd: string, project: Project): void => {
    if (project.closed) return
    clearTimeout(project.timer)
    project.timer = setTimeout(() => options.onChange(projectCwd), debounceMs)
  }

  const reconcile = async (projectCwd: string, project: Project, cwds: string[]): Promise<void> => {
    const wanted = new Set(cwds)
    for (const [cwd, watcher] of project.watchers) {
      if (wanted.has(cwd)) continue
      watcher.close()
      project.watchers.delete(cwd)
    }
    for (const cwd of wanted) {
      if (project.closed) return
      if (project.watchers.has(cwd)) continue
      try {
        const dir = (await options.gitDir(cwd)).trim()
        if (project.closed) return
        const watcher = options.watch(dir, (_event, filename) => {
          if (!filename || filename === 'HEAD') notify(projectCwd, project)
        })
        // Dropping the entry lets the next listing try again.
        watcher.on('error', (error) => {
          console.warn(`Branch watch for ${cwd} failed:`, error)
          watcher.close()
          if (project.watchers.get(cwd) === watcher) project.watchers.delete(cwd)
        })
        project.watchers.set(cwd, watcher)
      } catch (error) {
        console.warn(`Branch watch for ${cwd} unavailable:`, error)
      }
    }
  }

  const sync = (projectCwd: string, worktreeCwds: string[]): Promise<void> => {
    let project = projects.get(projectCwd)
    if (!project) {
      project = { watchers: new Map(), queue: Promise.resolve(), closed: false }
      projects.set(projectCwd, project)
    }
    const current = project
    current.queue = current.queue.then(() => reconcile(projectCwd, current, worktreeCwds))
    return current.queue
  }

  const forget = (projectCwd: string): void => {
    const project = projects.get(projectCwd)
    if (!project) return
    project.closed = true
    clearTimeout(project.timer)
    for (const watcher of project.watchers.values()) watcher.close()
    project.watchers.clear()
    projects.delete(projectCwd)
  }

  const retain = (projectCwds: string[]): void => {
    const keep = new Set(projectCwds)
    for (const projectCwd of [...projects.keys()]) if (!keep.has(projectCwd)) forget(projectCwd)
  }

  return { sync, retain, forget }
}
