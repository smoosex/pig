/** Shared cross-process contracts for Pig's single-Bot orchestration, task ledger, notices, and UI timeline. */
import type { SessionControls, ThinkingLevel } from './api'
import type { PermissionMode } from './permissions'
import type { PastedTextAttachmentInput } from './pasted-text'

export interface BotImageAttachment {
  mimeType: string
  data: string
}

export type BotTextAttachment = PastedTextAttachmentInput

export type BotTaskMode = 'read' | 'write'

export type BotTaskStatus =
  | 'starting'
  | 'running'
  | 'blocked_approval'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'taken_over'
  | 'interrupted'

export type BotRunStatus =
  | 'starting'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'interrupted'

export type BotStopOrigin =
  | 'user'
  | 'bot'
  | 'takeover'
  | 'project_removed'
  | 'worktree_deleted'
  | 'session_closed'
  | 'app_shutdown'

export interface BotWorkspace {
  kind: 'worktree' | 'project'
  cwd: string
  branch?: string
  baseHead?: string
  cleanedUpAt?: number
}

export interface BotFileChangeSummary {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  added?: number
  removed?: number
}

export interface BotTaskReceipt {
  summary: string
  changedFiles: BotFileChangeSummary[]
  totalAdded: number
  totalRemoved: number
  artifactPaths?: string[]
  errorCode?: string
  errorMessage?: string
  collectedAt: number
}

export interface BotTaskDelivery {
  state: 'pending' | 'delivered' | 'fallback' | 'failed'
  lastNoticeId?: string
  deliveredAt?: number
  error?: string
}

export interface BotModelOverride {
  provider: string
  id: string
}

/** Avatar styles supported by the bundled `bot-avatars` package. */
export const BOT_AVATAR_TYPES = [
  'clover',
  'flower',
  'triangle',
  'square',
  'blob',
  'ghost',
  'circle',
  'drop',
  'star',
  'droid',
  'mech',
  'alien',
  'hexagon',
  'cat',
  'cloud',
  'pill',
  'pebble',
  'puddle'
] as const

export type BotAvatarId = (typeof BOT_AVATAR_TYPES)[number]

export const DEFAULT_BOT_AVATAR: BotAvatarId = 'clover'

export function isBotAvatarId(value: unknown): value is BotAvatarId {
  return typeof value === 'string' && (BOT_AVATAR_TYPES as readonly string[]).includes(value)
}

export interface BotPreferencesPatch {
  avatar?: BotAvatarId
  delegateModel?: BotModelOverride | null
  delegateThinkingLevel?: ThinkingLevel | null
}

export interface BotRun {
  runId: string
  taskId: string
  sessionId?: string
  cwd: string
  sessionTaskId?: string
  status: BotRunStatus
  stopOrigin?: BotStopOrigin
  startedAt: number
  endedAt?: number
  durationMs?: number
  modelOverride?: BotModelOverride
  thinkingOverride?: ThinkingLevel
}

export interface BotTaskCapabilities {
  browser?: boolean
}

export interface BotTask {
  taskId: string
  title: string
  summary: string
  intent: string
  projectCwd: string
  mode: BotTaskMode
  workspace: BotWorkspace
  status: BotTaskStatus
  activeRunId?: string
  runs: BotRun[]
  latestReceipt?: BotTaskReceipt
  delivery: BotTaskDelivery
  capabilities?: BotTaskCapabilities
  createdAt: number
  updatedAt: number
}

export type BotNoticeKind =
  | 'task_completed'
  | 'task_failed'
  | 'task_start_failed'
  | 'task_stopped'
  | 'task_stopped_by_user'
  | 'task_taken_over'
  | 'task_blocked_approval'
  | 'task_interrupted'

export type BotNoticeState = 'pending' | 'delivering' | 'delivered' | 'fallback' | 'failed'

export interface BotNotice {
  noticeId: string
  kind: BotNoticeKind
  taskId: string
  runId: string
  sessionId?: string
  projectCwd: string
  branch?: string
  worktreePath?: string
  stopOrigin?: BotStopOrigin
  summary?: string
  receipt?: BotTaskReceipt
  approvalRequestId?: string
  createdAt: number
  deliveredAt?: number
  state: BotNoticeState
  error?: string
}

export interface BotAttachmentItem {
  path: string
  name: string
  exists: boolean
  size?: number
}

export type BotTimelineItem =
  | {
      id: string
      kind: 'user'
      text: string
      images?: BotImageAttachment[]
      textAttachments?: BotTextAttachment[]
      projectMentions?: string[]
      createdAt: number
    }
  | {
      id: string
      kind: 'assistant'
      messageType: 'text' | 'delivery' | 'attachment'
      content: string
      taskIds?: string[]
      attachments?: BotAttachmentItem[]
      createdAt: number
    }
  | {
      id: string
      kind: 'system_fallback'
      reason: 'no_message' | 'error' | 'delivery_fallback'
      text: string
      taskIds?: string[]
      retryable?: boolean
      createdAt: number
    }

