import { create } from 'zustand'
import { api, type ProjectGroup, type SessionMeta } from '../ipc/api'
import { isPiMessage, type PiMessage } from '../pi/types'

export type { ProjectGroup, SessionMeta }

interface RuntimeState {
  messages: PiMessage[]
  isStreaming: boolean
}

interface OpenTab {
  sessionId: string
  cwd: string
  title: string
  meta?: SessionMeta
}

const emptyRuntime = (): RuntimeState => ({
  messages: [],
  isStreaming: false
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
  refreshProject: (cwd: string) => Promise<void>
  hydrateMessages: (sessionId: string) => Promise<void>

  openExisting: (meta: SessionMeta) => Promise<void>
  newSession: (cwd: string) => Promise<void>
  deleteProject: (cwd: string) => Promise<void>
  deleteSession: (meta: SessionMeta) => Promise<void>
  closeTab: (sessionId: string) => void
  setActive: (sessionId: string) => void
  renameTab: (sessionId: string, title: string) => void

  setStreaming: (sessionId: string, streaming: boolean) => void
  appendMessage: (sessionId: string, message: PiMessage) => void
  replaceLastMessage: (sessionId: string, message: PiMessage) => void
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

  hydrateMessages: async (sessionId) => {
    const raw = await api.getMessages(sessionId)
    const messages = (raw ?? []).filter(isPiMessage)
    set((s) => ({ runtime: patchRuntime(s.runtime, sessionId, { messages }) }))
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
    await get().hydrateMessages(ref.sessionId)
  },

  newSession: async (cwd) => {
    const ref = await api.createSession(cwd)
    const tab: OpenTab = { sessionId: ref.sessionId, cwd: ref.cwd, title: 'New Session' }
    set((s) => ({
      openTabs: [...s.openTabs, tab],
      activeSessionId: ref.sessionId,
      runtime: patchRuntime(s.runtime, ref.sessionId, emptyRuntime())
    }))
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
        .filter((project) => project.sessions.length > 0)
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
    set((s) => ({ runtime: patchRuntime(s.runtime, sessionId, { isStreaming: streaming }) })),

  appendMessage: (sessionId, message) =>
    set((s) => {
      const rt = ensureRuntime(s.runtime, sessionId)
      return {
        runtime: patchRuntime(s.runtime, sessionId, { messages: [...rt.messages, message] })
      }
    }),

  replaceLastMessage: (sessionId, message) =>
    set((s) => {
      const rt = ensureRuntime(s.runtime, sessionId)
      if (rt.messages.length === 0) {
        return { runtime: patchRuntime(s.runtime, sessionId, { messages: [message] }) }
      }
      const last = rt.messages[rt.messages.length - 1]
      if (last.role !== message.role) {
        return { runtime: patchRuntime(s.runtime, sessionId, { messages: [...rt.messages, message] }) }
      }
      return {
        runtime: patchRuntime(s.runtime, sessionId, {
          messages: [...rt.messages.slice(0, -1), message]
        })
      }
    })
}))