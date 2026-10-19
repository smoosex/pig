import type { StateCreator } from 'zustand'
import type {
  BashExecutionResult,
  DiffScope,
  DisplayTurn,
  DisplayTurnsResult,
  FollowUpAction,
  GenerationStats,
  PromptStreamingBehavior,
  ProjectGroup,
  SessionControls,
  SessionBranchOptions,
  SessionMeta,
  SessionNameUpdate,
  SessionPreviewFallback,
  SessionTokenStats,
  SessionWindowMessage,
  ThinkingLevel,
  TurnSummary
} from '../../ipc/api'
import type { LiveCompaction } from '../../chat/compactions'
import type { ProcessItem, ThinkingDurations, ToolUpdates } from '../../chat/turns'
import type { BashExecutionMessage, PiMessage } from '../../pi/types'

/**
 * A failure the session is recovering from. It is never part of the transcript: the retried request
 * either replaces it with an answer, or leaves the last failed attempt as the turn's own outcome.
 */
export type RetryNotice =
  | {
      kind: 'request'
      attempt: number
      maxAttempts: number
      errorMessage: string
      /** Backoff deadline. Past it the retried request is already in flight and only the count is left. */
      endsAt: number
    }
  | {
      kind: 'summary'
      /**
       * Compaction and branch summaries share one retry budget and one payload shape. Only the
       * attempt-start event says which of them is being retried.
       */
      source: 'summary' | 'compaction' | 'branchSummary'
      attempt: number
      maxAttempts: number
      errorMessage: string
      endsAt: number
    }

export interface RuntimeState extends SessionControls {
  instanceId: number
  controlsRevision: number
  /** A toolbar mutation (model, thinking level, model list) is on its way. */
  controlsPending: boolean
  /** Why the last toolbar mutation failed, if it did. */
  controlsError: string | null
  /** The loaded window of the branch: `turns[0]` is the branch turn `turnStart`. */
  turns: DisplayTurn[]
  turnStart: number
  /** One weight per turn of the branch, for the minimap rows that are not loaded yet. */
  turnSummary: TurnSummary[]
  /** A page of older turns is on its way. */
  turnLoading: boolean
  /** Turns exist above the window, but the branch index that counts them is still being built. */
  turnPending: boolean
  /**
   * Whether `turnStart` is the branch's own numbering rather than the provisional tail's 0. Only an
   * authoritative read (hydrate, window push, page) sets it, and `turnPending` alone cannot stand in
   * for it: an index failure clears `turnPending` while the window keeps its provisional numbering.
   */
  turnIndexTrusted: boolean
  /** Why the turns above the window could not be loaded, if they could not be. */
  turnError: string | null
  /** Whole-file lifetime spend, fetched only while the usage popover is open. */
  tokens: SessionTokenStats | null
  tokensLoading: boolean
  tokensError: string | null
  leafId: string | null
  branchViewId: string
  branchViews: Record<string, string>
  branchRequest: number
  /** A tree navigation/summary is in flight, including hydration of the destination branch. */
  isNavigatingBranch: boolean
  liveMessages: PiMessage[]
  toolUpdates: ToolUpdates
  bashExecution: { id: string; message: BashExecutionMessage } | null
  pendingUserMessage: boolean
  processByTurnId: Record<string, ProcessItem[]>
  thinkingDurations: ThinkingDurations
  elapsedByTurnId: Record<string, number>
  generationByTurnId: Record<string, GenerationStats>
  isStreaming: boolean
  /** A run finished while another tab was in front; cleared once the session is shown. */
  unread: boolean
  /** SDK lifecycle changes outrank cleanup of an older optimistic submission. */
  agentRunRevision: number
  streamStartedAt: number | null
  streamElapsedMs: number | null
  /** Compactions Pi is running in this session, in the order they started. */
  liveCompactions: LiveCompaction[]
  retryNotice: RetryNotice | null
  queuedEditText: string | null
}

export type TabKind = 'project' | 'chat' | 'diff' | 'file'
export type TabLoadState = 'cold' | 'opening' | 'ready' | 'error'

/**
 * The chat the chats half shows while nothing is open there. It exists in main from the moment the
 * half is entered — the composer needs a session to hold its controls — but stays out of the strip
 * and off the chat list until the first message, so a peek at the half leaves nothing behind.
 */
export interface ChatDraft {
  sessionId: string
  cwd: string
}

