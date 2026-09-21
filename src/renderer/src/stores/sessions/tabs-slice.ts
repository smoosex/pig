/** Tab lifecycle, project-workspace restoration, and lazy session loading. */
import { api, type DiffScope, type OpenSessionRef, type SessionMeta } from '../../ipc/api'
import { SCOPE_LABELS, useDiffStore } from '../diff'
import { useFilesStore } from '../files'
import { newSessionId } from '../../lib/session-id'
import { fillEmptySessionTitle } from './catalog'
import { emptyRuntime } from './runtime'
import {
  EMPTY_SESSION_TITLE,
  isPlaceholderSessionTitle,
  sessionTitle
} from './session-title'
import type { OpenTab, SessionsStore, SessionSlice } from './types'

/** The scope a changes tab starts on, and what a workspace restored without one shows. */
const DEFAULT_SCOPE: DiffScope = 'all'

/** One changes tab per worktree, so its id is the worktree: it is never parsed, only compared. */
function changesTabId(cwd: string): string {
  return `diff:${cwd}`
}

/** One file tab per worktree and path: two worktrees hold a `src/main.ts` each, and they are not the same. */
function fileTabId(cwd: string, path: string): string {
  return `file:${cwd}\u0000${path}`
}

/** Drops a draft slot, but only while `cwd` still points at `sessionId`. */
function dropDraftSlot(
  cwd: string,
  sessionId: string
): (state: SessionsStore) => Partial<Pick<SessionsStore, 'draftSessionByCwd' | 'runtime'>> {
  return (state) => {
    if (state.draftSessionByCwd[cwd] !== sessionId) return {}
    const draftSessionByCwd = { ...state.draftSessionByCwd }
    const runtime = { ...state.runtime }
    delete draftSessionByCwd[cwd]
    delete runtime[sessionId]
    return { draftSessionByCwd, runtime }
  }
}

