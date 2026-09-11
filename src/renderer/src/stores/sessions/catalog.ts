import type { ProjectGroup, SessionMeta } from '../../ipc/api'
import type { OpenTab, SessionsStore } from './types'

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

export function fillEmptySessionTitle(groups: ProjectGroup[], sessionId: string, title: string): ProjectGroup[] {
  return groups.map((group) =>
    mapGroupSessions(group, (sessions) => sessions.map((session) =>
      session.id === sessionId && !session.name && !session.firstMessage
        ? { ...session, firstMessage: title }
        : session
    ))
  )
}

export function patchTabsFromGroups(tabs: OpenTab[], groups: ProjectGroup[]): OpenTab[] {
  const metas = new Map(groups.flatMap((group) => group.sessions).map((meta) => [meta.id, meta]))
  return tabs.map((tab) => {
    const meta = metas.get(tab.sessionId)
    if (!meta) return tab
    return {
      ...tab,
      title: meta.name || meta.firstMessage || tab.title,
      meta
    }
  })
}

export function upsertGroup(
  groups: ProjectGroup[],
  cwd: string,
  group: ProjectGroup | null,
  keepEmpty: boolean,
  prepend = false
): ProjectGroup[] {
  const index = groups.findIndex((item) => item.cwd === cwd)
  const next = [...groups]
  const keep = group && (keepEmpty || group.sessions.length > 0)
  if (keep && group) {
    if (index === -1) {
      if (prepend) next.unshift(group)
      else next.push(group)
    } else next[index] = group
  } else if (index !== -1) {
    next.splice(index, 1)
  }
  return next
}

export function removeCwdSessions(
  state: SessionsStore,
  cwds: Set<string>,
  sessions: SessionMeta[]
): Pick<SessionsStore, 'openTabs' | 'runtime' | 'activeSessionId'> {
  const deletedSessionIds = new Set([
    ...sessions.filter((session) => cwds.has(session.cwd)).map((session) => session.id),
    ...state.openTabs.filter((tab) => cwds.has(tab.cwd)).map((tab) => tab.sessionId)
  ])
  const openTabs = state.openTabs.filter((tab) => !deletedSessionIds.has(tab.sessionId))
  const runtime = { ...state.runtime }
  for (const sessionId of deletedSessionIds) delete runtime[sessionId]
  return {
    openTabs,
    runtime,
    activeSessionId: state.activeSessionId && deletedSessionIds.has(state.activeSessionId)
      ? openTabs[openTabs.length - 1]?.sessionId ?? null
      : state.activeSessionId
  }
}
