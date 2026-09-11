/** Tab lifecycle and titles; catalog deletion also removes the corresponding tabs. */
import { api, type SessionRef } from '../../ipc/api'
import { fillEmptySessionTitle } from './catalog'
import { emptyRuntime } from './runtime'
import type { OpenTab, SessionSlice } from './types'

export const createTabsSlice: SessionSlice<
  | 'openTabs'
  | 'activeSessionId'
  | 'openExisting'
  | 'newSession'
  | 'newChat'
  | 'closeTab'
  | 'setActive'
  | 'renameTab'
  | 'previewSessionTitle'
> = (set, get) => {
  const opening = new Map<string, Promise<SessionRef>>()
  const closing = new Map<string, Promise<void>>()
  let selectionVersion = 0

  function addTab(tab: OpenTab, selection: number): boolean {
    let added = false
    set((state) => {
      const existing = state.openTabs.some((item) => item.sessionId === tab.sessionId)
      added = !existing
      return {
        openTabs: existing ? state.openTabs : [...state.openTabs, tab],
        activeSessionId: selection === selectionVersion ? tab.sessionId : state.activeSessionId,
        runtime: existing ? state.runtime : { ...state.runtime, [tab.sessionId]: emptyRuntime() }
      }
    })
    return added
  }

  return {
    openTabs: [],
    activeSessionId: null,

    openExisting: async (meta) => {
      const selection = ++selectionVersion
      const existing = get().openTabs.find((tab) => tab.meta?.path === meta.path || tab.sessionId === meta.id)
      if (existing) {
        set({ activeSessionId: existing.sessionId })
        return
      }

      let request = opening.get(meta.path)
      if (!request) {
        request = (async () => {
          // A quick reopen must wait until main has released the old SDK instance.
          await closing.get(meta.id)
          return api.openSession(meta.path)
        })()
        opening.set(meta.path, request)
      }
      try {
        const ref = await request
        if (opening.get(meta.path) === request) opening.delete(meta.path)
        const added = addTab({
          sessionId: ref.sessionId,
          cwd: ref.cwd,
          title: meta.name || meta.firstMessage || 'Session',
          meta
        }, selection)
        if (added) await Promise.all([get().hydrateTurns(ref.sessionId), get().loadControls(ref.sessionId)])
      } finally {
        if (opening.get(meta.path) === request) opening.delete(meta.path)
      }
    },

    newSession: async (cwd) => {
      const selection = ++selectionVersion
      const ref = await api.createSession(cwd)
      if (addTab({ sessionId: ref.sessionId, cwd: ref.cwd, title: 'New Session' }, selection)) {
        await get().loadControls(ref.sessionId)
      }
    },

    newChat: async () => {
      const selection = ++selectionVersion
      const ref = await api.createChat()
      if (addTab({ sessionId: ref.sessionId, cwd: ref.cwd, title: 'New Session' }, selection)) {
        await get().loadControls(ref.sessionId)
      }
    },

    closeTab: (sessionId) => {
      if (closing.has(sessionId)) return
      if (get().activeSessionId === sessionId) selectionVersion++
      const request = api.closeSession(sessionId)
      closing.set(sessionId, request)
      void request.catch((error) => console.error('Failed to close session:', error)).finally(() => {
        if (closing.get(sessionId) === request) closing.delete(sessionId)
      })
      set((state) => {
        const openTabs = state.openTabs.filter((tab) => tab.sessionId !== sessionId)
        const runtime = { ...state.runtime }
        delete runtime[sessionId]
        return {
          openTabs,
          runtime,
          activeSessionId: state.activeSessionId === sessionId
            ? openTabs[openTabs.length - 1]?.sessionId ?? null : state.activeSessionId
        }
      })
    },

    setActive: (sessionId) => {
      if (!get().openTabs.some((tab) => tab.sessionId === sessionId)) return
      selectionVersion++
      set({ activeSessionId: sessionId })
    },

    renameTab: (sessionId, title) => set((state) => ({
      openTabs: state.openTabs.map((tab) => tab.sessionId === sessionId ? { ...tab, title } : tab)
    })),

    previewSessionTitle: (sessionId, title) => set((state) => ({
      openTabs: state.openTabs.map((tab) =>
        tab.sessionId === sessionId && (tab.title === 'New Session' || tab.title === 'Session')
          ? { ...tab, title } : tab
      ),
      projects: fillEmptySessionTitle(state.projects, sessionId, title),
      chats: fillEmptySessionTitle(state.chats, sessionId, title)
    }))
  }
}
