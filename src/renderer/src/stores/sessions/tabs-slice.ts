/** Tab lifecycle, project-workspace restoration, and lazy session loading. */
import { api, type DiffScope, type OpenSessionRef, type SessionMeta } from '../../ipc/api'
import { scopeLabel, useDiffStore } from '../diff'
import { useFilesStore } from '../files'
import { newSessionId } from '../../lib/session-id'
import { changesTabId } from '../../../../shared/tab-ids'
import { t } from '../../lib/i18n'
import { fillEmptySessionTitle } from './catalog'
import { emptyRuntime } from './runtime'
import { fallbackTitle, isPlaceholderSessionTitle, sessionTitle } from './session-title'
import { applyVisibleOrder, neighbourAmong, neighbourTab, persistableIds, sameScopeTabs } from './tab-order'
import type { OpenTab, SessionsStore, SessionSlice } from './types'

/** The scope a changes tab starts on, and what a workspace restored without one shows. */
const DEFAULT_SCOPE: DiffScope = 'all'

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
  | 'restoredProjectCwd'
  | 'activeSessionByCwd'
  | 'activeTabByCwd'
  | 'draftSessionByCwd'
  | 'draftSessionErrorByCwd'
  | 'chatDraft'
  | 'chatDraftError'
  | 'workspaceRestoreReady'
  | 'workspaceRestoreError'
  | 'workspaceError'
  | 'initializeProjectWorkspaces'
  | 'setWorkspaceRestoreMode'
  | 'selectProjectCwd'
  | 'activateTab'
  | 'openExisting'
  | 'openChangesTab'
  | 'openFileTab'
  | 'setChangesScope'
  | 'acquireProjectDraft'
  | 'releaseProjectDraft'
  | 'promoteDraft'
  | 'acquireChatDraft'
  | 'releaseChatDraft'
  | 'retryChatDraft'
  | 'focusChatHome'
  | 'invalidateSelection'
  | 'newSession'
  | 'newChat'
  | 'closeTab'
  | 'reorderTabs'
  | 'persistOpenChatTabs'
  | 'setActive'
  | 'renameTab'
  | 'relabelTabs'
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
  /** Holders of the chat home's draft, and the create on its way: the slot waits for main's answer. */
  let chatLeases = 0
  let chatCreating: Promise<void> | null = null
  let initializeRequest: Promise<void> | null = null
  let restoreInChatHome = false
  let restoreProjectAfterSwitch = false
  let selectionVersion = 0
  let persistenceVersion = 0
  const closedChatIdsBeforeRestore = new Set<string>()
  let lastActiveChatTabId: string | null = null

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
   * The chats half's open tabs, with their order and which of them the pane was showing. Unlike a
   * worktree's, this list is both membership and arrangement: no other record says a chat was open at
   * all. Nothing here waits for the write — a chat whose id outlives its directory is dropped by the
   * restore rather than reported, so a delete that lands before this does can only leave a stale id.
   */
  function persistChatTabs(closedIds: string[] = []): void {
    const state = get()
    const active = state.openTabs.find((tab) => tab.id === state.activeTabId)
    if (active?.kind === 'chat') lastActiveChatTabId = active.id
    // Until a successful scan merges saved membership, record intent without replacing the saved list.
    // These tombstones survive failed scans so a retry cannot reopen a tab the reader already closed.
    if (!state.workspaceRestoreReady) {
      for (const id of closedIds) closedChatIdsBeforeRestore.add(id)
      return
    }
    const ids = state.openTabs.filter((tab) => tab.kind === 'chat').map((tab) => tab.id)
    persist(api.saveOpenChatTabs(ids, ids.includes(lastActiveChatTabId ?? '') ? lastActiveChatTabId : null))
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
    if (tab.kind === 'chat') {
      closedChatIdsBeforeRestore.delete(tab.id)
      persistChatTabs()
    }
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

  /**
   * The chat home's session. Main mints both the id and the directory, so the slot waits for the
   * round trip; a lease that has gone by then takes the chat with it rather than leaving it behind.
   */
  const createChatDraft = (): Promise<void> => {
    if (get().chatDraft || chatCreating) return Promise.resolve()
    const request = (async () => {
      try {
        const ref = await api.createChat()
        if (chatLeases === 0) {
          await api.deleteChat(ref.cwd)
          return
        }
        set((state) => ({
          chatDraft: ref,
          chatDraftError: null,
          runtime: { ...state.runtime, [ref.sessionId]: state.runtime[ref.sessionId] ?? emptyRuntime() }
        }))
        try {
          await get().loadControls(ref.sessionId)
        } catch (error) {
          get().setControlsStatus(ref.sessionId, { controlsError: describeError(error) })
        }
      } catch (error) {
        if (chatLeases > 0) set({ chatDraftError: describeError(error) })
      }
    })().finally(() => {
      if (chatCreating === request) chatCreating = null
    })
    chatCreating = request
    return request
  }

  return {
    openTabs: [],
    activeTabId: null,
    currentProjectCwd: null,
    restoredProjectCwd: null,
    activeSessionByCwd: {},
    activeTabByCwd: {},
    draftSessionByCwd: {},
    draftSessionErrorByCwd: {},
    chatDraft: null,
    chatDraftError: null,
    workspaceRestoreReady: false,
    workspaceRestoreError: null,
    workspaceError: null,

    initializeProjectWorkspaces: (startInChatHome = false) => {
      if (get().workspaceRestoreReady) return Promise.resolve()
      if (initializeRequest) return initializeRequest
      restoreInChatHome = startInChatHome
      restoreProjectAfterSwitch = false
      const restoreSelection = selectionVersion
      set({ workspaceRestoreError: null })
      initializeRequest = (async () => {
        const [persisted] = await Promise.all([
          api.getOpenProjectSessions(),
          get().loadProjects(),
          // The chats half's tabs are restored here too, and a chat tab needs its listing for a title and
          // a path to load from: one scan for both halves is what keeps the restore a single step.
          get().loadChats()
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
        const chatMetas = new Map(get().chats.flatMap((chat) => chat.sessions.map((meta) => [meta.id, meta] as const)))

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
            activeTabId: workspace.activeTabId,
            tabOrder: workspace.tabOrder ?? []
          }]
        })
        const currentProjectCwd = persisted.currentCwd && worktreeCwds.has(persisted.currentCwd)
          ? persisted.currentCwd
          : null
        const restoredTabs: OpenTab[] = workspaces.flatMap((workspace) => {
          const byId = new Map<string, OpenTab>()
          for (const id of workspace.sessionIds) {
            const meta = metas.get(id)
            if (meta) {
              byId.set(id, {
                id,
                cwd: workspace.cwd,
                title: sessionTitle(meta),
                kind: 'project' as const,
                loadState: 'cold' as const,
                meta
              })
            }
          }
          if (workspace.changesOpen) {
            byId.set(changesTabId(workspace.cwd), {
              id: changesTabId(workspace.cwd),
              cwd: workspace.cwd,
              title: scopeLabel(t, DEFAULT_SCOPE),
              kind: 'diff' as const,
              loadState: 'ready' as const,
              diffScope: DEFAULT_SCOPE
            })
          }
          // The dragged order leads, and whatever it never mentions follows in its own arrival order —
          // which for a worktree nobody has ever dragged is sessions then changes, as it always was.
          const ordered = [...new Set(workspace.tabOrder.filter((id) => byId.has(id)))]
          return [...ordered, ...[...byId.keys()].filter((id) => !ordered.includes(id))]
            .map((id) => byId.get(id)!)
        })
        // A chat whose directory is gone has no listing to give it a title or a file to open, so the
        // sweep at startup and a deleted chat leave this list shorter and nobody the wiser.
        const restoredChatTabs: OpenTab[] = persisted.chatOrder.flatMap((id) => {
          if (closedChatIdsBeforeRestore.has(id)) return []
          const meta = chatMetas.get(id)
          return meta ? [{
            id,
            cwd: meta.cwd,
            title: sessionTitle(meta),
            kind: 'chat' as const,
            loadState: 'cold' as const,
            meta
          }] : []
        })
        const restoredChatIds = new Set(restoredChatTabs.map((tab) => tab.id))
        const restoredActiveChatTabId =
          persisted.activeChatTabId && restoredChatIds.has(persisted.activeChatTabId)
            ? persisted.activeChatTabId
            : null
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
        const activeProjectTabId = restoredActiveTabId ?? activeSessionId
        // The chats half restores a tab the way a worktree does: the one it was left on, if it came back.
        // Only with none to show does it fall to its home, so `startInChatHome` now means "the chats half
        // was showing something", not "it was showing the greeting" — a restored chat takes the pane.
        const restoreChats = restoreInChatHome || currentProjectCwd === null
        const restoredTabId = restoreChats ? restoredActiveChatTabId : activeProjectTabId

        const selectionUnchanged = restoreSelection === selectionVersion
        const restoreSelectedProject = selectionUnchanged || (
          !restoreInChatHome && restoreProjectAfterSwitch && !get().currentProjectCwd && !get().activeTabId
        )
        set((state) => {
          const liveTabs = new Map(state.openTabs.map((tab) => [tab.id, tab]))
          const restoredIds = new Set(restoredTabs.map((tab) => tab.id))
          const projectTabs = [
            ...restoredTabs.map((tab) => liveTabs.get(tab.id) ?? tab),
            ...state.openTabs.filter(
              (tab) =>
                (tab.kind === 'project' || tab.kind === 'diff' || tab.kind === 'file') &&
                !restoredIds.has(tab.id)
            )
          ]
          return {
            openTabs: [
              ...restoredChatTabs.map((tab) => liveTabs.get(tab.id) ?? tab),
              ...state.openTabs.filter((tab) => tab.kind === 'chat' && !restoredChatIds.has(tab.id)),
              ...projectTabs
            ],
            activeSessionByCwd: selectionUnchanged
              ? activeSessionByCwd
              : { ...activeSessionByCwd, ...state.activeSessionByCwd },
            activeTabByCwd: selectionUnchanged
              ? restoredActiveTabs
              : { ...restoredActiveTabs, ...state.activeTabByCwd },
            restoredProjectCwd: currentProjectCwd,
            currentProjectCwd: restoreSelectedProject
              ? (restoreChats ? null : currentProjectCwd)
              : state.currentProjectCwd,
            activeTabId: restoreSelectedProject ? restoredTabId : state.activeTabId,
            workspaceRestoreReady: true,
            workspaceRestoreError: null
          }
        })

        closedChatIdsBeforeRestore.clear()
        lastActiveChatTabId ??= restoredActiveChatTabId
        const activeChat = get().openTabs.find((tab) => tab.id === get().activeTabId && tab.kind === 'chat')
        if (activeChat) lastActiveChatTabId = activeChat.id
        // Membership, order and selection can all change while writes are gated by the scan.
        // Write the merged state before hydration, which is not a prerequisite for remembering a tab.
        const mergedChats = get().openTabs.filter((tab) => tab.kind === 'chat').map((tab) => tab.id)
        const mergedActiveChatId = mergedChats.includes(lastActiveChatTabId ?? '') ? lastActiveChatTabId : null
        const changedWhileScanning = mergedChats.length !== persisted.chatOrder.length ||
          mergedChats.some((id, index) => persisted.chatOrder[index] !== id) ||
          mergedActiveChatId !== persisted.activeChatTabId
        if (changedWhileScanning) persistChatTabs()
        if (restoreSelectedProject && restoredTabId) {
          await get().activateTab(restoredTabId)
        }
      })().catch((error: unknown) => {
        // A failed scan stays retryable: the restore only counts as done once it actually succeeded.
        set({ workspaceRestoreError: describeError(error) })
      }).finally(() => {
        initializeRequest = null
      })
      return initializeRequest
    },

    setWorkspaceRestoreMode: (startInChatHome) => {
      if (!initializeRequest) return
      // A switch back to Projects can undo the chat-home selection made during this scan, but not a
      // real tab or worktree selection the reader made afterward.
      restoreInChatHome = startInChatHome
      restoreProjectAfterSwitch = !startInChatHome && !get().currentProjectCwd && !get().activeTabId
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
        await get().promoteDraft(tab.cwd, tab.id)
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
      // A chat half has no per-worktree memory to mirror, so the strip's own choice is written whole.
      else if (tab.kind === 'chat') persistChatTabs()
      if (tab.loadState === 'ready' || tab.loadState === 'opening') return
      if (!tab.meta) {
        set((state) => ({
          openTabs: state.openTabs.map((item) => item.id === tab.id
            ? { ...item, loadState: 'error', loadError: t('sessions.fileMissing') }
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
                ? { ...tab, diffScope: next, title: scopeLabel(t, next) }
                : tab
            )
          }
        : {
            openTabs: [...state.openTabs, {
              id,
              cwd,
              title: scopeLabel(t, next),
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
          tab.id === id ? { ...tab, diffScope: scope, title: scopeLabel(t, scope) } : tab
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
        await get().promoteDraft(meta.cwd, meta.id)
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

    acquireChatDraft: () => {
      chatLeases += 1
      void createChatDraft()
    },

    retryChatDraft: () => {
      if (chatLeases > 0) void createChatDraft()
    },

    releaseChatDraft: () => {
      chatLeases = Math.max(0, chatLeases - 1)
      if (chatLeases > 0) return
      const draft = get().chatDraft
      set({ chatDraftError: null })
      // A chat that was sent to is a tab by then, and the slot is what says a draft is still to take
      // back: nothing here can reach a chat the reader has kept.
      if (!draft) return
      set((state) => {
        const runtime = { ...state.runtime }
        delete runtime[draft.sessionId]
        return { chatDraft: null, runtime }
      })
      void api.deleteChat(draft.cwd).catch((error: unknown) => {
        set({ workspaceError: describeError(error) })
      })
    },

    focusChatHome: () => {
      // Leaving the worktree is a selection of its own: work started for the old one must not land,
      // and its leftovers are not the chat home's news.
      ++selectionVersion
      set((state) => ({
        currentProjectCwd: null,
        workspaceError: null,
        ...activeTabPatch(state, null, null)
      }))
    },

    invalidateSelection: () => {
      ++selectionVersion
    },

    promoteDraft: async (cwd, sessionId) => {
      // The chat home's draft has no worktree behind it: main already holds the session, so promoting
      // it only means giving it the tab the chats half was missing.
      const chat = get().chatDraft
      if (chat?.sessionId === sessionId) {
        const selection = ++selectionVersion
        set({ chatDraft: null })
        addReadyTab({
          id: chat.sessionId,
          cwd: chat.cwd,
          title: t('sessions.newTitle'),
          kind: 'chat',
          loadState: 'ready'
        }, selection)
        return selection === selectionVersion
      }
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
        title: t('sessions.newTitle'),
        kind: 'project',
        loadState: 'ready'
      }, selection)
      if (selection === selectionVersion) persistSelection(cwd, sessionId, sessionId)
      return selection === selectionVersion
    },

    newSession: async (cwd) => {
      const draftSessionId = get().draftSessionByCwd[cwd]
      if (draftSessionId) {
        return await get().promoteDraft(cwd, draftSessionId) ? draftSessionId : null
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
        title: t('sessions.newTitle'),
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
        title: t('sessions.newTitle'),
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
        // A diff tab owns no session: closing it hands the strip back to a neighbour, and the worktree's
        // session is the last one standing when nothing else of it is open.
        const strip = get()
        const fallback = neighbourTab(strip.openTabs, tab)?.id ?? strip.activeSessionByCwd[tab.cwd] ?? null
        const wasActive = strip.activeTabId === tab.id
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
        // a clean document go. The strip falls back to its neighbour, or to the worktree's session.
        const state = get()
        const fallback = neighbourTab(state.openTabs, tab)?.id
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
      // Two memories, two rules. The strip falls to the neighbour it sat next to, whatever kind of tab
      // that is; the worktree's session memory only ever holds a session, so it falls to the neighbour
      // among the sessions — a changes tab cannot stand in for one when `selectProjectCwd` reads it back
      // or main records it as this worktree's active session.
      const fallback = neighbourTab(state.openTabs, tab)?.id ?? null
      const fallbackSession = neighbourAmong(state.openTabs, tab, (item) => item.kind === tab.kind)?.id ?? null
      if (state.activeTabId === tabId) selectionVersion++
      set((current) => {
        const openTabs = current.openTabs.filter((item) => item.id !== tabId)
        const runtime = { ...current.runtime }
        delete runtime[tabId]
        const activeSessionByCwd = tab.kind === 'project' && current.activeSessionByCwd[tab.cwd] === tabId
          ? { ...current.activeSessionByCwd, [tab.cwd]: fallbackSession }
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
      if (tab.kind === 'chat') persistChatTabs([tab.id])
      if (fallback && state.activeTabId === tabId) void get().activateTab(fallback)
    },

    /**
     * The chats half's list is written whole by whoever holds it, so a membership change made elsewhere —
     * a deleted session, a removed chat — has to hand the strip's new shape over here.
     */
    persistOpenChatTabs: (closedIds) => persistChatTabs(closedIds),

    /**
     * Writes back a dragged half-strip. The ids are the visible sequence in its new arrangement, which
     * lands in the flat list by slot so the other half keeps the positions it has always had; only the
     * persistable ones are handed to main, because a file tab has no record to be ordered in.
     */
    reorderTabs: (visibleIds) => {
      const state = get()
      const openTabs = applyVisibleOrder(state.openTabs, visibleIds)
      if (openTabs === state.openTabs) return
      set({ openTabs })
      // The whole sequence is one half of the strip, so any tab still in it says which one to write.
      const scope = visibleIds
        .map((id) => openTabs.find((tab) => tab.id === id))
        .find((tab) => tab !== undefined)
      if (!scope) return
      if (scope.kind === 'chat') {
        persistChatTabs()
        return
      }
      persist(api.saveOpenProjectTabOrder(
        scope.cwd,
        persistableIds(sameScopeTabs(openTabs, scope))
      ))
    },

    setActive: (tabId) => {
      if (!get().openTabs.some((tab) => tab.id === tabId)) return
      void get().activateTab(tabId)
    },

    renameTab: (tabId, title) => set((state) => ({
      // The bridge delivered a real name: stamp it into the snapshot too, so a later locale
      // switch re-derives from this name instead of clobbering it with stale listing data.
      openTabs: state.openTabs.map((tab) => tab.id === tabId
        ? { ...tab, title, previewFallback: undefined, meta: tab.meta ? { ...tab.meta, name: title } : tab.meta }
        : tab)
    })),

    /**
     * Titles the app derives itself follow the language; names that came from a session or a file
     * keep their text. The diff tab stores its scope, so its title is rebuilt rather than detected.
     */
    relabelTabs: () => set((state) => ({
      openTabs: state.openTabs.map((tab) => {
        if (tab.kind === 'diff') {
          return { ...tab, title: scopeLabel(t, tab.diffScope ?? DEFAULT_SCOPE) }
        }
        // A listing snapshot re-derives locale-made words (the image placeholder, a preview marker)
        // instead of freezing them; user text falls through untouched. The snapshot is fresh by
        // construction: renameTab stamps an outside rename into it, each listing replaces it wholesale.
        if (tab.meta) return { ...tab, title: sessionTitle(tab.meta, tab.title) }
        // A preview title is a marker, not user text: translate it instead of freezing the old word.
        if (tab.previewFallback) return { ...tab, title: fallbackTitle(tab.previewFallback) }
        return isPlaceholderSessionTitle(tab.title) ? { ...tab, title: t('sessions.newTitle') } : tab
      })
    })),

    previewSessionTitle: (sessionId, title, fallback) => set((state) => ({
      // The marker rides on the tab's snapshot as well: without it a later rename-clear would fall
      // back to a frozen word instead of a freshly translated one.
      openTabs: state.openTabs.map((tab) =>
        tab.id === sessionId && isPlaceholderSessionTitle(tab.title)
          ? { ...tab, title, previewFallback: fallback, meta: tab.meta ? { ...tab.meta, previewFallback: fallback } : tab.meta }
          : tab
      ),
      projects: fillEmptySessionTitle(state.projects, sessionId, title, fallback),
      chats: fillEmptySessionTitle(state.chats, sessionId, title, fallback)
    }))
  }
}
