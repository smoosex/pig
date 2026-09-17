/**
 * Serializable contracts shared by main, preload, and renderer.
 * SDK objects stay in main; only these data shapes cross the IPC boundary.
 */
import type {
  PastedTextAttachment,
  PastedTextAttachmentInput,
  PastedTextDisplaySegment
} from './pasted-text'

export type { PastedTextAttachment, PastedTextAttachmentInput, PastedTextDisplaySegment }

export interface SessionMeta {
  path: string
  id: string
  cwd: string
  name?: string
  created: string
  modified: string
  /** Size of the session file on disk, as scanned. */
  size: number
  firstMessage: string
}

export interface WorktreeGroup {
  cwd: string
  branch: string
  head?: string
  isPrimary: boolean
  locked: boolean
  missing: boolean
  managed: boolean
  naming?: 'pending' | 'naming' | 'failed'
  namingError?: string
  sessions: SessionMeta[]
  /** False only for a worktree found by topology discovery whose session directory has not been read. */
  sessionsLoaded?: boolean
}

export type WorktreeTopology = Omit<WorktreeGroup, 'sessions' | 'sessionsLoaded'>

export interface ProjectWorktreeDiscovery {
  cwd: string
  hasGit: boolean | null
  worktrees: WorktreeTopology[] | null
  gitError?: string
}

export interface WorktreeCreateInfo {
  hasGit: boolean
  hasHead: boolean
}

export interface WorktreeDeletionInfo {
  cwd: string
  branch: string
  dirty: boolean
  unmerged: boolean
  missing: boolean
}

export interface ProjectGroup {
  cwd: string
  name: string
  sessions: SessionMeta[]
  worktrees?: WorktreeGroup[]
  hasGit?: boolean
  gitError?: string
}

export interface SidebarPrefs {
  projectsCollapsed: boolean
  chatsCollapsed: boolean
  split: number
}

export interface OpenProjectWorkspace {
  cwd: string
  sessionIds: string[]
  activeSessionId: string | null
}

export interface OpenProjectSessionsState {
  currentCwd: string | null
  workspaces: OpenProjectWorkspace[]
}

export interface SessionRef {
  sessionId: string
  cwd: string
  /** This call gave the session its file: the directory it belongs to should be rescanned. */
  created?: boolean
}

export interface OpenSessionRef extends SessionRef {
  display: DisplayTurnsResult
}

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface SessionModelInfo {
  id: string
  name: string
  provider: string
  providerName: string
  contextWindow: number
  reasoning: boolean
}

export interface SessionContextUsage {
  tokens: number | null
  contextWindow: number
  percent: number | null
}

