import type { StateCreator } from 'zustand'
import type {
  DisplayTurn,
  DisplayTurnsResult,
  FollowUpAction,
  ProjectGroup,
  SessionControls,
  SessionMeta,
  SessionTokenStats,
  SessionWindowMessage,
  ThinkingLevel,
  TurnSummary
} from '../../ipc/api'
import type { ProcessItem, ThinkingDurations } from '../../chat/turns'
import type { PiMessage } from '../../pi/types'

export interface RuntimeState extends SessionControls {
  instanceId: number
  controlsRevision: number
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
  liveMessages: PiMessage[]
  pendingUserMessage: boolean
  processByTurnId: Record<string, ProcessItem[]>
  thinkingDurations: ThinkingDurations
  elapsedByTurnId: Record<string, number>
  isStreaming: boolean
  streamStartedAt: number | null
  streamElapsedMs: number | null
  queuedEditText: string | null
}

export interface OpenTab {
  sessionId: string
  cwd: string
  title: string
  meta?: SessionMeta
}

export interface SessionsStore {
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
  setFollowUpMessages: (sessionId: string, messages: string[]) => void
  queueFollowUpAction: (sessionId: string, index: number, action: FollowUpAction) => Promise<void>
  clearQueuedEditText: (sessionId: string) => void
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
  beginPrompt: (sessionId: string, message: PiMessage) => void
  rollbackPrompt: (sessionId: string) => void
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

export type SessionSlice<Keys extends keyof SessionsStore> = StateCreator<
  SessionsStore, [], [], Pick<SessionsStore, Keys>
>
