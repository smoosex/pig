/** Tab lifecycle, project-workspace restoration, and lazy session loading. */
import { api, type OpenSessionRef, type SessionMeta } from '../../ipc/api'
import { fillEmptySessionTitle } from './catalog'
import { emptyRuntime } from './runtime'
import type { OpenTab, SessionSlice, TabKind } from './types'

function titleFor(meta: SessionMeta): string {
  return meta.name || meta.firstMessage || 'Session'
}

export const createTabsSlice: SessionSlice<
  | 'openTabs'
  | 'activeSessionId'
  | 'currentProjectCwd'
  | 'activeSessionByCwd'
  | 'draftSessionByCwd'
  | 'draftSessionErrorByCwd'
  | 'workspaceRestoreReady'
  | 'workspaceRestoreError'
  | 'workspaceError'
  | 'initializeProjectWorkspaces'
  | 'selectProjectCwd'
  | 'activateTab'
  | 'openExisting'
  | 'acquireProjectDraft'
  | 'releaseProjectDraft'
  | 'promoteProjectDraft'
  | 'newSession'
  | 'newChat'
  | 'closeTab'
  | 'setActive'
  | 'renameTab'
  | 'previewSessionTitle'
> = (set, get) => {
  const opening = new Map<string, Promise<OpenSessionRef>>()
  const closing = new Map<string, Promise<void>>()
  const draftCreation = new Map<string, Promise<void>>()
  const draftLeases = new Map<string, number>()
  let initializeRequest: Promise<void> | null = null
  let selectionVersion = 0
  let persistenceVersion = 0

  const describeError = (error: unknown) => error instanceof Error ? error.message : String(error)

  function persistSelection(cwd: string, sessionId: string | null): void {
    const request = ++persistenceVersion
    void api.selectOpenProjectWorkspace(cwd, sessionId).then(
      () => {
        if (request === persistenceVersion) set({ workspaceError: null })
      },
      (error: unknown) => {
        if (request === persistenceVersion) set({ workspaceError: describeError(error) })
      }
    )
  }

  function addReadyTab(tab: OpenTab, selection: number): boolean {
    let added = false
    set((state) => {
      const existing = state.openTabs.some((item) => item.sessionId === tab.sessionId)
      added = !existing
      const project = tab.kind === 'project'
      return {
        openTabs: existing ? state.openTabs : [...state.openTabs, tab],
        activeSessionId: selection === selectionVersion ? tab.sessionId : state.activeSessionId,
        currentProjectCwd: selection === selectionVersion
          ? (project ? tab.cwd : null)
          : state.currentProjectCwd,
        activeSessionByCwd: project && selection === selectionVersion
          ? { ...state.activeSessionByCwd, [tab.cwd]: tab.sessionId }
          : state.activeSessionByCwd,
        runtime: existing || state.runtime[tab.sessionId]
          ? state.runtime
          : { ...state.runtime, [tab.sessionId]: emptyRuntime() }
      }
    })
    return added
  }

  async function openRef(meta: SessionMeta): Promise<OpenSessionRef> {
    let request = opening.get(meta.path)
    if (!request) {
      request = (async () => {
        await closing.get(meta.id)
        return api.openSession(meta.path)
      })()
      opening.set(meta.path, request)
    }
    try {
      return await request
    } finally {
      if (opening.get(meta.path) === request) opening.delete(meta.path)
    }
  }

  async function hydrateReady(ref: OpenSessionRef): Promise<void> {
    await get().hydrateTurns(ref.sessionId, { display: ref.display })
    await get().loadControls(ref.sessionId)
  }

  return {
    openTabs: [],
    activeSessionId: null,
    currentProjectCwd: null,
    activeSessionByCwd: {},
    draftSessionByCwd: {},
    draftSessionErrorByCwd: {},
    workspaceRestoreReady: false,
    workspaceRestoreError: null,
    workspaceError: null,

    initializeProjectWorkspaces: () => {
      if (get().workspaceRestoreReady) return Promise.resolve()
      if (initializeRequest) return initializeRequest
      const restoreSelection = selectionVersion
      set({ workspaceRestoreError: null })
      initializeRequest = (async () => {
        const [persisted] = await Promise.all([
          api.getOpenProjectSessions(),
          get().loadProjects()
        ])
        const projects = get().projects
        const worktreeCwds = new Set<string>()
        const metas = new Map<string, SessionMeta>()
        for (const project of projects) {
          const worktrees = project.worktrees ?? [{ cwd: project.cwd, sessions: project.sessions }]
          for (const worktree of worktrees) {
            worktreeCwds.add(worktree.cwd)
            for (const meta of worktree.sessions) metas.set(meta.id, meta)
          }
        }

        const workspaces = persisted.workspaces.flatMap((workspace) => {
          if (!worktreeCwds.has(workspace.cwd)) return []
          const sessionIds = workspace.sessionIds.filter((id) => metas.get(id)?.cwd === workspace.cwd)
          if (sessionIds.length === 0) return []
          return [{
            cwd: workspace.cwd,
            sessionIds,
            activeSessionId: sessionIds.includes(workspace.activeSessionId ?? '')
              ? workspace.activeSessionId
              : sessionIds.at(-1) ?? null
          }]
        })
        const currentProjectCwd = persisted.currentCwd && worktreeCwds.has(persisted.currentCwd)
          ? persisted.currentCwd
          : null
        const restoredTabs: OpenTab[] = workspaces.flatMap((workspace) =>
          workspace.sessionIds.flatMap((id) => {
            const meta = metas.get(id)
            return meta ? [{
              sessionId: id,
              cwd: workspace.cwd,
              title: titleFor(meta),
              kind: 'project' as const,
              loadState: 'cold' as const,
              meta
            }] : []
          })
        )
        const activeSessionByCwd = Object.fromEntries(
          workspaces.map((workspace) => [workspace.cwd, workspace.activeSessionId])
        )
        const activeSessionId = currentProjectCwd
          ? activeSessionByCwd[currentProjectCwd] ?? null
          : null

        const selectionUnchanged = restoreSelection === selectionVersion
        set((state) => {
          const restoredIds = new Set(restoredTabs.map((tab) => tab.sessionId))
          const projectTabs = [
            ...restoredTabs,
            ...state.openTabs.filter((tab) => tab.kind === 'project' && !restoredIds.has(tab.sessionId))
          ]
          return {
            openTabs: [...state.openTabs.filter((tab) => tab.kind !== 'project'), ...projectTabs],
            activeSessionByCwd: selectionUnchanged
              ? activeSessionByCwd
              : { ...activeSessionByCwd, ...state.activeSessionByCwd },
            currentProjectCwd: selectionUnchanged ? currentProjectCwd : state.currentProjectCwd,
            activeSessionId: selectionUnchanged ? activeSessionId : state.activeSessionId,
            workspaceRestoreReady: true,
            workspaceRestoreError: null
          }
        })

        if (selectionUnchanged && activeSessionId) {
          await get().activateTab(activeSessionId)
        }
      })().catch((error: unknown) => {
        // A failed scan stays retryable: the restore only counts as done once it actually succeeded.
        set({ workspaceRestoreError: describeError(error) })
      }).finally(() => {
        initializeRequest = null
      })
      return initializeRequest
    },

    selectProjectCwd: async (cwd) => {
      const selection = ++selectionVersion
      const sessionId = get().activeSessionByCwd[cwd] ?? null
      set({ currentProjectCwd: cwd, activeSessionId: sessionId })
      persistSelection(cwd, sessionId)
      if (sessionId && selection === selectionVersion) await get().activateTab(sessionId)
    },

    activateTab: async (sessionId) => {
      const tab = get().openTabs.find((item) => item.sessionId === sessionId)
      if (!tab) return
      if (tab.kind === 'project' && get().draftSessionByCwd[tab.cwd] === sessionId) {
        await get().promoteProjectDraft(tab.cwd, sessionId)
        return
      }
      const selection = ++selectionVersion
      if (get().activeSessionId === sessionId && tab.loadState === 'ready') return
      set((state) => ({
        activeSessionId: sessionId,
        currentProjectCwd: tab.kind === 'project' ? tab.cwd : null,
        activeSessionByCwd: tab.kind === 'project'
          ? { ...state.activeSessionByCwd, [tab.cwd]: sessionId }
          : state.activeSessionByCwd,
        openTabs: state.openTabs.map((item) =>
          item.sessionId === sessionId && (item.loadState === 'cold' || item.loadState === 'error')
            ? { ...item, loadState: 'opening', loadError: undefined }
            : item
        )
      }))
      if (tab.kind === 'project') persistSelection(tab.cwd, sessionId)
      if (tab.loadState === 'ready' || tab.loadState === 'opening') return
      if (!tab.meta) {
        set((state) => ({
          openTabs: state.openTabs.map((item) => item.sessionId === sessionId
            ? { ...item, loadState: 'error', loadError: '会话文件不存在' }
            : item)
        }))
        return
      }

      try {
        const ref = await openRef(tab.meta)
        const current = get().openTabs.find((item) => item.sessionId === sessionId)
        if (!current) {
          await api.closeSession(ref.sessionId)
          return
        }
        set((state) => state.runtime[sessionId] ? state : {
          runtime: { ...state.runtime, [sessionId]: emptyRuntime() }
        })
        await get().hydrateTurns(ref.sessionId, { display: ref.display })
        set((state) => ({
          openTabs: state.openTabs.map((item) => item.sessionId === sessionId
            ? { ...item, loadState: 'ready', loadError: undefined }
            : item)
        }))
        if (selection !== selectionVersion && get().currentProjectCwd) {
          const cwd = get().currentProjectCwd!
          persistSelection(cwd, get().activeSessionByCwd[cwd] ?? null)
        }
      } catch (error) {
        set((state) => ({
          openTabs: state.openTabs.map((item) => item.sessionId === sessionId
            ? { ...item, loadState: 'error', loadError: describeError(error) }
            : item)
        }))
        return
      }
      try {
        await get().loadControls(sessionId)
      } catch (error) {
        get().setControlsStatus(sessionId, { controlsError: describeError(error) })
      }
    },

    openExisting: async (meta, kind: TabKind = 'project') => {
      const existing = get().openTabs.find((tab) => tab.meta?.path === meta.path || tab.sessionId === meta.id)
      if (existing) {
        await get().activateTab(existing.sessionId)
        return
      }
      if (kind === 'project' && get().draftSessionByCwd[meta.cwd] === meta.id) {
        await get().promoteProjectDraft(meta.cwd, meta.id)
        set((state) => ({
          openTabs: state.openTabs.map((tab) => tab.sessionId === meta.id
            ? { ...tab, title: titleFor(meta), meta }
            : tab)
        }))
        return
      }
      const selection = ++selectionVersion
      const ref = await openRef(meta)
      const added = addReadyTab({
        sessionId: ref.sessionId,
        cwd: ref.cwd,
        title: titleFor(meta),
        kind,
        loadState: 'ready',
        meta
      }, selection)
      if (kind === 'project' && selection === selectionVersion) {
        persistSelection(ref.cwd, ref.sessionId)
      }
      if (added) await hydrateReady(ref)
    },

    acquireProjectDraft: (cwd) => {
      draftLeases.set(cwd, (draftLeases.get(cwd) ?? 0) + 1)
      if (get().draftSessionByCwd[cwd] || draftCreation.has(cwd)) return
      set((state) => ({
        draftSessionErrorByCwd: { ...state.draftSessionErrorByCwd, [cwd]: undefined }
      }))
      const request = (async () => {
        try {
          const ref = await api.createSession(cwd)
          if ((draftLeases.get(cwd) ?? 0) === 0) {
            await api.discardDraftSession(ref.sessionId)
            return
          }
          set((state) => ({
            draftSessionByCwd: { ...state.draftSessionByCwd, [cwd]: ref.sessionId },
            runtime: { ...state.runtime, [ref.sessionId]: emptyRuntime() }
          }))
          try {
            await get().loadControls(ref.sessionId)
          } catch (error) {
            get().setControlsStatus(ref.sessionId, { controlsError: describeError(error) })
          }
        } catch (error) {
          if ((draftLeases.get(cwd) ?? 0) > 0) {
            set((state) => ({
              draftSessionErrorByCwd: { ...state.draftSessionErrorByCwd, [cwd]: describeError(error) }
            }))
          }
        }
      })().finally(() => {
        if (draftCreation.get(cwd) === request) draftCreation.delete(cwd)
      })
      draftCreation.set(cwd, request)
    },

    releaseProjectDraft: (cwd) => {
      const leases = Math.max(0, (draftLeases.get(cwd) ?? 0) - 1)
      if (leases > 0) {
        draftLeases.set(cwd, leases)
        return
      }
      draftLeases.delete(cwd)
      const sessionId = get().draftSessionByCwd[cwd]
      if (!sessionId) return
      set((state) => {
        const draftSessionByCwd = { ...state.draftSessionByCwd }
        const draftSessionErrorByCwd = { ...state.draftSessionErrorByCwd }
        const runtime = { ...state.runtime }
        delete draftSessionByCwd[cwd]
        delete draftSessionErrorByCwd[cwd]
        delete runtime[sessionId]
        return { draftSessionByCwd, draftSessionErrorByCwd, runtime }
      })
      void api.discardDraftSession(sessionId).catch((error: unknown) => {
        set({ workspaceError: describeError(error) })
      })
    },

    promoteProjectDraft: async (cwd, sessionId) => {
      if (get().draftSessionByCwd[cwd] !== sessionId) return false
      const selection = ++selectionVersion
      set((state) => {
        const draftSessionByCwd = { ...state.draftSessionByCwd }
        delete draftSessionByCwd[cwd]
        return { draftSessionByCwd }
      })
      try {
        await api.promoteSession(sessionId)
      } catch (error) {
        if ((draftLeases.get(cwd) ?? 0) > 0 && get().runtime[sessionId]) {
          set((state) => ({
            draftSessionByCwd: { ...state.draftSessionByCwd, [cwd]: sessionId }
          }))
        } else {
          set((state) => {
            const runtime = { ...state.runtime }
            delete runtime[sessionId]
            return { runtime }
          })
          void api.discardDraftSession(sessionId).catch(() => {})
        }
        throw error
      }
      addReadyTab({
        sessionId,
        cwd,
        title: 'New Session',
        kind: 'project',
        loadState: 'ready'
      }, selection)
      if (selection === selectionVersion) persistSelection(cwd, sessionId)
      return selection === selectionVersion
    },

    newSession: async (cwd) => {
      const draftSessionId = get().draftSessionByCwd[cwd]
      if (draftSessionId) {
        return await get().promoteProjectDraft(cwd, draftSessionId) ? draftSessionId : null
      }
      const selection = ++selectionVersion
      const ref = await api.createSession(cwd)
      try {
        await api.promoteSession(ref.sessionId)
      } catch (error) {
        await api.discardDraftSession(ref.sessionId)
        throw error
      }
      const added = addReadyTab({
        sessionId: ref.sessionId,
        cwd: ref.cwd,
        title: 'New Session',
        kind: 'project',
        loadState: 'ready'
      }, selection)
      if (selection === selectionVersion) persistSelection(ref.cwd, ref.sessionId)
      if (added) {
        try {
          await get().loadControls(ref.sessionId)
        } catch (error) {
          get().setControlsStatus(ref.sessionId, { controlsError: describeError(error) })
        }
      }
      return selection === selectionVersion ? ref.sessionId : null
    },

    newChat: async () => {
      const selection = ++selectionVersion
      const ref = await api.createChat()
      if (addReadyTab({
        sessionId: ref.sessionId,
        cwd: ref.cwd,
        title: 'New Session',
        kind: 'chat',
        loadState: 'ready'
      }, selection)) {
        await get().loadControls(ref.sessionId)
      }
    },

    closeTab: (sessionId) => {
      if (closing.has(sessionId)) return
      const tab = get().openTabs.find((item) => item.sessionId === sessionId)
      if (!tab) return
      const state = get()
      const remainingInScope = state.openTabs.filter((item) =>
        item.sessionId !== sessionId && item.kind === tab.kind &&
        (tab.kind === 'chat' || item.cwd === tab.cwd)
      )
      const fallback = remainingInScope.at(-1)?.sessionId ?? null
      if (state.activeSessionId === sessionId) selectionVersion++
      set((current) => {
        const openTabs = current.openTabs.filter((item) => item.sessionId !== sessionId)
        const runtime = { ...current.runtime }
        delete runtime[sessionId]
        const activeSessionByCwd = tab.kind === 'project' && current.activeSessionByCwd[tab.cwd] === sessionId
          ? { ...current.activeSessionByCwd, [tab.cwd]: fallback }
          : current.activeSessionByCwd
        return {
          openTabs,
          runtime,
          activeSessionByCwd,
          activeSessionId: current.activeSessionId === sessionId ? fallback : current.activeSessionId
        }
      })
      const request = api.closeSession(sessionId)
      closing.set(sessionId, request)
      void request.then(() => {
        if (tab.kind === 'project' && get().currentProjectCwd === tab.cwd) {
          persistSelection(tab.cwd, get().activeSessionByCwd[tab.cwd] ?? null)
        }
      }, (error: unknown) => {
        set({ workspaceError: describeError(error) })
      }).finally(() => {
        if (closing.get(sessionId) === request) closing.delete(sessionId)
      })
      if (fallback && state.activeSessionId === sessionId) void get().activateTab(fallback)
    },

    setActive: (sessionId) => {
      if (!get().openTabs.some((tab) => tab.sessionId === sessionId)) return
      void get().activateTab(sessionId)
    },

    renameTab: (sessionId, title) => set((state) => ({
      openTabs: state.openTabs.map((tab) => tab.sessionId === sessionId ? { ...tab, title } : tab)
    })),

    previewSessionTitle: (sessionId, title) => set((state) => ({
      openTabs: state.openTabs.map((tab) =>
        tab.sessionId === sessionId && (tab.title === 'New Session' || tab.title === 'Session')
          ? { ...tab, title }
          : tab
      ),
      projects: fillEmptySessionTitle(state.projects, sessionId, title),
      chats: fillEmptySessionTitle(state.chats, sessionId, title)
    }))
  }
}
