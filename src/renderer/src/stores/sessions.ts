import { create } from 'zustand'
import { api, type ProjectGroup, type SessionMeta } from '../ipc/api'

export type { ProjectGroup, SessionMeta }

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
}

interface RuntimeState {
  messages: ChatMessage[]
  isStreaming: boolean
  streamId: string | null
  streamingText: string
}

interface OpenTab {
  sessionId: string
  cwd: string
  title: string
  meta?: SessionMeta
}

interface AnyMessage {
  role?: string
  content?: unknown
  id?: string
}

const emptyRuntime = (): RuntimeState => ({
  messages: [],
  isStreaming: false,
  streamId: null,
  streamingText: ''
})

function ensureRuntime(runtime: Record<string, RuntimeState>, sessionId: string): RuntimeState {
  return runtime[sessionId] ?? emptyRuntime()
}

function extractText(m: AnyMessage): string {
  if (!m) return ''
  const c = m.content
  if (m.role === 'user') {
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      return (c as Array<{ type?: string; text?: string }>)
        .filter((b) => b?.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
    }
    return ''
  }
  if (m.role === 'assistant') {
    if (!Array.isArray(c)) return ''
    const parts: string[] = []
    for (const b of c as Array<{ type?: string; text?: string; thinking?: string; name?: string }>) {
      if (b?.type === 'text') parts.push(b.text ?? '')
      else if (b?.type === 'thinking') parts.push(`（思考）${b.thinking ?? ''}`)
      else if (b?.type === 'toolCall') parts.push(`🔧 ${b.name ?? 'tool'}`)
    }
    return parts.join('\n')
  }
  if (m.role === 'toolResult') {
    if (Array.isArray(c)) {
      return (c as Array<{ type?: string; text?: string }>)
        .filter((b) => b?.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
    }
    return ''
  }
  return ''
}

interface SessionsStore {
  projects: ProjectGroup[]
  openTabs: OpenTab[]
  activeSessionId: string | null
  runtime: Record<string, RuntimeState>

  loadProjects: () => Promise<void>
  hydrateMessages: (sessionId: string) => Promise<void>

  openExisting: (meta: SessionMeta) => Promise<void>
  newSession: (cwd: string) => Promise<void>
  closeTab: (sessionId: string) => void
  setActive: (sessionId: string) => void

  addUserMessage: (sessionId: string, text: string) => void
  beginAssistant: (sessionId: string) => void
  appendChunk: (sessionId: string, chunk: string) => void
  finalizeAssistant: (sessionId: string) => void
  setStreaming: (sessionId: string, streaming: boolean) => void
}

export const useSessionsStore = create<SessionsStore>((set, get) => ({
  projects: [],
  openTabs: [],
  activeSessionId: null,
  runtime: {},

  loadProjects: async () => {
    const projects = await api.listProjects()
    set({ projects })
  },

  hydrateMessages: async (sessionId) => {
    const raw = (await api.getMessages(sessionId)) as AnyMessage[]
    const msgs: ChatMessage[] = (raw ?? [])
      .map((m) => ({
        id: m.id ?? crypto.randomUUID(),
        role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        text: extractText(m)
      }))
      .filter((m) => m.text.length > 0)
    set((s) => ({
      runtime: {
        ...s.runtime,
        [sessionId]: { ...ensureRuntime(s.runtime, sessionId), messages: msgs }
      }
    }))
  },

  openExisting: async (meta) => {
    const existing = get().openTabs.find((t) => t.meta?.path === meta.path)
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
      runtime: { ...s.runtime, [ref.sessionId]: ensureRuntime(s.runtime, ref.sessionId) }
    }))
    await get().hydrateMessages(ref.sessionId)
  },

  newSession: async (cwd) => {
    const ref = await api.createSession(cwd)
    const tab: OpenTab = { sessionId: ref.sessionId, cwd: ref.cwd, title: 'New Session' }
    set((s) => ({
      openTabs: [...s.openTabs, tab],
      activeSessionId: ref.sessionId,
      runtime: { ...s.runtime, [ref.sessionId]: ensureRuntime(s.runtime, ref.sessionId) }
    }))
    void get().loadProjects()
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

  addUserMessage: (sessionId, text) =>
    set((s) => {
      const rt = ensureRuntime(s.runtime, sessionId)
      const msg: ChatMessage = { id: crypto.randomUUID(), role: 'user', text }
      return {
        runtime: { ...s.runtime, [sessionId]: { ...rt, messages: [...rt.messages, msg] } }
      }
    }),

  beginAssistant: (sessionId) =>
    set((s) => {
      const rt = ensureRuntime(s.runtime, sessionId)
      const id = crypto.randomUUID()
      const msg: ChatMessage = { id, role: 'assistant', text: '', streaming: true }
      return {
        runtime: {
          ...s.runtime,
          [sessionId]: {
            ...rt,
            messages: [...rt.messages, msg],
            streamId: id,
            streamingText: '',
            isStreaming: true
          }
        }
      }
    }),

  appendChunk: (sessionId, chunk) =>
    set((s) => {
      const rt = ensureRuntime(s.runtime, sessionId)
      if (!rt.streamId) return {}
      return {
        runtime: {
          ...s.runtime,
          [sessionId]: {
            ...rt,
            messages: rt.messages.map((m) =>
              m.id === rt.streamId ? { ...m, text: m.text + chunk } : m
            ),
            streamingText: rt.streamingText + chunk
          }
        }
      }
    }),

  finalizeAssistant: (sessionId) =>
    set((s) => {
      const rt = ensureRuntime(s.runtime, sessionId)
      if (!rt.streamId) return {}
      return {
        runtime: {
          ...s.runtime,
          [sessionId]: {
            ...rt,
            messages: rt.messages.map((m) =>
              m.id === rt.streamId ? { ...m, streaming: false } : m
            ),
            streamId: null,
            streamingText: '',
            isStreaming: false
          }
        }
      }
    }),

  setStreaming: (sessionId, streaming) =>
    set((s) => {
      const rt = ensureRuntime(s.runtime, sessionId)
      return { runtime: { ...s.runtime, [sessionId]: { ...rt, isStreaming: streaming } } }
    })
}))