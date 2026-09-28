/**
 * Serializable contracts shared by main, preload, and renderer.
 * SDK objects stay in main; only these data shapes cross the IPC boundary.
 */
import type { Locale, LocaleSetting } from './i18n'
import type {
  PastedTextAttachment,
  PastedTextAttachmentInput,
  PastedTextDisplaySegment
} from './pasted-text'

export type { Locale, LocaleSetting } from './i18n'

export type { PastedTextAttachment, PastedTextAttachmentInput, PastedTextDisplaySegment }

/** An app-written stand-in title for an attachments/images-only first message; the renderer translates it. */
export type SessionPreviewFallback = 'pastedText' | 'image'

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
  /**
   * The title leans on an image-only user message: no earlier message had text, so `firstMessage`
   * stays empty and the row shows a placeholder. A later message with text takes the title instead.
   */
  firstMessageIsImage?: boolean
  /**
   * The title is an app-written stand-in for an attachments/images-only first message ('pastedText'
   * or 'image'), so the renderer translates it on a locale switch instead of freezing the old word.
   */
  previewFallback?: SessionPreviewFallback
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

export const MIN_REVIEW_WIDTH = 240
export const MAX_REVIEW_WIDTH = 720
export const DEFAULT_REVIEW_WIDTH = 320

/** Which list the left sidebar shows: the toggle in the title bar switches it. */
export type SidebarTab = 'projects' | 'chats'

export interface SidebarPrefs {
  sidebarTab: SidebarTab
  split: number
  /** The change review column and its width, dragged and remembered like the sidebar. */
  reviewOpen: boolean
  reviewWidth: number
}

