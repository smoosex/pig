import type { AgentSession, SessionManager } from '@earendil-works/pi-coding-agent'
import type { BrowserWindow } from 'electron'
import type { ThinkingLevel } from '../../shared/api'

export interface LiveSession {
  sessionId: string
  cwd: string
  agentSession: AgentSession
  unsubscribe: () => void
}

export interface PendingSession {
  sessionId: string
  cwd: string
  sessionManager: SessionManager
  win: BrowserWindow
  /** Existing JSONL sessions already have a file; drafts need materialization first. */
  needsMaterialize?: boolean
  modelProvider?: string
  modelId?: string
  thinkingLevel?: ThinkingLevel
}

export type SessionState = LiveSession | PendingSession
