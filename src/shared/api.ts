/**
 * Serializable contracts shared by main, preload, and renderer.
 * SDK objects stay in main; only these data shapes cross the IPC boundary.
 */
import type { Locale, LocaleSetting } from './i18n'
import type { ToolSettingsApi } from './tool-settings'
export type * from './tool-settings'
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
  /** Absolute session file path. */
  path: string
  id: string
  cwd: string
  /** Absolute path of the session file this one was forked, cloned, or branched from. */
  parentSession?: string
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

/** Durable background cleanup; failed jobs remain available for a manual retry. */
export interface WorktreeDeletionJob {
  projectCwd: string
  cwd: string
  branch: string
  attempts: number
  status: 'pending' | 'running' | 'retrying' | 'failed'
  error?: string
  retryAt?: number
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
  /**
   * The strip's own order: every session of this worktree plus its changes tab, file tabs excluded.
   * `sessionIds` stays the membership — this only arranges it, so a reorder cannot open or close
   * anything. A permutation of the members, which main re-derives on every read and write.
   */
  tabOrder: string[]
}

export interface OpenProjectSessionsState {
  currentCwd: string | null
  workspaces: OpenProjectWorkspace[]
  /**
   * The chats half's open chat tabs, in strip order. Unlike a worktree's, this list is also its
   * membership: nothing else persists which chats were open, and an id whose directory is gone is
   * dropped at restore rather than reported.
   */
  chatOrder: string[]
  /** The chat the strip was left on, or null when the chats half was showing its home. */
  activeChatTabId: string | null
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

// Sampling heuristics shared by collection and display; burst delivery cannot measure decoding speed.
export const MIN_GENERATION_DURATION_MS = 200
export const MAX_REALISTIC_TPS = 2_000

/** Provider-reported output tokens measured over active model decoding time. */
export interface GenerationStats {
  outputTokens: number
  durationMs: number
  /**
   * `provider/model` identities behind these tokens, in first-seen order. A single model call
   * contributes one entry; a turn that spans a model switch contributes several, and then the
   * summed figure is a blend rather than any one model's decode speed.
   */
  models: string[]
}

/**
 * The catalog every picker reads. It belongs to the app rather than to a session: one main-side
 * runtime answers for all of them, and a refresh re-reads it once instead of once per open session.
 */
export interface ModelCatalog {
  models: SessionModelInfo[]
  /** Bumped by main on every refresh that changed the list, so a late read cannot win over a newer push. */
  revision: number
  /** Whether a refresh is in flight: an empty list means "not yet" until this is false. */
  refreshing: boolean
}

export interface SessionControls {
  model: SessionModelInfo | null
  thinkingLevel: ThinkingLevel
  thinkingLevels: ThinkingLevel[]
  contextUsage: SessionContextUsage | null
  followUpMessages: string[]
  steeringMessages: string[]
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

/** What a rename leaves behind: the worktree-relative path the row now answers to. */
export type FileRenameResult = { path: string }

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

/**
 * A compaction is a session landmark rather than work: the model's visible context was summarized,
 * so everything before it stops counting towards the window. `afterAnswer` is decided by position in
 * the turn — a summary written behind the last assistant message reads below the answer, an overflow
 * that was compacted and retried keeps its marker inside the work.
 */
export interface DisplayCompaction {
  text: string
  tokensBefore: number
  afterAnswer: boolean
  /**
   * Work done in the turn before this compaction, with earlier compactions of the same turn already
   * subtracted: summarizing is not work, so each block of work ends where the next compaction began.
   */
  workMsBefore: number
  /** How long the summary took, estimated from the entries written either side of it. */
  durationMs: number
}

export interface DisplayBranchSummary {
  text: string
  afterAnswer: boolean
  /** Number of compaction records preceding this handoff in the turn's source stream. */
  compactionsBefore: number
}

export interface DisplayTurn {
  id: string
  user?: DisplayUser
  bash?: { command: string; exitCode?: number; cancelled: boolean }
  /** Original user-message timestamp used to preserve the live Turn DOM key. */
  userTimestamp?: number
  answer: DisplayAnswer[]
  /**
   * The turn's compaction landmarks, in the order Pi appended them. They travel with the projection
   * rather than with the on-demand process disclosure: a landmark that only appears once the work
   * block is expanded is one the reader has to find first.
   */
  compactions: DisplayCompaction[]
  /** Review branch handoffs stay visible without loading the turn's process bodies. */
  branchSummaries: DisplayBranchSummary[]
  /**
   * Work presence in each interval separated by an inline compaction, including the final interval.
   * Empty intervals stay false; trailing compactions and the standalone command card are excluded.
   * This layout travels with the summary so its headers do not depend on loading process bodies.
   */
  workBlocks: boolean[]
  errorMessage?: string
  startedAt: number
  endedAt: number
  /** Whether the turn has work beyond its summaries: the process disclosure has something behind it. */
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

export interface SessionBranchOptions {
  /** Tree restoration stops before a user message and returns it as unsent input. */
  restoreUserInput?: boolean
}

export interface RestoredSessionPrompt {
  text: string
  images: Array<{ mimeType: string; data: string }>
  textAttachments?: PastedTextAttachmentInput[]
}

/** A Pi fork is a separate session whose composer restores the selected user message. */
export interface ForkedSessionRef extends OpenSessionRef {
  restoredPrompt: RestoredSessionPrompt
}

/** Switching a branch answers with the new window and any input restored from the selected node. */
export interface SessionBranchRef extends DisplayTurnsResult {
  restoredPrompt?: RestoredSessionPrompt
}

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
export type SurfaceStyle = 'glass' | 'solid'
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
  surfaceStyle: SurfaceStyle
  appearance: Appearance
  lightTheme: PaletteId
  darkTheme: PaletteId
}

export interface AppSettings extends ThemePrefs {
  sendShortcut: SendShortcut
  completionNotifications: boolean
  beamBorderEnabled: boolean
  /** The stored choice: a locale, or `system` to follow the OS language. */
  localeSetting: LocaleSetting
  /** The OS language resolved against the shipped locales, for the `system` option's label. */
  systemLocale: Locale
  defaultModel: SessionModelInfo | null
  defaultThinkingLevel: ThinkingLevel | null
  thinkingLevels: ThinkingLevel[]
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

export type ReviewStep = 'preset' | 'branch' | 'commit' | 'instructions' | 'folders' | 'pr' | 'start' | 'finish'

export interface ReviewOption {
  value: string
  label: string
  description?: string
  recommended?: boolean
}

export type SystemUIEvent =
  | { kind: 'review-prompt'; id: string; sessionId: string; method: 'choose' | 'edit'; step: ReviewStep; options?: ReviewOption[]; prefill?: string }
  | { kind: 'dismiss'; id: string; sessionId: string }
  | { kind: 'notify'; sessionId: string; plugin: 'review' | 'memory' | 'host'; message: string; level: 'info' | 'warning' | 'error' }
  | { kind: 'review-state'; sessionId: string; active: boolean }
  | { kind: 'review-returning'; sessionId: string; returning: boolean }
  | { kind: 'reset'; sessionId: string }

export interface MemoryPluginSettings {
  observeAfterTokens?: number
  reflectAfterTokens?: number
  observerChunkMaxTokens?: number
  compactAfterTokens?: number
  compactAfterTokensMode?: 'calibrated' | 'ratio'
  compactAfterTokensRatio?: number
  compactionMaxRetainedTokens?: number
  compactionSummaryMaxTokens?: number
  compactionCatchUpMaxChunks?: number
  workerMemoryMaxTokens?: number
  observationsPoolMaxTokens?: number
  observationsPoolTargetTokens?: number
  agentMaxTurns?: number
  agentMaxTokens?: number
  model?: { provider: string; id: string; thinking?: ThinkingLevel }
  fallbackModel?: { provider: string; id: string; thinking?: ThinkingLevel }
  showWorkerNotifications?: boolean
  showCompactionNotifications?: boolean
  passive?: boolean
  debugLog?: boolean
  consolidateWhenIdle?: boolean
}

export type MemoryPluginSettingsPatch = { [K in keyof MemoryPluginSettings]?: MemoryPluginSettings[K] | null }

export type WebSearchFetchMode = 'readable' | 'raw' | 'answer'

/** A credential field the settings page writes into web-search.json. */
export interface WebSearchExtraField {
  /** Config path; dotted paths address nested objects such as browserCookies.browser. */
  key: string
  label: string
  env?: string
  type?: 'string' | 'boolean' | 'select'
  options?: string[]
}

/** `key` needs an API key, `none` works as-is, `piLogin` uses a Pi provider login. */
export type WebSearchCredentialKind = 'key' | 'none' | 'piLogin'

export interface WebSearchProviderOption {
  id: string
  name: string
  kind: WebSearchCredentialKind
  /** Pi login also works, so the API key is optional. */
  loginOptional?: boolean
  apiKeyKey?: string
  apiKeyEnv?: string
  baseUrlKey?: string
  baseUrlEnv?: string
  extras?: WebSearchExtraField[]
  note?: string
  group?: 'extract'
}

export interface WebSearchProviderState extends WebSearchProviderOption {
  apiKey: string
  baseUrl: string
  /** Current values keyed by the option's extra field keys. */
  extraValues: Record<string, string>
  /** Effective credential source; null means nothing is configured yet. */
  source: 'config' | 'env' | null
}

export interface WebSearchToolFlags {
  webSearch: boolean
  sourceCheck: boolean
  fetchContent: boolean
  getSearchContent: boolean
}

export interface WebSearchSettings {
  provider: string | null
  allowedProviders: string[] | null
  maxInlineContentChars: number | null
  fetchDefaultMode: WebSearchFetchMode | null
  fetchAllowedModes: WebSearchFetchMode[] | null
  ssrfAllowRanges: string[] | null
  ssrfTrustEnvProxy: boolean | null
  /** "same-origin" refuses redirects that leave the requested origin. */
  fetchRedirects: 'same-origin' | null
  tools: WebSearchToolFlags
}

export interface WebSearchSettingsState {
  settings: WebSearchSettings
  providers: WebSearchProviderState[]
  /** Set when the stored file is unusable; the panel still edits the readable values and repairs on save. */
  error: string | null
}

/** Null removes the key from web-search.json; omitted keys stay untouched. */
export interface WebSearchSettingsPatch {
  provider?: string | null
  allowedProviders?: string[] | null
  maxInlineContentChars?: number | null
  fetchDefaultMode?: string | null
  fetchAllowedModes?: string[] | null
  ssrfAllowRanges?: string[] | null
  ssrfTrustEnvProxy?: boolean | null
  fetchRedirects?: 'same-origin' | null
  tools?: Partial<WebSearchToolFlags>
  providers?: Record<string, { apiKey?: string | null; baseUrl?: string | null; extras?: Record<string, string | null> }>
}

export interface WebSearchTestResult {
  ok: boolean
  message: string
}

export interface BashExecutionResult {
  output: string
  exitCode?: number
  cancelled: boolean
  truncated: boolean
}

export interface SessionApi extends ToolSettingsApi {
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
  /** Returns after validation, session shutdown and durable enqueue, not directory cleanup. */
  deleteWorktree: (projectCwd: string, cwd: string, force?: boolean) => Promise<{ cwd: string } | null>
  listWorktreeDeletions: () => Promise<WorktreeDeletionJob[]>
  retryWorktreeDeletion: (cwd: string) => Promise<void>
  onWorktreeDeletionsChanged: (listener: (jobs: WorktreeDeletionJob[]) => void) => () => void
  /**
   * Names a worktree whose first attempt failed, from the earliest session's first message. Returns
   * as soon as the attempt is recorded; the outcome arrives through `onProjectsChanged` like the first try.
   */
  retryWorktreeNaming: (projectCwd: string, cwd: string) => Promise<void>
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
  /** Cancels the compaction in progress without touching a running agent or its queued prompts. */
  abortCompaction: (sessionId: string) => Promise<void>
  /**
   * Compacts the session context on demand. Any run in progress is aborted first, and a manual
   * compaction never resumes it. Failures reach the renderer as `compaction_end`, not as rejection.
   */
  compactSession: (sessionId: string, instructions?: string) => Promise<void>
  getDisplayTurns: (sessionId: string) => Promise<DisplayTurnsResult>
  getTurnWindow: (sessionId: string, start: number, count: number) => Promise<DisplayTurnsResult>
  getTurnMessages: (sessionId: string, turnId: string) => Promise<unknown[]>
  getSessionTrees: (
    sessionId: string,
    views?: SessionTreeView[]
  ) => Promise<Partial<Record<SessionTreeView, SessionTreeRow[]>>>
  setSessionLabel: (sessionId: string, targetId: string, label: string, path?: string) => Promise<void>
  viewBranch: (sessionId: string, tipId: string, options?: SessionBranchOptions) => Promise<SessionBranchRef>
  forkSession: (sessionId: string, userEntryId: string) => Promise<ForkedSessionRef | null>
  getControls: (sessionId: string) => Promise<SessionControls>
  getTokenStats: (sessionId: string) => Promise<SessionTokenStats>
  getCommands: (sessionId: string) => Promise<SlashCommand[]>
  exportSession: (sessionId: string) => Promise<{ path: string } | null>
  setModel: (sessionId: string, provider: string, id: string) => Promise<SessionControls>
  setThinking: (sessionId: string, level: ThinkingLevel) => Promise<SessionControls>
  /** The shared catalog, always read latest; a session id only says which probes to skip. */
  getModelCatalog: () => Promise<ModelCatalog>
  /** Re-reads the runtime and pushes the result to every window, including this one. */
  refreshModelCatalog: () => Promise<ModelCatalog>
  followUpAction: (sessionId: string, index: number, action: FollowUpAction, mode?: PromptStreamingBehavior) => Promise<RestoredSessionPrompt | null>
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
  /** The file tree's own writes, asked for from a row's context menu. */
  createFile: (cwd: string, path: string) => Promise<{ path: string }>
  createDirectory: (cwd: string, path: string) => Promise<{ path: string }>
  renameEntry: (cwd: string, path: string, name: string) => Promise<FileRenameResult>
  trashEntry: (cwd: string, path: string) => Promise<void>
  /** Puts the row's absolute path on the clipboard, resolved in main. */
  copyPath: (cwd: string, path: string) => Promise<void>
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
  /** Records a worktree's strip order: its sessions and changes tab, never its file tabs. */
  saveOpenProjectTabOrder: (cwd: string, tabIds: string[]) => Promise<void>
  /** Records the chats half's open chat tabs and which of them was showing. */
  saveOpenChatTabs: (tabIds: string[], activeTabId: string | null) => Promise<void>
  /** Native material support is available synchronously, before the document's first paint. */
  readonly supportsGlass: boolean
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
  getWebSearchSettings: () => Promise<WebSearchSettingsState>
  setWebSearchSettings: (patch: WebSearchSettingsPatch) => Promise<WebSearchSettingsState>
  testWebSearch: (provider: string | null) => Promise<WebSearchTestResult>
  replyReviewUI: (id: string, value: string | null) => Promise<void>
  onSystemUI: (listener: (event: SystemUIEvent) => void) => () => void
  onPluginsChanged: (listener: () => void) => () => void
  setSendShortcut: (shortcut: SendShortcut) => Promise<{ sendShortcut: SendShortcut }>
  setCompletionNotifications: (enabled: boolean) => Promise<{ completionNotifications: boolean }>
  setBeamBorderEnabled: (enabled: boolean) => Promise<{ beamBorderEnabled: boolean }>
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
  onModelCatalog: (listener: (catalog: ModelCatalog) => void) => () => void
}
