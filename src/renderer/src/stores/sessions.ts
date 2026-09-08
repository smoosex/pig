import { create } from 'zustand'
import {
  api,
  type DisplayTurn,
  type ProjectGroup,
  type SessionContextUsage,
  type SessionControls,
  type SessionMeta,
  type SessionModelInfo,
  type SessionTokenStats,
  type ThinkingLevel,
  type WorktreeGroup
} from '../ipc/api'
import { buildTurn, thinkingTimingKey, type ProcessItem, type ThinkingDurations } from '../chat/turns'
import { isPiMessage, type PiMessage } from '../pi/types'

export type { ProjectGroup, SessionMeta, WorktreeGroup }

interface RuntimeState {
  turns: DisplayTurn[]
  leafId: string | null
  branchViewId: string
  branchViews: Record<string, string>
  branchRequest: number
  liveMessages: PiMessage[]
  processByTurnId: Record<string, ProcessItem[]>
  thinkingDurations: ThinkingDurations
  elapsedByTurnId: Record<string, number>
  isStreaming: boolean
  streamStartedAt: number | null
  streamElapsedMs: number | null
  model: SessionModelInfo | null
  models: SessionModelInfo[]
  thinkingLevel: ThinkingLevel
  thinkingLevels: ThinkingLevel[]
  contextUsage: SessionContextUsage | null
  tokens: SessionTokenStats
}

interface OpenTab {
  sessionId: string
  cwd: string
  title: string
  meta?: SessionMeta
}

let branchViewSequence = 0

function createBranchViewId(): string {
  branchViewSequence += 1
  return `branch-view-${branchViewSequence}`
}

const emptyRuntime = (): RuntimeState => ({
  turns: [],
  leafId: null,
  branchViewId: createBranchViewId(),
  branchViews: {},
  branchRequest: 0,
  liveMessages: [],
  processByTurnId: {},
  thinkingDurations: {},
  elapsedByTurnId: {},
  isStreaming: false,
  streamStartedAt: null,
  streamElapsedMs: null,
  model: null,
  models: [],
  thinkingLevel: 'off',
  thinkingLevels: ['off'],
  contextUsage: null,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
})

function ensureRuntime(runtime: Record<string, RuntimeState>, sessionId: string): RuntimeState {
  return runtime[sessionId] ?? emptyRuntime()
}

function patchRuntime(
  runtime: Record<string, RuntimeState>,
  sessionId: string,
  patch: Partial<RuntimeState>
): Record<string, RuntimeState> {
  return {
    ...runtime,
    [sessionId]: { ...ensureRuntime(runtime, sessionId), ...patch }
  }
}

