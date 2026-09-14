import type { StateCreator } from 'zustand'
import type {
  DisplayTurn,
  DisplayTurnsResult,
  FollowUpAction,
  ProjectGroup,
  SessionControls,
  SessionMeta,
  ThinkingLevel
} from '../../ipc/api'
import type { ProcessItem, ThinkingDurations } from '../../chat/turns'
import type { PiMessage } from '../../pi/types'

export interface RuntimeState extends SessionControls {
  instanceId: number
  controlsRevision: number
  turns: DisplayTurn[]
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
    }
  ) => Promise<boolean>
  loadTurnProcess: (sessionId: string, turnId: string) => Promise<void>
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