export interface OpenTab {
  /** The tab's own identity: a session id, or a worktree's `diff:<cwd>`. */
  id: string
  cwd: string
  title: string
  kind: TabKind
  loadState: TabLoadState
  loadError?: string
  meta?: SessionMeta
  /**
   * The tab title is an app-written stand-in for an attachments/images-only first message, so a
   * locale switch can translate it. Cleared once a real name or listing takes the title.
   */
  previewFallback?: SessionPreviewFallback
  /** A file tab's worktree-relative path; the tab's title is that file's name. */
  path?: string
  /** A changes tab shows one scope at a time; the title follows it. Older workspaces default to `all`. */
  diffScope?: DiffScope
}

export interface SessionsStore {
  projects: ProjectGroup[]
  chats: ProjectGroup[]
  openTabs: OpenTab[]
  /** Which tab the strip shows: a session tab or a diff tab. */
  activeTabId: string | null
  currentProjectCwd: string | null
  /** The worktree persisted before launch, even when the chats half owns the restored pane. */
  restoredProjectCwd: string | null
  activeSessionByCwd: Record<string, string | null>
  /**
   * The tab each worktree was left on, sessions and changes tabs alike: a session id cannot stand in for
   * a changes tab, so switching worktrees has to remember the strip itself, not just the session.
   */
  activeTabByCwd: Record<string, string>
  draftSessionByCwd: Record<string, string | undefined>
  draftSessionErrorByCwd: Record<string, string | undefined>
  chatDraft: ChatDraft | null
  /** A chat home whose chat main could not make: the home stays empty until it is asked for again. */
  chatDraftError: string | null
  workspaceRestoreReady: boolean
  workspaceRestoreError: string | null
  workspaceError: string | null
  runtime: Record<string, RuntimeState>
  isReorderingProjects: boolean
  expandedProjects: Record<string, boolean>
  expandedWorktrees: Record<string, boolean>

  setProjectExpanded: (projectCwd: string, expanded: boolean) => void
  setWorktreeExpanded: (worktreeCwd: string, expanded: boolean) => void
  revealProjectWorktree: (projectCwd: string, worktreeCwd: string | null) => void