function mapGroupSessions(
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

function fillEmptySessionTitle(groups: ProjectGroup[], sessionId: string, title: string): ProjectGroup[] {
  return groups.map((group) =>
    mapGroupSessions(group, (sessions) => sessions.map((session) =>
      session.id === sessionId && !session.name && !session.firstMessage
        ? { ...session, firstMessage: title }
        : session
    ))
  )
}

function patchTabsFromGroups(tabs: OpenTab[], groups: ProjectGroup[]): OpenTab[] {
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

function upsertGroup(
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

function removeCwdSessions(
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

interface SessionsStore {
  projects: ProjectGroup[]
  chats: ProjectGroup[]
  openTabs: OpenTab[]
  activeSessionId: string | null
  runtime: Record<string, RuntimeState>
  isReorderingProjects: boolean

  loadProjects: () => Promise<void>
  loadChats: () => Promise<void>
  openProject: () => Promise<void>
  unpinProject: (cwd: string) => Promise<void>
  reorderProjects: (cwds: string[]) => Promise<void>
  refreshProject: (cwd: string) => Promise<void>
  refreshCwd: (cwd: string) => Promise<void>
  hydrateTurns: (
    sessionId: string,
    options?: {
      expectedLeafId?: string | null
      expectedBranchRequest?: number
      branchViewId?: string
    }
  ) => Promise<boolean>
  loadTurnProcess: (sessionId: string, turnId: string) => Promise<void>
  loadControls: (sessionId: string) => Promise<void>
  applyControls: (sessionId: string, controls: SessionControls) => void
  setThinkingLevel: (sessionId: string, thinkingLevel: ThinkingLevel) => void

  openExisting: (meta: SessionMeta) => Promise<void>
  newSession: (cwd: string) => Promise<void>
  newChat: () => Promise<void>
  createWorktree: (projectCwd: string, options?: { initGit?: boolean }) => Promise<string | null>
  deleteWorktree: (projectCwd: string, cwd: string, force?: boolean) => Promise<void>
  deleteProject: (cwd: string) => Promise<void>
  deleteChat: (cwd: string) => Promise<void>
  deleteSession: (meta: SessionMeta) => Promise<void>
  closeTab: (sessionId: string) => void
  setActive: (sessionId: string) => void
  renameTab: (sessionId: string, title: string) => void
  previewSessionTitle: (sessionId: string, title: string) => void

  setStreaming: (sessionId: string, streaming: boolean) => void
  setThinkingDuration: (
    sessionId: string,
    messageTimestamp: number,
    contentIndex: number,
    durationMs: number
  ) => void
  appendLiveMessage: (sessionId: string, message: PiMessage) => void
  replaceLiveMessage: (sessionId: string, message: PiMessage) => void
  viewBranch: (sessionId: string, tipId: string) => Promise<void>
}

let projectMembershipVersion = 0
let projectOrderVersion = 0

export const useSessionsStore = create<SessionsStore>((set, get) => ({
  projects: [],
  chats: [],
  openTabs: [],
  activeSessionId: null,
  runtime: {},
  isReorderingProjects: false,

  loadProjects: async () => {
    const version = projectMembershipVersion
    const orderVersion = projectOrderVersion
    const savingOrder = get().isReorderingProjects
    const projects = await api.listProjects()
    if (
      version !== projectMembershipVersion ||
      orderVersion !== projectOrderVersion ||
      savingOrder ||
      get().isReorderingProjects
    ) return
    set((s) => ({
      projects,
      openTabs: patchTabsFromGroups(s.openTabs, projects)
    }))
  },

  loadChats: async () => {
    const chats = await api.listChats()
    set((s) => ({
      chats,
      openTabs: patchTabsFromGroups(s.openTabs, chats)
    }))
  },

  openProject: async () => {
    const project = await api.openProject()
    if (!project) return
    projectMembershipVersion++
    set((s) => {
      const index = s.projects.findIndex((item) => item.cwd === project.cwd)
      const projects = [...s.projects]
      if (index === -1) projects.push(project)
      else projects[index] = project
      return { projects }
    })
  },

  unpinProject: async (cwd) => {
    await api.unpinProject(cwd)
    projectMembershipVersion++
    set((s) => ({
      projects: s.projects.filter((project) => project.cwd !== cwd)
    }))
  },

  reorderProjects: async (cwds) => {
    if (get().isReorderingProjects) throw new Error('项目排序正在保存')
    const currentProjects = get().projects
    if (
      cwds.length !== currentProjects.length ||
      cwds.some((cwd) => typeof cwd !== 'string') ||
      new Set(cwds).size !== cwds.length
    ) {
      throw new Error('项目列表已变化，请重试')
    }
    const byCwd = new Map(currentProjects.map((project) => [project.cwd, project]))
    if (cwds.some((cwd) => !byCwd.has(cwd))) throw new Error('项目列表已变化，请重试')
    const nextProjects = cwds.map((cwd) => byCwd.get(cwd)!)
    if (nextProjects.every((project, index) => project.cwd === currentProjects[index]?.cwd)) return

    const previousProjects = currentProjects
    const membershipVersion = projectMembershipVersion
    const orderVersion = ++projectOrderVersion
    set({ projects: nextProjects, isReorderingProjects: true })
    try {
      await api.reorderProjects(cwds)
      if (projectOrderVersion === orderVersion) set({ isReorderingProjects: false })
    } catch (error) {
      if (projectOrderVersion === orderVersion) {
        set((s) => ({
          projects: projectMembershipVersion === membershipVersion ? previousProjects : s.projects,
          isReorderingProjects: false
        }))
        try {
          await get().loadProjects()
        } catch {
        }
      }
      throw error
    }
  },

  refreshProject: async (cwd) => {
    const project = await api.listProject(cwd)
    set((s) => ({
      projects: project
        ? s.projects.some((item) => item.cwd === project.cwd)
          ? upsertGroup(s.projects, project.cwd, project, true)
          : s.projects
        : s.projects.filter((item) => item.cwd !== cwd),
      openTabs: patchTabsFromGroups(s.openTabs, project ? [project] : [])
    }))
  },

  refreshCwd: async (cwd) => {
    if (await api.isChatCwd(cwd)) {
      const chat = await api.listProject(cwd)
      set((s) => ({
        chats: upsertGroup(s.chats, cwd, chat, false),
        openTabs: patchTabsFromGroups(s.openTabs, chat ? [chat] : [])
      }))
      return
    }
    await get().refreshProject(cwd)
  },

  hydrateTurns: async (sessionId, options) => {
    const result = await api.getDisplayTurns(sessionId)
    const current = get().runtime[sessionId]
    if (
      (options?.expectedLeafId !== undefined && result.leafId !== options.expectedLeafId) ||
      (options?.expectedBranchRequest != null && current?.branchRequest !== options.expectedBranchRequest)
    ) {
      return false
    }
    set((s) => {
      const rt = ensureRuntime(s.runtime, sessionId)
      const branchViewId = options?.branchViewId ?? rt.branchViewId
      const branchViews = { ...rt.branchViews }
      if (result.leafId) {
        if (
          options?.branchViewId === undefined &&
          rt.leafId &&
          rt.leafId !== result.leafId
        ) {
          delete branchViews[rt.leafId]
        }
        branchViews[result.leafId] = branchViewId
      }
      const elapsedByTurnId = { ...rt.elapsedByTurnId }
      const last = result.turns[result.turns.length - 1]
      if (!rt.isStreaming && rt.streamElapsedMs != null && last) {
        elapsedByTurnId[last.id] = rt.streamElapsedMs
      }
      return {
        runtime: patchRuntime(s.runtime, sessionId, {
          turns: result.turns,
          leafId: result.leafId,
          branchViewId,
          branchViews,
          liveMessages: rt.isStreaming ? rt.liveMessages : [],
          processByTurnId: rt.isStreaming ? rt.processByTurnId : {},
          elapsedByTurnId
        })
      }
    })
    return true
  },

  loadTurnProcess: async (sessionId, turnId) => {
    const runtime = ensureRuntime(get().runtime, sessionId)
    if (runtime.processByTurnId[turnId]) return
    const raw = await api.getTurnMessages(sessionId, turnId)
    const process = buildTurn((raw ?? []).filter(isPiMessage), false, runtime.thinkingDurations).process
    set((s) => {
      const rt = ensureRuntime(s.runtime, sessionId)
      return {
        runtime: patchRuntime(s.runtime, sessionId, {
          processByTurnId: { ...rt.processByTurnId, [turnId]: process }
        })
      }
    })
  },

  loadControls: async (sessionId) => {
    const controls = await api.getControls(sessionId)
    get().applyControls(sessionId, controls)
  },

  applyControls: (sessionId, controls) => {
    set((s) => ({ runtime: patchRuntime(s.runtime, sessionId, controls) }))
  },

  setThinkingLevel: (sessionId, thinkingLevel) => {
    set((s) => ({ runtime: patchRuntime(s.runtime, sessionId, { thinkingLevel }) }))
  },

  openExisting: async (meta) => {
    const existing = get().openTabs.find(
      (t) => t.meta?.path === meta.path || t.sessionId === meta.id
    )
    if (existing) {
      set({ activeSessionId: existing.sessionId })
      return
    }
    const ref = await api.openSession(meta.path)
    const tab: OpenTab = {
      sessionId: ref.sessionId,
      cwd: ref.cwd,
      title: meta.name || meta.firstMessage || 'Session',
      meta
    }
    set((s) => ({
      openTabs: [...s.openTabs, tab],
      activeSessionId: ref.sessionId,
      runtime: patchRuntime(s.runtime, ref.sessionId, emptyRuntime())
    }))
    await Promise.all([get().hydrateTurns(ref.sessionId), get().loadControls(ref.sessionId)])
  },

  newSession: async (cwd) => {
    const ref = await api.createSession(cwd)
    const tab: OpenTab = { sessionId: ref.sessionId, cwd: ref.cwd, title: 'New Session' }
    set((s) => ({
      openTabs: [...s.openTabs, tab],
      activeSessionId: ref.sessionId,
      runtime: patchRuntime(s.runtime, ref.sessionId, emptyRuntime())
    }))
    await get().loadControls(ref.sessionId)
  },

  newChat: async () => {
    const ref = await api.createChat()
    const tab: OpenTab = { sessionId: ref.sessionId, cwd: ref.cwd, title: 'New Session' }
    set((s) => ({
      openTabs: [...s.openTabs, tab],
      activeSessionId: ref.sessionId,
      runtime: patchRuntime(s.runtime, ref.sessionId, emptyRuntime())
    }))
    await get().loadControls(ref.sessionId)
  },

  createWorktree: async (projectCwd, options) => {
    const result = await api.createWorktree(projectCwd, options)
    if (!result) return null
    projectMembershipVersion++
    set((s) => ({
      projects: s.projects.some((project) => project.cwd === result.project.cwd)
        ? upsertGroup(s.projects, result.project.cwd, result.project, true)
        : s.projects,
      openTabs: patchTabsFromGroups(s.openTabs, [result.project])
    }))
    return result.cwd
  },

  deleteWorktree: async (projectCwd, cwd, force = false) => {
    const project = get().projects.find((item) => item.cwd === projectCwd)
    if (cwd === projectCwd || project?.worktrees?.some((worktree) => worktree.cwd === cwd && worktree.isPrimary)) {
      throw new Error('不能删除原项目目录')
    }
    const result = await api.deleteWorktree(projectCwd, cwd, force)
    if (!result) return
    projectMembershipVersion++
    set((s) => {
      const current = s.projects.find((item) => item.cwd === projectCwd)
      return {
        ...removeCwdSessions(s, new Set([cwd]), [
          ...(project?.sessions ?? []),
          ...(current?.sessions ?? [])
        ]),
        projects: s.projects.some((item) => item.cwd === result.project.cwd)
          ? upsertGroup(s.projects, result.project.cwd, result.project, true)
          : s.projects
      }
    })
  },

  deleteProject: async (cwd) => {
    const project = get().projects.find((item) => item.cwd === cwd)
    if (!(await api.deleteProject(cwd))) return
    projectMembershipVersion++
    set((s) => {
      const current = s.projects.find((item) => item.cwd === cwd)
      const sessions = [...(project?.sessions ?? []), ...(current?.sessions ?? [])]
      const cwds = new Set([
        cwd,
        ...(project?.worktrees ?? []).map((worktree) => worktree.cwd),
        ...(current?.worktrees ?? []).map((worktree) => worktree.cwd),
        ...sessions.map((session) => session.cwd)
      ])
      return {
        projects: s.projects.filter((item) => item.cwd !== cwd),
        ...removeCwdSessions(s, cwds, sessions)
      }
    })
  },

  deleteChat: async (cwd) => {
    await api.deleteChat(cwd)
    set((s) => {
      const deletedSessionIds = new Set(
        s.openTabs.filter((tab) => tab.cwd === cwd).map((tab) => tab.sessionId)
      )
      const openTabs = s.openTabs.filter((tab) => tab.cwd !== cwd)
      const runtime = { ...s.runtime }
      for (const sessionId of deletedSessionIds) delete runtime[sessionId]
      const activeWasDeleted = s.activeSessionId
        ? deletedSessionIds.has(s.activeSessionId)
        : false
      return {
        chats: s.chats.filter((chat) => chat.cwd !== cwd),
        openTabs,
        runtime,
        activeSessionId: activeWasDeleted
          ? openTabs[openTabs.length - 1]?.sessionId ?? null
          : s.activeSessionId
      }
    })
  },

  deleteSession: async (meta) => {
    await api.deleteSession(meta.id, meta.path, meta.cwd)

    set((s) => {
      const openTabs = s.openTabs.filter((tab) => tab.sessionId !== meta.id)
      const runtime = { ...s.runtime }
      delete runtime[meta.id]
      const activeWasDeleted = s.activeSessionId === meta.id
      const projects = s.projects.map((project) =>
        mapGroupSessions(project, (sessions) => sessions.filter((session) => session.id !== meta.id))
      )
      return {
        projects,
        openTabs,
        runtime,
        activeSessionId: activeWasDeleted
          ? openTabs[openTabs.length - 1]?.sessionId ?? null
          : s.activeSessionId
      }
    })
  },

  closeTab: (sessionId) => {
    void api.closeSession(sessionId)
    set((s) => {
      const openTabs = s.openTabs.filter((t) => t.sessionId !== sessionId)
      const runtime = { ...s.runtime }
      delete runtime[sessionId]
      let activeSessionId = s.activeSessionId
      if (activeSessionId === sessionId) {
        activeSessionId = openTabs[openTabs.length - 1]?.sessionId ?? null
      }
      return { openTabs, runtime, activeSessionId }
    })
  },

  setActive: (sessionId) => set({ activeSessionId: sessionId }),

  renameTab: (sessionId, title) =>
    set((s) => ({
      openTabs: s.openTabs.map((t) => (t.sessionId === sessionId ? { ...t, title } : t))
    })),

  previewSessionTitle: (sessionId, title) =>
    set((s) => ({
      openTabs: s.openTabs.map((t) =>
        t.sessionId === sessionId && (t.title === 'New Session' || t.title === 'Session') ? { ...t, title } : t
      ),
      projects: fillEmptySessionTitle(s.projects, sessionId, title),
      chats: fillEmptySessionTitle(s.chats, sessionId, title)
    })),

  setStreaming: (sessionId, streaming) =>
    set((s) => {
      const rt = ensureRuntime(s.runtime, sessionId)
      return {
        runtime: patchRuntime(s.runtime, sessionId, {
          isStreaming: streaming,
          streamStartedAt: streaming
            ? (rt.isStreaming ? rt.streamStartedAt : Date.now())
            : null,
          streamElapsedMs: streaming
            ? null
            : rt.streamStartedAt != null
              ? Date.now() - rt.streamStartedAt
              : rt.streamElapsedMs,
          liveMessages: streaming ? [] : rt.liveMessages
        })
      }
    }),

  setThinkingDuration: (sessionId, messageTimestamp, contentIndex, durationMs) =>
    set((s) => {
      const rt = ensureRuntime(s.runtime, sessionId)
      const key = thinkingTimingKey(messageTimestamp, contentIndex)
      if (rt.thinkingDurations[key] != null) return s
      return {
        runtime: patchRuntime(s.runtime, sessionId, {
          thinkingDurations: { ...rt.thinkingDurations, [key]: Math.max(1000, durationMs) }
        })
      }
    }),

  appendLiveMessage: (sessionId, message) =>
    set((s) => {
      const rt = ensureRuntime(s.runtime, sessionId)
      return {
        runtime: patchRuntime(s.runtime, sessionId, {
          liveMessages: [...rt.liveMessages, message]
        })
      }
    }),

  replaceLiveMessage: (sessionId, message) =>
    set((s) => {
      const rt = ensureRuntime(s.runtime, sessionId)
      if (rt.liveMessages.length === 0) {
        return { runtime: patchRuntime(s.runtime, sessionId, { liveMessages: [message] }) }
      }
      const last = rt.liveMessages[rt.liveMessages.length - 1]
      if (last.role !== message.role) {
        return {
          runtime: patchRuntime(s.runtime, sessionId, {
            liveMessages: [...rt.liveMessages, message]
          })
        }
      }
      return {
        runtime: patchRuntime(s.runtime, sessionId, {
          liveMessages: [...rt.liveMessages.slice(0, -1), message]
        })
      }
    }),

  viewBranch: async (sessionId, tipId) => {
    const current = get().runtime[sessionId]
    if (!current) return
    const branchRequest = current.branchRequest + 1
    set((s) => ({
      runtime: patchRuntime(s.runtime, sessionId, { branchRequest })
    }))
    const branch = await api.viewBranch(sessionId, tipId)
    const latest = get().runtime[sessionId]
    if (!latest || latest.branchRequest !== branchRequest) return
    const branchViewId =
      branch.leafId === latest.leafId
        ? latest.branchViewId
        : (branch.leafId ? latest.branchViews[branch.leafId] : undefined) ?? createBranchViewId()
    const hydrated = await get().hydrateTurns(sessionId, {
      expectedLeafId: branch.leafId,
      expectedBranchRequest: branchRequest,
      branchViewId
    })
    if (!hydrated || get().runtime[sessionId]?.branchRequest !== branchRequest) return
    await get().loadControls(sessionId)
  }
}))