export interface OpenProjectWorkspace {
  cwd: string
  sessionIds: string[]
  activeSessionId: string | null
  /** Whether this workspace keeps its 全部变更 tab open. */
  changesOpen: boolean
  /** The tab the workbench shows for this workspace: a session id or the changes tab id. */
  activeTabId: string | null
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

/** `git status --porcelain=v1 -z`: one entry per dirty side of a path. */
export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'

/**
 * Which slice of the worktree a changes view reads: everything HEAD does not have, only what the index
 * holds, or only what the worktree adds on top of the index. The three are different diffs, not three
 * filters of one: a half-staged file reads differently in each.
 */
export type DiffScope = 'all' | 'staged' | 'unstaged'

/** One row of the review panel: `staged` and `unstaged` keep their own lists, `all` is per path. */
export interface WorktreeDiff {
  git: boolean
  staged: DiffFileEntry[]
  unstaged: DiffFileEntry[]
  all: DiffFileEntry[]
}

export interface DiffWatchError {
  cwd: string
  leaseId: string
  message: string
}

/**
 * One untracked file, read on demand: an untracked file has no diff to ask git for, and reading the
 * whole set on every refresh is what turns a worktree full of generated files into a stalled app. The
 * changes tab reads one of these when its card is opened, so the cost follows what is on screen — and
 * the line count comes back with the bytes, because nothing else can know it without reading the file.
 */
export type UntrackedFileResult =
  | { kind: 'text'; contents: string; lines: number }
  | { kind: 'binary' }
  | { kind: 'too-large'; bytes: number }
  /** A link stood where a regular file had just been: the read refused it, the row stays visible. */
  | { kind: 'blocked' }
  /** The read failed — a permission, a descriptor table that ran out: the card shows what main said. */
  | { kind: 'failed'; message: string }
  | { kind: 'missing' }

/**
 * One scope of the worktree in one payload: the patch for its tracked files. Untracked ones are not in
 * any diff git prints and are read per card instead — see `UntrackedFileResult`.
 */
export interface WorktreePatch {
  git: boolean
  patch: string
  /** The patch hit its size cap and stops at a file boundary. */
  truncated: boolean
}

export interface DiffFileEntry {
  /** Repo-relative, exactly as git spells it. */
  path: string
  /** Where a rename or copy came from. */
  origPath?: string
  status: DiffFileStatus
  /** Null when git reports a binary file or nobody has read the file to count it. */
  additions: number | null
  deletions: number | null
}

/**
 * One row of the file tree. Paths are worktree-relative and `/`-separated, the same spelling the
 * changes panel uses, so a file the tree opens and a file the review column names are the same string.
 */
export interface FileTreeEntry {
  name: string
  path: string
  kind: 'file' | 'directory' | 'link'
  /** Git ignores it — `.gitignore`, `.git/info/exclude` or the user's global excludes. */
  ignored: boolean
}

/** One level of the tree, read when it is first opened and again whenever the worktree changes. */
export interface DirectoryListing {
  /** The directory this listing is for; `''` is the worktree root. */
  path: string
  entries: FileTreeEntry[]
}

/**
 * One `@` completion row. Paths are worktree-relative and `/`-separated, and a directory carries
 * its trailing slash so the composer can keep completing inside it without another lookup shape.
 */
export interface FileSuggestion {
  path: string
  isDirectory: boolean
}

/** A file's identity on disk, so a write can tell whether it still holds the bytes that were read. */
export interface FileStamp {
  mtimeMs: number
  size: number
}

/**
 * One file for a file tab. A link is never followed, so a symlink inside the worktree cannot be a way
 * to read — or write — anything outside it; the bytes are capped and probed for NUL, like an untracked
 * file read for the changes card.
 */
export type FileReadResult =
  | ({ kind: 'text'; contents: string } & FileStamp)
  | { kind: 'binary'; size: number }
  | { kind: 'too-large'; size: number }
  | { kind: 'link' }
  | { kind: 'missing' }

export type FileWriteResult =
  | ({ kind: 'written' } & FileStamp)
  /** The file no longer holds what the draft was written against: the reader decides what to do. */
  | { kind: 'conflict' }

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
  bash?: { command: string; exitCode?: number; cancelled: boolean }
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

/**
 * Pushed after a listing when a session's name only shows up past the prefix the listing reads, because
 * it was appended to the end of a long file. The row already rendered with its first message as title.
 */
export interface SessionNameUpdate {
  sessionId: string
  path: string
  name: string
}

/** Switching a branch answers with the new window, so the renderer needs no second round trip. */
export type SessionBranchRef = DisplayTurnsResult

export interface SessionTreeGutter {
  position: number
  show: boolean
}

/** Mirrors pi's `/tree` Ctrl+O filter cycle: default, no-tools, user-only, labeled-only, all. */
export type SessionTreeView = 'default' | 'no-tools' | 'user-only' | 'labeled-only' | 'all'

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
  /** The entry's resolved label, if pi or pig marked it: shown as a chip, and what labeled-only keeps. */
  label?: string
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
  completionNotifications: boolean
  /** The stored choice: a locale, or `system` to follow the OS language. */
  localeSetting: LocaleSetting
  /** The OS language resolved against the shipped locales, for the `system` option's label. */
  systemLocale: Locale
  defaultModel: SessionModelInfo | null
  defaultThinkingLevel: ThinkingLevel | null
  thinkingLevels: ThinkingLevel[]
  models: SessionModelInfo[]
  providers: SettingsProvider[]
}

export interface PluginSettingsField {
  key: string
  label: string
  description?: string
  type: 'string' | 'integer' | 'boolean' | 'select'
  options?: string[]
  min?: number
  max?: number
}

export interface PluginSettingsSchema {
  namespace: string
  fields: PluginSettingsField[]
}

export interface PluginInfo {
  id: string
  name: string
  source: string
  kind: 'system' | 'local' | 'npm' | 'git'
  enabled: boolean
  available: boolean
  error?: string
  settings?: PluginSettingsSchema
}

export type PluginUIEvent =
  | { kind: 'prompt'; id: string; sessionId: string; method: 'select' | 'confirm' | 'input' | 'editor'; title: string; message?: string; options?: string[]; prefill?: string }
  | { kind: 'dismiss'; id: string; sessionId: string }
  | { kind: 'notify'; sessionId: string; message: string; level: 'info' | 'warning' | 'error' }
  | { kind: 'status'; sessionId: string; key: string; text?: string }
  | { kind: 'widget'; sessionId: string; key: string; lines?: string[] }