export interface SessionTokenStats {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export interface SessionControls {
  model: SessionModelInfo | null
  models: SessionModelInfo[]
  thinkingLevel: ThinkingLevel
  thinkingLevels: ThinkingLevel[]
  contextUsage: SessionContextUsage | null
  followUpMessages: string[]
}

export type FollowUpAction = 'steer' | 'edit' | 'dismiss'

export type SlashCommandSource = 'builtin' | 'extension' | 'prompt' | 'skill'

export interface SlashCommand {
  name: string
  description?: string
  source: SlashCommandSource
}

/** An image block a turn refers to; the bytes stay in main behind a pig-image URL. */
export interface DisplayImage {
  mimeType: string
  url: string
}

export interface DisplayUser {
  text: string
  images: DisplayImage[]
  textAttachments: PastedTextAttachment[]
  textSegments?: PastedTextDisplaySegment[]
}

export type DisplayAnswer =
  | { type: 'text'; text: string }
  | ({ type: 'image' } & DisplayImage)

export interface DisplayTurn {
  id: string
  user?: DisplayUser
  /** Original user-message timestamp used to preserve the live Turn DOM key. */
  userTimestamp?: number
  answer: DisplayAnswer[]
  errorMessage?: string
  startedAt: number
  endedAt: number
  hasProcess: boolean
}

/**
 * One minimap row for a turn the renderer has not loaded: a weight and nothing else.
 * `bytes` is the turn's user line clamped, so a screenshot turn does not flatten the scale.
 */
export interface TurnSummary {
  id: string
  bytes: number
  hasImages: boolean
}

export interface DisplayTurnsResult {
  leafId: string | null
  turns: DisplayTurn[]
  /** Where `turns[0]` sits in the branch's full turn list. */
  startIndex: number
  /** Turns in the whole branch: the window can grow until `startIndex` reaches zero. */
  totalTurns: number
  /** Weights for every turn of the branch, oldest first. Omitted by window paging. */
  summary?: TurnSummary[]
  /**
   * Set when turns remain above the window but their count is still unknown: opening shows the tail
   * before the branch index exists, and `session:window` corrects `startIndex` and `totalTurns`.
   */
  indexPending?: boolean
}

/** Pushed once a pending session's branch index exists, replacing provisional window counts. */
export interface SessionWindowUpdate {
  sessionId: string
  leafId: string | null
  startIndex: number
  totalTurns: number
  summary?: TurnSummary[]
}

/** Pushed instead of a window when the background index cannot be built for this session. */
export interface SessionWindowFailure {
  sessionId: string
  error: string
}

export type SessionWindowMessage = SessionWindowUpdate | SessionWindowFailure

/** Switching a branch answers with the new window, so the renderer needs no second round trip. */
export type SessionBranchRef = DisplayTurnsResult

export interface SessionTreeGutter {
  position: number
  show: boolean
}

export interface SessionTreeRow {
  id: string
  parentId: string | null
  indent: number
  gutters: SessionTreeGutter[]
  showConnector: boolean
  isLast: boolean
  isVirtualRootChild: boolean
  foldable: boolean
  onPath: boolean
  current: boolean
  kind: 'user' | 'assistant' | 'tool' | 'other'
  text: string
}

export type PiEvent = {
  type: string
  [key: string]: unknown
}

export type SendShortcut = 'enter' | 'shift-enter'
export type Appearance = 'system' | 'light' | 'dark'
export type PaletteId = 'pig' | 'everforest'

export type ProviderAuthType = 'oauth' | 'api_key'

export interface SettingsProvider {
  id: string
  name: string
  oauth: { name: string; loginLabel?: string; subscription: boolean } | null
  apiKey: { name: string; canLogin: boolean } | null
  configured: boolean
  using: ProviderAuthType | null
  source?: string
}

export type SettingsAuthPrompt =
  | { type: 'text' | 'secret' | 'manual_code'; message: string; placeholder?: string }
  | {
      type: 'select'
      message: string
      options: { id: string; label: string; description?: string }[]
    }

export type SettingsAuthNotify =
  | { type: 'info'; message: string; links?: { url: string; label?: string }[] }
  | { type: 'auth_url'; url: string; instructions?: string }
  | { type: 'device_code'; userCode: string; verificationUri: string; expiresInSeconds?: number }
  | { type: 'progress'; message: string }

export type SettingsAuthEvent =
  | { kind: 'prompt'; id: string; prompt: SettingsAuthPrompt }
  | { kind: 'notify'; event: SettingsAuthNotify }

export type PromptStreamingBehavior = 'steer' | 'followUp'

export interface DefaultSessionSettings {
  model: SessionModelInfo | null
  thinkingLevel: ThinkingLevel | null
  thinkingLevels: ThinkingLevel[]
}

export interface ThemePrefs {
  appearance: Appearance
  lightTheme: PaletteId
  darkTheme: PaletteId
}

export interface AppSettings extends ThemePrefs {
  sendShortcut: SendShortcut
  defaultModel: SessionModelInfo | null
  defaultThinkingLevel: ThinkingLevel | null
  thinkingLevels: ThinkingLevel[]
  models: SessionModelInfo[]
  providers: SettingsProvider[]
}

export interface SessionApi {
  listProjects: () => Promise<ProjectGroup[]>
  discoverOpenedWorktrees: () => Promise<ProjectWorktreeDiscovery[]>
  listWorktreeSessions: (projectCwd: string, cwd: string) => Promise<SessionMeta[]>
  listProject: (cwd: string) => Promise<ProjectGroup | null>
  listChats: () => Promise<ProjectGroup[]>
  isChatCwd: (cwd: string) => Promise<boolean>
  openProject: () => Promise<ProjectGroup | null>
  unpinProject: (cwd: string) => Promise<void>
  reorderProjects: (cwds: string[]) => Promise<string[]>
  prepareSession: (sessionId: string) => Promise<SessionRef>
  createSession: (cwd: string, sessionId?: string) => Promise<SessionRef>
  promoteSession: (sessionId: string) => Promise<void>
  discardDraftSession: (sessionId: string) => Promise<void>
  createChat: () => Promise<SessionRef>
  deleteChat: (cwd: string) => Promise<void>
  openSession: (path: string) => Promise<OpenSessionRef>
  closeSession: (sessionId: string) => Promise<void>
  deleteProject: (cwd: string) => Promise<boolean>
  createWorktree: (projectCwd: string, options?: { initGit?: boolean }) => Promise<{ cwd: string; project: ProjectGroup } | null>
  worktreeCreateInfo: (projectCwd: string) => Promise<WorktreeCreateInfo>
  worktreeDeletionInfo: (projectCwd: string, cwd: string) => Promise<WorktreeDeletionInfo>
  deleteWorktree: (projectCwd: string, cwd: string, force?: boolean) => Promise<{ cwd: string; project: ProjectGroup } | null>
  onProjectsChanged: (listener: (projectCwd: string) => void) => () => void
  deleteSession: (sessionId: string, path: string, cwd: string) => Promise<void>
  prompt: (
    sessionId: string,
    text: string,
    images?: { mimeType: string; data: string }[],
    textAttachments?: PastedTextAttachmentInput[],
    streamingBehavior?: PromptStreamingBehavior
  ) => Promise<void>
  abort: (sessionId: string) => Promise<void>
  getDisplayTurns: (sessionId: string) => Promise<DisplayTurnsResult>
  getTurnWindow: (sessionId: string, start: number, count: number) => Promise<DisplayTurnsResult>
  getTurnMessages: (sessionId: string, turnId: string) => Promise<unknown[]>
  getSessionTree: (sessionId: string) => Promise<SessionTreeRow[]>
  viewBranch: (sessionId: string, tipId: string) => Promise<SessionBranchRef>
  getControls: (sessionId: string) => Promise<SessionControls>
  getTokenStats: (sessionId: string) => Promise<SessionTokenStats>
  getCommands: (sessionId: string) => Promise<SlashCommand[]>
  exportSession: (sessionId: string, outputPath?: string) => Promise<{ path: string } | null>
  setModel: (sessionId: string, provider: string, id: string) => Promise<SessionControls>
  setThinking: (sessionId: string, level: ThinkingLevel) => Promise<SessionControls>
  refreshModels: (sessionId: string) => Promise<SessionControls>
  followUpAction: (sessionId: string, index: number, action: FollowUpAction) => Promise<string | null>
  pickDirectory: () => Promise<string | null>
  getSidebarPrefs: () => Promise<SidebarPrefs>
  setSidebarPrefs: (patch: Partial<SidebarPrefs>) => Promise<SidebarPrefs>
  getOpenProjectSessions: () => Promise<OpenProjectSessionsState>
  selectOpenProjectWorkspace: (cwd: string, sessionId: string | null) => Promise<void>
  getSettings: () => Promise<AppSettings>
  setSendShortcut: (shortcut: SendShortcut) => Promise<{ sendShortcut: SendShortcut }>
  setTheme: (patch: Partial<ThemePrefs>) => Promise<ThemePrefs>
  setDefaultModelSetting: (provider: string, id: string) => Promise<DefaultSessionSettings>
  setDefaultThinkingSetting: (level: ThinkingLevel) => Promise<DefaultSessionSettings>
  listProviders: () => Promise<SettingsProvider[]>
  loginProvider: (providerId: string, authType: ProviderAuthType) => Promise<SettingsProvider[]>
  logoutProvider: (providerId: string) => Promise<SettingsProvider[]>
  replyAuthPrompt: (id: string, value: string | null) => Promise<void>
  cancelLogin: () => Promise<void>
  onEvent: (listener: (event: unknown) => void) => () => void
  onSessionWindow: (listener: (update: SessionWindowMessage) => void) => () => void
  onAuthEvent: (listener: (event: SettingsAuthEvent) => void) => () => void
}