export type BotSurface = 'workspace' | 'bot'

export interface BotArchivedSession {
  sessionId: string
  archivedAt: number
  reason: 'reset'
}

export interface BotState {
  version: 1
  sessionId: string
  cwd: string
  lastSurface: BotSurface
  avatar?: BotAvatarId
  model?: BotModelOverride
  thinkingLevel?: ThinkingLevel
  delegateModel?: BotModelOverride
  delegateThinkingLevel?: ThinkingLevel
  archivedSessions: BotArchivedSession[]
  createdAt: number
  updatedAt: number
}

export interface BotMirroredApproval {
  requestId: string
  sessionId: string
  taskId?: string
  taskTitle?: string
  projectCwd?: string
  projectName?: string
  summary: string
  kind?: string
  createdAt: number
}

export interface BotPeekMessage {
  id: string
  kind: 'message' | 'delivery' | 'approval'
  text: string
  statusBadge?: string
  projectName?: string
  taskId?: string
  requestId?: string
  createdAt: number
}

export interface BotSnapshot {
  eventCursor?: number
  state: BotState
  timeline: BotTimelineItem[]
  tasks: BotTask[]
  streaming: boolean
  unreadCount: number
  approvals: BotMirroredApproval[]
  controls: SessionControls | null
  permissionMode: PermissionMode
}

export type BotEvent = { cursor?: number } & (
  | { type: 'timeline_item'; item: BotTimelineItem }
  | { type: 'timeline_replaced'; timeline: BotTimelineItem[] }
  | { type: 'streaming_changed'; streaming: boolean }
  | { type: 'task_updated'; task: BotTask }
  | { type: 'tasks_replaced'; tasks: BotTask[] }
  | { type: 'approvals_changed'; approvals: BotMirroredApproval[] }
  | { type: 'peek'; message: BotPeekMessage }
  | { type: 'controls_changed'; controls: SessionControls | null }
  | { type: 'permission_changed'; mode: PermissionMode }
  | { type: 'state_changed'; state: BotState }
)

export interface BotDelegateTaskInput {
  projectCwd: string
  title: string
  intent: string
  mode: BotTaskMode
  slug?: string
  capabilities?: BotTaskCapabilities
  modelOverride?: BotModelOverride
  thinkingOverride?: ThinkingLevel
  confirmSharedNonGitWrite?: boolean
}

export interface BotDelegateTaskAck {
  taskId: string
  runId: string
  projectCwd: string
  mode: BotTaskMode
  status: 'starting'
}

export interface BotManagedSessionInfo {
  taskId: string
  runId: string
  title: string
  projectCwd: string
  branch?: string
  status: BotTaskStatus
  runStatus: BotRunStatus
}

export interface BotWorktreeCleanupSafety {
  snapshot?: string
  branch?: string
  dirty: boolean
  unmerged: boolean
  needsForceConfirm: boolean
}

export interface BotApi {
  getSnapshot: () => Promise<BotSnapshot>
  setSurface: (surface: BotSurface) => Promise<BotState>
  updatePreferences: (patch: BotPreferencesPatch) => Promise<BotState>
  sendMessage: (input: {
    text: string
    images?: BotImageAttachment[]
    textAttachments?: BotTextAttachment[]
    projectMentions?: string[]
  }) => Promise<BotTimelineItem>
  retryLastMessage: () => Promise<BotTimelineItem | null>
  abortCurrentTurn: () => Promise<void>
  setPermissionMode: (mode: PermissionMode) => Promise<PermissionMode>
  setModel: (provider: string, id: string) => Promise<SessionControls | null>
  setThinking: (level: ThinkingLevel) => Promise<SessionControls | null>
  exportSession: () => Promise<{ path: string } | null>
  resetContext: () => Promise<BotSnapshot>
  listTasks: (filter?: { status?: 'active' | 'all' | 'completed' | 'failed' | 'stopped' }) => Promise<BotTask[]>
  getTask: (taskId: string) => Promise<BotTask | null>
  stopTask: (taskId: string) => Promise<BotTask>
  takeOverTask: (taskId: string) => Promise<BotTask>
  followupTask: (taskId: string, instruction: string) => Promise<BotDelegateTaskAck>
  checkWorktreeCleanup: (taskId: string) => Promise<BotWorktreeCleanupSafety>
  cleanupWorktree: (taskId: string, confirmation?: string) => Promise<{ cleaned: boolean; branch?: string }>
  getManagedSessionInfo: (sessionId: string) => Promise<BotManagedSessionInfo | null>
  onEvent: (listener: (event: BotEvent) => void) => () => void
}

export function isBotTaskActive(status: BotTaskStatus): boolean {
  return status === 'starting' || status === 'running' || status === 'blocked_approval'
}
