import type { AgentSession, SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent'
import type { BrowserWindow } from 'electron'
import type { SessionTokenStats, SessionTreeRow, SessionTreeView, ThinkingLevel } from '../../shared/api'
import type { SessionFileIndex } from './session-jsonl'

export interface LiveSession {
  sessionId: string
  cwd: string
  agentSession: AgentSession
  unsubscribe: () => void
  pluginPaths?: string[]
  toolProject?: string | null
  win?: BrowserWindow
}

interface PendingBase {
  sessionId: string
  cwd: string
  win: BrowserWindow
  modelProvider?: string
  modelId?: string
  thinkingLevel?: ThinkingLevel
}

/** Entries live in an in-memory manager: a draft, or a file this reader cannot index. */
export interface MemorySession extends PendingBase {
  kind: 'memory'
  sessionManager: SessionManager
}

/** An opened JSONL session read through the byte index; the SDK build waits for the first interaction. */
export interface SessionFileSession extends PendingBase {
  kind: 'file'
  path: string
  /**
   * The branch index, built after the first paint rather than before it: opening reads only the
   * tail, and everything that needs every line waits for this one promise.
   */
  index: SessionFileIndex | null
  indexing: Promise<SessionFileIndex> | null
  /** The tail entries, so an image in the first painted window resolves before the index exists. */
  tailById: Map<string, SessionEntry> | null
  /** Turns that tail window held: the branch index uses it to place the window it already handed out. */
  tailTurns: number
  /** Scans that were started for this file, so a file that keeps failing is not scanned on every read. */
  indexAttempts?: number
  /** A scan is queued for this file but has not started yet. */
  indexScheduled?: boolean
  /** Read once on demand: nothing writes to a file before the pending phase ends. */
  tokens?: SessionTokenStats
  /** The tree views read so far: the file cannot change while the session is pending. */
  treeRows?: Partial<Record<SessionTreeView, SessionTreeRow[]>>
  /** The tree read on its way, so concurrent callers share one build. */
  treeRowsRequest?: {
    views: SessionTreeView[]
    promise: Promise<Partial<Record<SessionTreeView, SessionTreeRow[]>>>
  } | null
}

export type PendingSession = MemorySession | SessionFileSession
export type SessionState = LiveSession | PendingSession