export const createTabsSlice: SessionSlice<
  | 'openTabs'
  | 'activeTabId'
  | 'currentProjectCwd'
  | 'activeSessionByCwd'
  | 'activeTabByCwd'
  | 'draftSessionByCwd'
  | 'draftSessionErrorByCwd'
  | 'workspaceRestoreReady'
  | 'workspaceRestoreError'
  | 'workspaceError'
  | 'initializeProjectWorkspaces'
  | 'selectProjectCwd'
  | 'activateTab'
  | 'openExisting'
  | 'openChangesTab'
  | 'openFileTab'
  | 'setChangesScope'
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
  /** A cwd whose create failed while its slot stayed: the next attempt has to create it again. */
  const draftRetry = new Set<string>()
  /** A promote waiting on the create on its way holds the slot for that moment. */
  const draftPromotions = new Set<string>()
  let initializeRequest: Promise<void> | null = null
  let selectionVersion = 0
  let persistenceVersion = 0

  const describeError = (error: unknown) => error instanceof Error ? error.message : String(error)

  /**
   * Creates the session a draft slot already owns. The slot is written before this runs, so the home
   * composer keeps whatever the reader typed whichever way the create goes: a failure leaves the slot
   * and flags a retry instead of throwing the draft away.
   */
  function createDraftSession(cwd: string, sessionId: string): Promise<void> {
    const request = (async () => {
      try {
        await api.createSession(cwd, sessionId)
        // A promote during the round trip hands the session to the tab; only a draft nobody is
        // waiting for any more is worth discarding.
        if (
          get().draftSessionByCwd[cwd] === sessionId &&
          (draftLeases.get(cwd) ?? 0) === 0 &&
          !draftPromotions.has(cwd)
        ) {
          set(dropDraftSlot(cwd, sessionId))
          await api.discardDraftSession(sessionId)
          return
        }
        set((state) => ({
          draftSessionErrorByCwd: { ...state.draftSessionErrorByCwd, [cwd]: undefined }
        }))
        if (!get().runtime[sessionId]) return
        try {
          await get().loadControls(sessionId)
        } catch (error) {
          get().setControlsStatus(sessionId, { controlsError: describeError(error) })
        }
      } catch (error) {
        if (get().draftSessionByCwd[cwd] !== sessionId) return
        // Nobody is holding this draft any more: a slot left behind would keep a session main never
        // made alive for good, and there is no composer left to report the failure to.
        if ((draftLeases.get(cwd) ?? 0) === 0) {
          draftRetry.delete(cwd)
          set((state) => ({
            ...dropDraftSlot(cwd, sessionId)(state),
            draftSessionErrorByCwd: { ...state.draftSessionErrorByCwd, [cwd]: undefined }
          }))
          void api.discardDraftSession(sessionId).catch(() => {})
          return
        }
        draftRetry.add(cwd)
        set((state) => ({
          draftSessionErrorByCwd: { ...state.draftSessionErrorByCwd, [cwd]: describeError(error) }
        }))
      }
    })().finally(() => {
      if (draftCreation.get(cwd) === request) draftCreation.delete(cwd)
    })
    draftCreation.set(cwd, request)
    return request
  }

  function persist(request: Promise<void>): void {
    const version = ++persistenceVersion
    void request.then(
      () => {
        if (version === persistenceVersion) set({ workspaceError: null })
      },
      (error: unknown) => {
        if (version === persistenceVersion) set({ workspaceError: describeError(error) })
      }
    )
  }

  /** What a worktree was left on: its active session, and the tab the strip was showing. */
  function persistSelection(cwd: string, sessionId: string | null, activeTabId: string | null): void {
    persist(api.selectOpenProjectWorkspace(cwd, sessionId, activeTabId))
  }

  /**
   * The strip and the per-worktree memory move together: every place a tab becomes active goes through
   * here, so a worktree switched away from and back again returns to the tab it was left on — a changes
   * tab included, which no session id can stand in for. `selectProjectCwd` reads the memory back, guarded
   * by the tab still being open.
   */
  function activeTabPatch(
    state: SessionsStore,
    tabId: string | null,
    cwd: string | null
  ): Partial<SessionsStore> {
    return {
      activeTabId: tabId,
      activeTabByCwd: tabId && cwd ? { ...state.activeTabByCwd, [cwd]: tabId } : state.activeTabByCwd
    }
  }

  /** The renderer owns the changes tab, so whether one worktree keeps it open is mirrored here. */
  function persistChangesTab(cwd: string): void {
    const open = get().openTabs.some((tab) => tab.kind === 'diff' && tab.cwd === cwd)
    persist(api.saveOpenProjectChangesTab(cwd, open, get().activeTabId))
  }

  function addReadyTab(tab: OpenTab, selection: number): boolean {
    let added = false
    set((state) => {
      const existing = state.openTabs.some((item) => item.id === tab.id)
      added = !existing
      const project = tab.kind === 'project'
      return {
        openTabs: existing ? state.openTabs : [...state.openTabs, tab],
        ...(selection === selectionVersion ? activeTabPatch(state, tab.id, project ? tab.cwd : null) : {}),
        currentProjectCwd: selection === selectionVersion
          ? (project ? tab.cwd : null)
          : state.currentProjectCwd,
        activeSessionByCwd: project && selection === selectionVersion
          ? { ...state.activeSessionByCwd, [tab.cwd]: tab.id }
          : state.activeSessionByCwd,
        runtime: existing || state.runtime[tab.id]
          ? state.runtime
          : { ...state.runtime, [tab.id]: emptyRuntime() }
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
    activeTabId: null,
    currentProjectCwd: null,
    activeSessionByCwd: {},
    activeTabByCwd: {},
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
          if (sessionIds.length === 0 && !workspace.changesOpen) return []
          return [{
            cwd: workspace.cwd,
            sessionIds,
            changesOpen: workspace.changesOpen,
            activeSessionId: sessionIds.includes(workspace.activeSessionId ?? '')
              ? workspace.activeSessionId
              : sessionIds.at(-1) ?? null,
            activeTabId: workspace.activeTabId
          }]
        })
        const currentProjectCwd = persisted.currentCwd && worktreeCwds.has(persisted.currentCwd)
          ? persisted.currentCwd
          : null
        const restoredTabs: OpenTab[] = workspaces.flatMap((workspace) => [
          ...workspace.sessionIds.flatMap((id) => {
            const meta = metas.get(id)
            return meta ? [{
              id,
              cwd: workspace.cwd,
              title: sessionTitle(meta),
              kind: 'project' as const,
              loadState: 'cold' as const,
              meta
            }] : []
          }),
          ...(workspace.changesOpen
            ? [{
                id: changesTabId(workspace.cwd),
                cwd: workspace.cwd,
                title: SCOPE_LABELS[DEFAULT_SCOPE],
                kind: 'diff' as const,
                loadState: 'ready' as const,
                diffScope: DEFAULT_SCOPE
              }]
            : [])
        ])
        const activeSessionByCwd = Object.fromEntries(
          workspaces.map((workspace) => [workspace.cwd, workspace.activeSessionId])
        )
        const activeSessionId = currentProjectCwd
          ? activeSessionByCwd[currentProjectCwd] ?? null
          : null
        // What each worktree was left on, kept only where that tab actually came back: this is the memory
        // `selectProjectCwd` reads, so a worktree the reader has not visited yet still opens its own tab.
        const restoredIds = new Set(restoredTabs.map((tab) => tab.id))
        const restoredActiveTabs = Object.fromEntries(
          workspaces.flatMap((workspace) =>
            workspace.activeTabId && restoredIds.has(workspace.activeTabId)
              ? [[workspace.cwd, workspace.activeTabId] as const]
              : []
          )
        )
        const restoredActiveTabId = currentProjectCwd ? restoredActiveTabs[currentProjectCwd] : undefined
        const activeTabId = restoredActiveTabId ?? activeSessionId

        const selectionUnchanged = restoreSelection === selectionVersion
        set((state) => {
          const restoredIds = new Set(restoredTabs.map((tab) => tab.id))
          const projectTabs = [
            ...restoredTabs,
            ...state.openTabs.filter(
              (tab) =>
                (tab.kind === 'project' || tab.kind === 'diff' || tab.kind === 'file') &&
                !restoredIds.has(tab.id)
            )
          ]
          return {
            openTabs: [...state.openTabs.filter((tab) => tab.kind === 'chat'), ...projectTabs],
            activeSessionByCwd: selectionUnchanged
              ? activeSessionByCwd
              : { ...activeSessionByCwd, ...state.activeSessionByCwd },
            activeTabByCwd: selectionUnchanged
              ? restoredActiveTabs
              : { ...restoredActiveTabs, ...state.activeTabByCwd },
            currentProjectCwd: selectionUnchanged ? currentProjectCwd : state.currentProjectCwd,
            activeTabId: selectionUnchanged ? activeTabId : state.activeTabId,
            workspaceRestoreReady: true,
            workspaceRestoreError: null
          }
        })

        if (selectionUnchanged && activeTabId) {
          await get().activateTab(activeTabId)
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
      const state = get()
      const sessionId = state.activeSessionByCwd[cwd] ?? null
      const remembered = state.activeTabByCwd[cwd]
      // The tab this worktree was left on wins over its session, as long as it is still open: that is how a
      // changes tab comes back instead of the session tab taking its place (and its persisted slot).
      const tabId = remembered && state.openTabs.some((tab) => tab.id === remembered) ? remembered : sessionId
      set((current) => ({
        currentProjectCwd: cwd,
        ...activeTabPatch(current, tabId, cwd)
      }))
      persistSelection(cwd, sessionId, tabId)
      try {
        await get().loadWorktreeSessions(cwd)
      } catch (error) {
        if (selection === selectionVersion) set({ workspaceError: describeError(error) })
      }
      if (tabId && selection === selectionVersion) await get().activateTab(tabId)
    },

    activateTab: async (tabId) => {
      const tab = get().openTabs.find((item) => item.id === tabId)
      if (!tab) return
      if (tab.kind === 'diff') {
        // Nothing to load: the patch is the panel's data, and the worktree watch is already running.
        // The version bump keeps a session opening behind this click from stealing the strip back.
        ++selectionVersion
        set((state) => ({
          ...activeTabPatch(state, tab.id, tab.cwd),
          currentProjectCwd: tab.cwd,
          openTabs: state.openTabs
        }))
        persistChangesTab(tab.cwd)
        return
      }
      if (tab.kind === 'file') {
        // A file tab owns no session either: its bytes belong to the files store, which reads them when
        // the view mounts. Nothing here is persisted, because a file tab is not part of what a worktree
        // remembers across launches — only the strip's own memory of it within this run.
        ++selectionVersion
        set((state) => ({
          ...activeTabPatch(state, tab.id, tab.cwd),
          currentProjectCwd: tab.cwd,
          openTabs: state.openTabs
        }))
        return
      }
      if (tab.kind === 'project' && get().draftSessionByCwd[tab.cwd] === tab.id) {
        await get().promoteProjectDraft(tab.cwd, tab.id)
        return
      }
      const selection = ++selectionVersion
      if (get().activeTabId === tab.id && tab.loadState === 'ready') return
      set((state) => ({
        ...activeTabPatch(state, tab.id, tab.kind === 'project' ? tab.cwd : null),
        currentProjectCwd: tab.kind === 'project' ? tab.cwd : null,
        activeSessionByCwd: tab.kind === 'project'
          ? { ...state.activeSessionByCwd, [tab.cwd]: tab.id }
          : state.activeSessionByCwd,
        openTabs: state.openTabs.map((item) =>
          item.id === tab.id && (item.loadState === 'cold' || item.loadState === 'error')
            ? { ...item, loadState: 'opening', loadError: undefined }
            : item
        )
      }))
      if (tab.kind === 'project') persistSelection(tab.cwd, tab.id, tab.id)
      if (tab.loadState === 'ready' || tab.loadState === 'opening') return
      if (!tab.meta) {
        set((state) => ({
          openTabs: state.openTabs.map((item) => item.id === tab.id
            ? { ...item, loadState: 'error', loadError: '会话文件不存在' }
            : item)
        }))
        return
      }

      const sessionId = tab.id
      try {
        const ref = await openRef(tab.meta)
        const current = get().openTabs.find((item) => item.id === sessionId)
        if (!current) {
          await api.closeSession(ref.sessionId)
          return
        }
        set((state) => state.runtime[sessionId] ? state : {
          runtime: { ...state.runtime, [sessionId]: emptyRuntime() }
        })
        await get().hydrateTurns(ref.sessionId, { display: ref.display })
        set((state) => ({
          openTabs: state.openTabs.map((item) => item.id === sessionId
            ? { ...item, loadState: 'ready', loadError: undefined }
            : item)
        }))
        if (selection !== selectionVersion && get().currentProjectCwd) {
          const cwd = get().currentProjectCwd!
          persistSelection(cwd, get().activeSessionByCwd[cwd] ?? null, get().activeTabByCwd[cwd] ?? null)
        }
      } catch (error) {
        set((state) => ({
          openTabs: state.openTabs.map((item) => item.id === sessionId
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

    /**
     * One changes tab per worktree, so a row in the review column switches the tab it already opened
     * instead of adding a second one: the group the row was read under becomes the tab's scope.
     */
    openChangesTab: async (cwd, path, scope) => {
      const id = changesTabId(cwd)
      const next = scope ?? DEFAULT_SCOPE
      set((state) => state.openTabs.some((tab) => tab.id === id)
        ? {
            openTabs: state.openTabs.map((tab) =>
              tab.id === id && tab.diffScope !== next
                ? { ...tab, diffScope: next, title: SCOPE_LABELS[next] }
                : tab
            )
          }
        : {
            openTabs: [...state.openTabs, {
              id,
              cwd,
              title: SCOPE_LABELS[next],
              kind: 'diff' as const,
              loadState: 'ready' as const,
              diffScope: next
            }]
          })
      // The panel points at a file through the tab's own focus, which the tab clears by scrolling.
      if (path) useDiffStore.getState().focusPath(cwd, path)
      await get().activateTab(id)
    },

    setChangesScope: (cwd, scope) => {
      const id = changesTabId(cwd)
      set((state) => ({
        openTabs: state.openTabs.map((tab) =>
          tab.id === id ? { ...tab, diffScope: scope, title: SCOPE_LABELS[scope] } : tab
        )
      }))
    },

    /**
     * One tab per file, and the title is the file's own name: the path lives in the worktree, so two
     * worktrees can hold the same relative path without sharing a tab.
     */
    openFileTab: async (cwd, path) => {
      const id = fileTabId(cwd, path)
      if (!get().openTabs.some((tab) => tab.id === id)) {
        set((state) => ({
          openTabs: [...state.openTabs, {
            id,
            cwd,
            path,
            title: path.slice(path.lastIndexOf('/') + 1),
            kind: 'file' as const,
            loadState: 'ready' as const
          }]
        }))
      }
      await get().activateTab(id)
    },

    openExisting: async (meta, kind: 'project' | 'chat' = 'project') => {
      const existing = get().openTabs.find((tab) => tab.meta?.path === meta.path || tab.id === meta.id)
      if (existing) {
        await get().activateTab(existing.id)
        return
      }
      if (kind === 'project' && get().draftSessionByCwd[meta.cwd] === meta.id) {
        await get().promoteProjectDraft(meta.cwd, meta.id)
        set((state) => ({
          openTabs: state.openTabs.map((tab) => tab.id === meta.id
            ? { ...tab, title: sessionTitle(meta), meta }
            : tab)
        }))
        return
      }
      const selection = ++selectionVersion
      const ref = await openRef(meta)
      const added = addReadyTab({
        id: ref.sessionId,
        cwd: ref.cwd,
        title: sessionTitle(meta),
        kind,
        loadState: 'ready',
        meta
      }, selection)
      if (kind === 'project' && selection === selectionVersion) {
        persistSelection(ref.cwd, ref.sessionId, ref.sessionId)
      }
      if (added) await hydrateReady(ref)
    },

    acquireProjectDraft: (cwd) => {
      draftLeases.set(cwd, (draftLeases.get(cwd) ?? 0) + 1)
      if (draftCreation.has(cwd)) return
      const existing = get().draftSessionByCwd[cwd]
      const retry = draftRetry.delete(cwd)
      if (existing && !retry) return
      // The id is minted before the round trip: the home composer holds one slot from its first
      // render until the draft becomes a tab, so nothing has to be carried over in between.
      const sessionId = existing ?? newSessionId()
      set((state) => ({
        draftSessionByCwd: { ...state.draftSessionByCwd, [cwd]: sessionId },
        draftSessionErrorByCwd: { ...state.draftSessionErrorByCwd, [cwd]: undefined },
        runtime: { ...state.runtime, [sessionId]: state.runtime[sessionId] ?? emptyRuntime() }
      }))
      void createDraftSession(cwd, sessionId)
    },

    releaseProjectDraft: (cwd) => {
      const leases = Math.max(0, (draftLeases.get(cwd) ?? 0) - 1)
      if (leases > 0) {
        draftLeases.set(cwd, leases)
        return
      }
      draftLeases.delete(cwd)
      draftRetry.delete(cwd)
      // An in-flight create settles its own slot: the session does not exist in main yet, and the
      // id is already public, so a discard here would race with whoever takes the draft next.
      if (draftCreation.has(cwd)) return
      const sessionId = get().draftSessionByCwd[cwd]
      if (!sessionId) return
      set((state) => ({
        ...dropDraftSlot(cwd, sessionId)(state),
        draftSessionErrorByCwd: { ...state.draftSessionErrorByCwd, [cwd]: undefined }
      }))
      void api.discardDraftSession(sessionId).catch((error: unknown) => {
        set({ workspaceError: describeError(error) })
      })
    },

    promoteProjectDraft: async (cwd, sessionId) => {
      if (get().draftSessionByCwd[cwd] !== sessionId) return false
      // The session may not exist in main yet: wait for the create on its way, and try once more if
      // the last one failed, which the slot survived so the composer keeps its text.
      const creating = draftCreation.get(cwd)
      if (creating) {
        draftPromotions.add(cwd)
        try {
          await creating
        } finally {
          draftPromotions.delete(cwd)
        }
      }
      if (draftRetry.has(cwd)) {
        draftRetry.delete(cwd)
        await createDraftSession(cwd, sessionId)
        if (draftRetry.has(cwd)) return false
      }
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
          draftRetry.add(cwd)
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
        id: sessionId,
        cwd,
        title: EMPTY_SESSION_TITLE,
        kind: 'project',
        loadState: 'ready'
      }, selection)
      if (selection === selectionVersion) persistSelection(cwd, sessionId, sessionId)
      return selection === selectionVersion
    },

    newSession: async (cwd) => {
      const draftSessionId = get().draftSessionByCwd[cwd]
      if (draftSessionId) {
        return await get().promoteProjectDraft(cwd, draftSessionId) ? draftSessionId : null
      }
      const selection = ++selectionVersion
      const ref = await api.createSession(cwd, newSessionId())
      try {
        await api.promoteSession(ref.sessionId)
      } catch (error) {
        await api.discardDraftSession(ref.sessionId)
        throw error
      }
      const added = addReadyTab({
        id: ref.sessionId,
        cwd: ref.cwd,
        title: EMPTY_SESSION_TITLE,
        kind: 'project',
        loadState: 'ready'
      }, selection)
      if (selection === selectionVersion) persistSelection(ref.cwd, ref.sessionId, ref.sessionId)
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
        id: ref.sessionId,
        cwd: ref.cwd,
        title: EMPTY_SESSION_TITLE,
        kind: 'chat',
        loadState: 'ready'
      }, selection)) {
        await get().loadControls(ref.sessionId)
      }
    },

    closeTab: (tabId) => {
      const tab = get().openTabs.find((item) => item.id === tabId)
      if (!tab) return
      if (tab.kind === 'diff') {
        // A diff tab owns no session: closing it hands the strip back to the worktree's session.
        const fallback = get().activeSessionByCwd[tab.cwd] ?? null
        const wasActive = get().activeTabId === tab.id
        set((state) => ({
          openTabs: state.openTabs.filter((item) => item.id !== tabId),
          ...(wasActive ? activeTabPatch(state, fallback, tab.cwd) : {})
        }))
        persistChangesTab(tab.cwd)
        if (wasActive && fallback) void get().activateTab(fallback)
        return
      }
      if (tab.kind === 'file') {
        // No session to close: the tab goes, the file store keeps a draft nobody has saved yet and lets
        // a clean document go. The strip falls back to a tab of the same worktree, or to its session.
        const state = get()
        const fallback = state.openTabs.filter((item) => item.id !== tabId && item.cwd === tab.cwd).at(-1)?.id
          ?? state.activeSessionByCwd[tab.cwd]
          ?? null
        const wasActive = state.activeTabId === tab.id
        set((current) => ({
          openTabs: current.openTabs.filter((item) => item.id !== tabId),
          ...(wasActive ? activeTabPatch(current, fallback, tab.cwd) : {})
        }))
        if (tab.path) useFilesStore.getState().releaseDocument(tab.cwd, tab.path)
        if (wasActive && fallback) void get().activateTab(fallback)
        return
      }
      if (closing.has(tabId)) return
      const state = get()
      const remainingInScope = state.openTabs.filter((item) =>
        item.id !== tabId && item.kind === tab.kind &&
        (tab.kind === 'chat' || item.cwd === tab.cwd)
      )
      const fallback = remainingInScope.at(-1)?.id ?? null
      if (state.activeTabId === tabId) selectionVersion++
      set((current) => {
        const openTabs = current.openTabs.filter((item) => item.id !== tabId)
        const runtime = { ...current.runtime }
        delete runtime[tabId]
        const activeSessionByCwd = tab.kind === 'project' && current.activeSessionByCwd[tab.cwd] === tabId
          ? { ...current.activeSessionByCwd, [tab.cwd]: fallback }
          : current.activeSessionByCwd
        return {
          openTabs,
          runtime,
          activeSessionByCwd,
          ...(current.activeTabId === tabId
            ? activeTabPatch(current, fallback, tab.kind === 'project' ? tab.cwd : null)
            : {})
        }
      })
      const sessionId = tabId
      const request = api.closeSession(sessionId)
      closing.set(sessionId, request)
      void request.then(() => {
        if (tab.kind === 'project' && get().currentProjectCwd === tab.cwd) {
          // The memory is already on whatever closeTab handed the strip to, which is what gets mirrored.
          persistSelection(
            tab.cwd,
            get().activeSessionByCwd[tab.cwd] ?? null,
            get().activeTabByCwd[tab.cwd] ?? null
          )
        }
      }, (error: unknown) => {
        set({ workspaceError: describeError(error) })
      }).finally(() => {
        if (closing.get(sessionId) === request) closing.delete(sessionId)
      })
      if (fallback && state.activeTabId === tabId) void get().activateTab(fallback)
    },

    setActive: (tabId) => {
      if (!get().openTabs.some((tab) => tab.id === tabId)) return
      void get().activateTab(tabId)
    },

    renameTab: (tabId, title) => set((state) => ({
      openTabs: state.openTabs.map((tab) => tab.id === tabId ? { ...tab, title } : tab)
    })),

    previewSessionTitle: (sessionId, title) => set((state) => ({
      openTabs: state.openTabs.map((tab) =>
        tab.id === sessionId && isPlaceholderSessionTitle(tab.title)
          ? { ...tab, title }
          : tab
      ),
      projects: fillEmptySessionTitle(state.projects, sessionId, title),
      chats: fillEmptySessionTitle(state.chats, sessionId, title)
    }))
  }
}
