import type { ProjectGroup, ProjectWorktreeDiscovery, SessionMeta, SessionPreviewFallback } from '../../ipc/api'
import type { OpenTab, SessionsStore } from './types'
import { sessionTitle } from './session-title'

export function mapGroupSessions(
  group: ProjectGroup,
  update: (sessions: SessionMeta[]) => SessionMeta[]
): ProjectGroup {
  return {
    ...group,
    sessions: update(group.sessions),
    ...(group.worktrees && {
      worktrees: group.worktrees.map((worktree) => ({
        ...worktree,
        sessions: update(worktree.sessions)
      }))
    })
  }
}

export function mergeWorktreeDiscoveries(
  projects: ProjectGroup[],
  discoveries: ProjectWorktreeDiscovery[]
): ProjectGroup[] {
  const byCwd = new Map(discoveries.map((discovery) => [discovery.cwd, discovery]))
  return projects.map((project) => {
    const discovery = byCwd.get(project.cwd)
    if (!discovery) return project
    const hasGit = discovery.hasGit ?? project.hasGit
    if (!discovery.worktrees) return { ...project, hasGit, gitError: discovery.gitError }
    const existingByCwd = new Map(
      (project.worktrees ?? []).map((worktree) => [worktree.cwd, worktree])
    )
    const worktrees = discovery.worktrees.map((worktree) => {
      const existing = existingByCwd.get(worktree.cwd)
      const primarySessions = !project.worktrees && worktree.cwd === project.cwd
        ? project.sessions
        : []
      return {
        ...worktree,
        sessions: existing?.sessions ?? primarySessions,
        sessionsLoaded: existing?.sessionsLoaded ?? Boolean(existing || !project.worktrees)
      }
    })
    return {
      ...project,
      hasGit,
      worktrees,
      sessions: worktrees.flatMap((worktree) => worktree.sessions),
      gitError: discovery.gitError
    }
  })
}

export function fillEmptySessionTitle(groups: ProjectGroup[], sessionId: string, title: string, fallback?: SessionPreviewFallback): ProjectGroup[] {
  return groups.map((group) =>
    mapGroupSessions(group, (sessions) => sessions.map((session) =>
      session.id === sessionId && !session.name && !session.firstMessage
        // A marker preview leaves no word behind: the renderer translates the marker, so clearing
        // a rename later hands the title back to a fresh word instead of a frozen one.
        ? { ...session, firstMessage: fallback ? '' : title, previewFallback: fallback }
        : session
    ))
  )
}

/** The display name a rename wrote, or the cleared name that hands the title back to the first message.
 * A real name only shadows a preview marker; the marker stays so clearing the name re-translates it. */
export function renameGroupSession(
  groups: ProjectGroup[],
  sessionId: string,
  name: string | undefined
): ProjectGroup[] {
  return groups.map((group) =>
    mapGroupSessions(group, (sessions) => sessions.map((session) =>
      session.id === sessionId ? { ...session, name } : session
    ))
  )
}

export function patchTabsFromGroups(tabs: OpenTab[], groups: ProjectGroup[]): OpenTab[] {
  const metas = new Map(groups.flatMap((group) => group.sessions).map((meta) => [meta.id, meta]))
  return tabs.map((tab) => {
    const meta = metas.get(tab.id)
    if (!meta) return tab
    return {
      ...tab,
      // A listing with nothing to show keeps the tab's title; sessionTitle() alone would fall back
      // to the placeholder and wipe a preview the composer just wrote. The marker follows the fresh
      // listing so a later locale switch does not translate a title that is no longer a preview.
      title: sessionTitle(meta, tab.title),
      meta,
      previewFallback: meta.previewFallback
    }
  })
}

export function upsertGroup(
  groups: ProjectGroup[],
  cwd: string,
  group: ProjectGroup | null,
  keepEmpty: boolean
): ProjectGroup[] {
  const index = groups.findIndex((item) => item.cwd === cwd)
  const next = [...groups]
  const keep = group && (keepEmpty || group.sessions.length > 0)
  if (keep && group) {
    if (index === -1) next.push(group)
    else next[index] = group
  } else if (index !== -1) {
    next.splice(index, 1)
  }
  return next
}

export function removeCwdSessions(
  state: SessionsStore,
  cwds: Set<string>,
  sessions: SessionMeta[]
): Pick<
  SessionsStore,
  'openTabs' | 'runtime' | 'activeTabId' | 'currentProjectCwd' | 'activeSessionByCwd'
> {
  // Diff tabs share their worktree's fate but own no session, so their ids join the removed set.
  const removedTabIds = new Set([
    ...sessions.filter((session) => cwds.has(session.cwd)).map((session) => session.id),
    ...state.openTabs.filter((tab) => cwds.has(tab.cwd)).map((tab) => tab.id)
  ])
  const openTabs = state.openTabs.filter((tab) => !removedTabIds.has(tab.id))
  const runtime = { ...state.runtime }
  for (const sessionId of removedTabIds) delete runtime[sessionId]
  const activeSessionByCwd = { ...state.activeSessionByCwd }
  for (const cwd of cwds) delete activeSessionByCwd[cwd]
  const currentProjectCwd = state.currentProjectCwd && cwds.has(state.currentProjectCwd)
    ? null
    : state.currentProjectCwd
  const activeWasRemoved = Boolean(
    state.activeTabId && removedTabIds.has(state.activeTabId)
  )
  return {
    openTabs,
    runtime,
    currentProjectCwd,
    activeSessionByCwd,
    activeTabId: activeWasRemoved
      ? currentProjectCwd === null
        ? openTabs.findLast((tab) => tab.kind === 'chat')?.id ?? null
        : null
      : state.activeTabId
  }
}