export interface MemoryPluginSettings {
  observeAfterTokens?: number
  reflectAfterTokens?: number
  observerChunkMaxTokens?: number
  compactAfterTokens?: number
  compactAfterTokensMode?: 'calibrated' | 'ratio'
  compactAfterTokensRatio?: number
  observationsPoolMaxTokens?: number
  observationsPoolTargetTokens?: number
  agentMaxTurns?: number
  agentMaxTokens?: number
  model?: { provider: string; id: string; thinking?: ThinkingLevel }
  showWorkerNotifications?: boolean
  showCompactionNotifications?: boolean
  passive?: boolean
  debugLog?: boolean
}

export type MemoryPluginSettingsPatch = { [K in keyof MemoryPluginSettings]?: MemoryPluginSettings[K] | null }

export interface BashExecutionResult {
  output: string
  exitCode?: number
  cancelled: boolean
  truncated: boolean
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
  onSessionNames: (listener: (updates: SessionNameUpdate[]) => void) => () => void
  deleteSession: (sessionId: string, path: string, cwd: string) => Promise<void>
  renameSession: (sessionId: string, name: string, path?: string) => Promise<void>
  prompt: (
    sessionId: string,
    text: string,
    images?: { mimeType: string; data: string }[],
    textAttachments?: PastedTextAttachmentInput[],
    streamingBehavior?: PromptStreamingBehavior
  ) => Promise<void>
  abort: (sessionId: string) => Promise<void>
  executeBash: (sessionId: string, command: string, id: string) => Promise<BashExecutionResult>
  abortBash: (sessionId: string) => Promise<void>
  getDisplayTurns: (sessionId: string) => Promise<DisplayTurnsResult>
  getTurnWindow: (sessionId: string, start: number, count: number) => Promise<DisplayTurnsResult>
  getTurnMessages: (sessionId: string, turnId: string) => Promise<unknown[]>
  getSessionTrees: (
    sessionId: string,
    views?: SessionTreeView[]
  ) => Promise<Partial<Record<SessionTreeView, SessionTreeRow[]>>>
  setSessionLabel: (sessionId: string, targetId: string, label: string, path?: string) => Promise<void>
  viewBranch: (sessionId: string, tipId: string) => Promise<SessionBranchRef>
  getControls: (sessionId: string) => Promise<SessionControls>
  getTokenStats: (sessionId: string) => Promise<SessionTokenStats>
  getCommands: (sessionId: string) => Promise<SlashCommand[]>
  exportSession: (sessionId: string) => Promise<{ path: string } | null>
  setModel: (sessionId: string, provider: string, id: string) => Promise<SessionControls>
  setThinking: (sessionId: string, level: ThinkingLevel) => Promise<SessionControls>
  refreshModels: (sessionId: string) => Promise<SessionControls>
  followUpAction: (sessionId: string, index: number, action: FollowUpAction) => Promise<string | null>
  pickDirectory: () => Promise<string | null>
  getSidebarPrefs: () => Promise<SidebarPrefs>
  setSidebarPrefs: (patch: Partial<SidebarPrefs>) => Promise<SidebarPrefs>
  readDirectory: (cwd: string, path: string) => Promise<DirectoryListing>
  suggestFiles: (cwd: string, query: string) => Promise<FileSuggestion[]>
  readFile: (cwd: string, path: string) => Promise<FileReadResult>
  /**
   * Writes a file tab's draft. `expected` is the stamp the draft was edited against: a file that has
   * moved on since then answers `conflict` instead of being overwritten, unless the reader said so.
   */
  writeFile: (
    cwd: string,
    path: string,
    contents: string,
    options: { expected?: FileStamp; overwrite?: boolean }
  ) => Promise<FileWriteResult>
  /** 打开方式…: hands the file to the desktop instead of opening a tab for it. */
  openFileExternally: (cwd: string, path: string) => Promise<void>
  revealFileExternally: (cwd: string, path: string) => Promise<void>
  readWorktreeDiff: (cwd: string) => Promise<WorktreeDiff>
  readWorktreePatch: (cwd: string, scope: DiffScope) => Promise<WorktreePatch>
  readUntrackedFile: (cwd: string, path: string) => Promise<UntrackedFileResult>
  watchWorktreeDiff: (cwd: string) => Promise<string>
  unwatchWorktreeDiff: (cwd: string, leaseId: string) => Promise<void>
  onDiffChanged: (listener: (cwd: string) => void) => () => void
  onDiffWatchError: (listener: (error: DiffWatchError) => void) => () => void
  getOpenProjectSessions: () => Promise<OpenProjectSessionsState>
  /** `activeTabId` is the strip's own selection: a session id, or a worktree's changes tab. */
  selectOpenProjectWorkspace: (
    cwd: string,
    sessionId: string | null,
    activeTabId: string | null
  ) => Promise<void>
  saveOpenProjectChangesTab: (cwd: string, open: boolean, activeTabId: string | null) => Promise<void>
  getSettings: () => Promise<AppSettings>
  listPlugins: () => Promise<PluginInfo[]>
  installPlugin: (source: string) => Promise<PluginInfo[]>
  pickPluginPath: () => Promise<string | null>
  setPluginEnabled: (id: string, enabled: boolean) => Promise<PluginInfo[]>
  updatePlugin: (id: string) => Promise<PluginInfo[]>
  removePlugin: (id: string) => Promise<PluginInfo[]>
  isMemoryPluginEnabled: () => Promise<boolean>
  getMemoryPluginDefaults: () => Promise<Record<string, number>>
  getMemoryPluginSettings: () => Promise<MemoryPluginSettings>
  setMemoryPluginSettings: (patch: MemoryPluginSettingsPatch) => Promise<MemoryPluginSettings>
  getMemoryDetail: (sessionId: string, kind: 'status' | 'view', full?: boolean) => Promise<string>
  getPluginSettings: (id: string) => Promise<Record<string, string | number | boolean>>
  setPluginSettings: (id: string, patch: Record<string, string | number | boolean | null>) => Promise<Record<string, string | number | boolean>>
  replyPluginUI: (id: string, value: string | boolean | null) => Promise<void>
  onPluginUI: (listener: (event: PluginUIEvent) => void) => () => void
  onPluginsChanged: (listener: () => void) => () => void
  setSendShortcut: (shortcut: SendShortcut) => Promise<{ sendShortcut: SendShortcut }>
  setCompletionNotifications: (enabled: boolean) => Promise<{ completionNotifications: boolean }>
  setLocaleSetting: (
    locale: LocaleSetting
  ) => Promise<{ localeSetting: LocaleSetting; systemLocale: Locale }>
  setTheme: (patch: Partial<ThemePrefs>) => Promise<ThemePrefs>
  setDefaultModelSetting: (provider: string, id: string) => Promise<DefaultSessionSettings>
  setDefaultThinkingSetting: (level: ThinkingLevel) => Promise<DefaultSessionSettings>
  listProviders: () => Promise<SettingsProvider[]>
  loginProvider: (providerId: string, authType: ProviderAuthType) => Promise<SettingsProvider[]>
  logoutProvider: (providerId: string) => Promise<SettingsProvider[]>
  replyAuthPrompt: (id: string, value: string | null) => Promise<void>
  cancelLogin: () => Promise<void>
  onEvent: (listener: (event: unknown) => void) => () => void
  onNotificationClick: (listener: (sessionId: string) => void) => () => void
  onSessionWindow: (listener: (update: SessionWindowMessage) => void) => () => void
  /** Pushed when an extension moves the session leaf; null means the root before any entry. */
  onSessionBranchChanged: (listener: (sessionId: string, leafId: string | null) => void) => () => void
  onAuthEvent: (listener: (event: SettingsAuthEvent) => void) => () => void
}