  loadProjects: () => Promise<void>
  syncProjectWorktrees: () => Promise<void>
  loadWorktreeSessions: (cwd: string) => Promise<void>
  loadChats: () => Promise<void>
  projectPickerOpen: boolean
  setProjectPickerOpen: (open: boolean) => void
  openProject: (path?: string) => Promise<void>
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
      display?: DisplayTurnsResult
      /** A refresh of the same branch keeps the history the reader already paged in. */
      keepOlderTurns?: boolean
    }
  ) => Promise<boolean>
  loadTurnProcess: (sessionId: string, turnId: string) => Promise<void>
  /** Loads the turns above the loaded window; `target` is the oldest turn the caller needs. */
  loadOlderTurns: (sessionId: string, target?: number) => Promise<void>
  loadTokenStats: (sessionId: string) => Promise<void>
  applySessionWindow: (update: SessionWindowMessage) => void
  loadControls: (sessionId: string) => Promise<void>
  applyControls: (sessionId: string, controls: SessionControls) => void
  syncModelThinkingPreference: (controls: SessionControls) => void
  setControlsStatus: (
    sessionId: string,
    status: Partial<Pick<RuntimeState, 'controlsPending' | 'controlsError'>>
  ) => void
  setFollowUpMessages: (sessionId: string, messages: string[], steeringMessages?: string[]) => void
  queueFollowUpAction: (sessionId: string, index: number, action: FollowUpAction, mode?: PromptStreamingBehavior) => Promise<void>
  clearQueuedEditText: (sessionId: string) => void
  setThinkingLevel: (sessionId: string, thinkingLevel: ThinkingLevel) => void

  initializeProjectWorkspaces: (startInChatHome?: boolean) => Promise<void>
  /** A pending restore follows the latest sidebar half without starting another scan. */
  setWorkspaceRestoreMode: (startInChatHome: boolean) => void
  selectProjectCwd: (cwd: string) => Promise<void>
  activateTab: (tabId: string) => Promise<void>
  openExisting: (meta: SessionMeta, kind?: 'project' | 'chat') => Promise<void>
  /**
   * Brings a worktree's changes tab to the front, opening it when the strip does not hold it. A `path`
   * asks the tab to reveal that file, and a `scope` switches it to that group — which is how the
   * review column's rows point at a file and at the group the row was read under.
   */
  openChangesTab: (cwd: string, path?: string, scope?: DiffScope) => Promise<void>
  /** Brings a file's tab to the front, opening it when the strip does not hold it. */
  openFileTab: (cwd: string, path: string) => Promise<void>
  /** Follows a file the tree renamed: the tab keeps its place and takes the row's new name. */
  moveFileTab: (cwd: string, from: string, to: string) => void
  /** The toolbar's scope control: one changes tab, its title and its contents following the choice. */
  setChangesScope: (cwd: string, scope: DiffScope) => void
  acquireProjectDraft: (cwd: string) => void
  releaseProjectDraft: (cwd: string) => void
  /** Turns a draft into a tab: a worktree's session, or the chat home's chat. */
  promoteDraft: (cwd: string, sessionId: string) => Promise<boolean>
  acquireChatDraft: () => void
  releaseChatDraft: () => void
  /** Another try at the chat home's chat after a create failed. */
  retryChatDraft: () => void
  /** Leaves the worktree behind for the chat home, the way activating a chat tab does. */
  focusChatHome: () => void
  /** Drops the selection work in flight: the worktrees it was started for are gone. */
  invalidateSelection: () => void
  newSession: (cwd: string) => Promise<string | null>
  forkSession: (sessionId: string, userEntryId: string) => Promise<void>
  newChat: () => Promise<void>
  createWorktree: (projectCwd: string, options?: { initGit?: boolean }) => Promise<string | null>
  deleteWorktree: (projectCwd: string, cwd: string) => Promise<void>
  applyWorktreeDeletions: (cwds: string[]) => void
  deleteProject: (cwd: string) => Promise<void>
  deleteChat: (cwd: string) => Promise<void>
  deleteSession: (meta: SessionMeta) => Promise<void>
  /**
   * Writes the session's display name, and with it every list that shows it: the tab title, the
   * project's rows, the chats. An empty name clears the override and hands the title back.
   */
  renameSession: (sessionId: string, name: string, path?: string) => Promise<void>
  /**
   * The names a background scan found for sessions whose listing showed a first message instead: the
   * rows and the tab titles are patched in place, since the session files are already up to date.
   */
  applySessionNames: (updates: SessionNameUpdate[]) => void
  /** Session tabs with running background subagents ask first unless `confirmed`. */
  closeTab: (tabId: string, options?: { confirmed?: boolean }) => void
  /**
   * Writes back a dragged half of the strip: the visible ids in their new arrangement, which the store
   * places into the slots those tabs already held so the other half is not disturbed.
   */
  reorderTabs: (visibleIds: string[]) => void
  /** Mirrors the chats half's open tabs to disk: membership, order, and which one the pane shows. */
  persistOpenChatTabs: (closedIds?: string[]) => void
  setActive: (tabId: string) => void
  renameTab: (tabId: string, title: string) => void
  relabelTabs: () => void
  previewSessionTitle: (sessionId: string, title: string, fallback?: SessionPreviewFallback) => void

  setStreaming: (sessionId: string, streaming: boolean) => void
  markRead: (sessionId: string) => void
  beginPrompt: (sessionId: string, message: PiMessage) => void
  rollbackPrompt: (sessionId: string, message: PiMessage, agentRunRevision: number) => void
  beginBash: (sessionId: string, id: string, command: string) => void
  appendBashOutput: (sessionId: string, id: string, delta: string) => void
  endBash: (sessionId: string, id: string, result?: BashExecutionResult, turnId?: string) => void
  setThinkingDuration: (
    sessionId: string,
    messageTimestamp: number,
    contentIndex: number,
    durationMs: number
  ) => void
  appendLiveMessage: (sessionId: string, message: PiMessage) => void
  replaceLiveMessage: (sessionId: string, message: PiMessage) => void
  setToolUpdates: (sessionId: string, updates: ToolUpdates) => void
  setRetryNotice: (sessionId: string, notice: RetryNotice | null) => void
  startCompaction: (sessionId: string, mark: LiveCompaction) => void
  updateCompaction: (sessionId: string, id: string, patch: Partial<LiveCompaction>) => void
  dropCompaction: (sessionId: string, id: string) => void
  viewBranch: (sessionId: string, tipId: string, options?: SessionBranchOptions) => Promise<boolean>
  retryUserMessage: (sessionId: string, userEntryId: string) => Promise<void>
}

export type SessionSlice<Keys extends keyof SessionsStore> = StateCreator<
  SessionsStore, [], [], Pick<SessionsStore, Keys>
>
