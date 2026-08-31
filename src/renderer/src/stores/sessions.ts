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
  type ThinkingLevel
} from '../ipc/api'
import { buildTurn, type ProcessItem } from '../chat/turns'
import { isPiMessage, type PiMessage } from '../pi/types'

export type { ProjectGroup, SessionMeta }

interface RuntimeState {
  turns: DisplayTurn[]
  liveMessages: PiMessage[]
  processByTurnId: Record<string, ProcessItem[]>
  isStreaming: boolean
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

const emptyRuntime = (): RuntimeState => ({
  turns: [],
  liveMessages: [],
  processByTurnId: {},
  isStreaming: false,
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

interface SessionsStore {
  projects: ProjectGroup[]
  openTabs: OpenTab[]
  activeSessionId: string | null
  runtime: Record<string, RuntimeState>

  loadProjects: () => Promise<void>
  openProject: () => Promise<void>
  unpinProject: (cwd: string) => Promise<void>
  refreshProject: (cwd: string) => Promise<void>
  hydrateTurns: (sessionId: string) => Promise<void>
  loadTurnProcess: (sessionId: string, turnId: string) => Promise<void>
  loadControls: (sessionId: string) => Promise<void>
  applyControls: (sessionId: string, controls: SessionControls) => void
  setThinkingLevel: (sessionId: string, thinkingLevel: ThinkingLevel) => void

  openExisting: (meta: SessionMeta) => Promise<void>
  newSession: (cwd: string) => Promise<void>
  deleteProject: (cwd: string) => Promise<void>
  deleteSession: (meta: SessionMeta) => Promise<void>
  closeTab: (sessionId: string) => void
  setActive: (sessionId: string) => void
  renameTab: (sessionId: string, title: string) => void

  setStreaming: (sessionId: string, streaming: boolean) => void
  appendLiveMessage: (sessionId: string, message: PiMessage) => void
  replaceLiveMessage: (sessionId: string, message: PiMessage) => void
  viewBranch: (sessionId: string, tipId: string) => Promise<void>
}

export const useSessionsStore = create<SessionsStore>((set, get) => ({
  projects: [],
  openTabs: [],
  activeSessionId: null,
  runtime: {},

  loadProjects: async () => {
    const projects = await api.listProjects()
    const metas = new Map(projects.flatMap((project) => project.sessions).map((meta) => [meta.id, meta]))
    set((s) => ({
      projects,
      openTabs: s.openTabs.map((tab) => {
        const meta = metas.get(tab.sessionId)
        if (!meta) return tab
        return {
          ...tab,
          title: meta.name || meta.firstMessage || tab.title,
          meta
        }
      })
    }))
  },

  openProject: async () => {
    const project = await api.openProject()
    if (!project) return
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
    set((s) => ({
      projects: s.projects.filter((project) => project.cwd !== cwd)
    }))
  },

  refreshProject: async (cwd) => {
    const project = await api.listProject(cwd)
    set((s) => {
      const index = s.projects.findIndex((item) => item.cwd === cwd)
      const projects = [...s.projects]
      if (project) {
        if (index === -1) projects.push(project)
        else projects[index] = project
      } else if (index !== -1) {
        projects.splice(index, 1)
      }
      const metas = new Map((project?.sessions ?? []).map((meta) => [meta.id, meta]))
      return {
        projects,
        openTabs: s.openTabs.map((tab) => {
          const meta = metas.get(tab.sessionId)
          if (!meta) return tab
          return {
            ...tab,
            title: meta.name || meta.firstMessage || tab.title,
            meta
          }
        })
      }
    })
  },

  hydrateTurns: async (sessionId) => {
    const turns = await api.getDisplayTurns(sessionId)
    set((s) => {
      const rt = ensureRuntime(s.runtime, sessionId)
      return {
        runtime: patchRuntime(s.runtime, sessionId, {
          turns,
          liveMessages: rt.isStreaming ? rt.liveMessages : [],
          processByTurnId: rt.isStreaming ? rt.processByTurnId : {}
        })
      }
    })
  },

  loadTurnProcess: async (sessionId, turnId) => {
    const cached = ensureRuntime(get().runtime, sessionId).processByTurnId[turnId]
    if (cached) return
    const raw = await api.getTurnMessages(sessionId, turnId)
    const process = buildTurn((raw ?? []).filter(isPiMessage), false).process
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

  deleteProject: async (cwd) => {
    await api.deleteProject(cwd)
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
        projects: s.projects.filter((project) => project.cwd !== cwd),
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
      const projects = s.projects
        .map((project) =>
          project.cwd === meta.cwd
            ? { ...project, sessions: project.sessions.filter((session) => session.id !== meta.id) }
            : project
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

  setStreaming: (sessionId, streaming) =>
    set((s) => {
      const rt = ensureRuntime(s.runtime, sessionId)
      return {
        runtime: patchRuntime(s.runtime, sessionId, {
          isStreaming: streaming,
          liveMessages: streaming ? [] : rt.liveMessages
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
    await api.viewBranch(sessionId, tipId)
    await Promise.all([get().hydrateTurns(sessionId), get().loadControls(sessionId)])
  }
}))
