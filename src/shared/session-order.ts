import type { ProjectGroup } from './api'

export function compareGroupsByLatestSession(a: ProjectGroup, b: ProjectGroup): number {
  const activity = (b.sessions[0]?.modified ?? '').localeCompare(a.sessions[0]?.modified ?? '')
  if (activity !== 0) return activity
  return a.cwd < b.cwd ? -1 : a.cwd > b.cwd ? 1 : 0
}
