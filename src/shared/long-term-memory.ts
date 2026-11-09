/** Shared UI and runtime contract for task learning, maintained knowledge and source evidence. */
import type { ThinkingLevel } from './api'

export interface LongTermSettings {
  enabled: boolean
  model?: { provider: string; id: string; thinking?: ThinkingLevel }
}
export const MEMORY_KINDS = ['preference', 'project', 'knowledge', 'lesson'] as const
export type MemoryKind = typeof MEMORY_KINDS[number]
export type MemoryViewKind = MemoryKind | 'episodes'
export type MemoryScope = 'global' | 'project' | 'session'
export type MemoryStatus = 'active' | 'superseded' | 'disputed'
export type MemoryAssertion = 'user-statement' | 'inferred-preference' | 'tool-verified'
export interface LongTermFact {
  id: string
  content: string
  kind: MemoryKind
  scope: MemoryScope
  scopeKey: string
  projectKey: string
  checkoutKey: string
  status: MemoryStatus
  assertion: MemoryAssertion
  applicability: string
  sourceTime: string
  createdAt: string
  updatedAt: string
  supersedes?: string
}
export interface MemorySourceRef {
  sessionId: string
  sessionFile: string
  cwd: string
  anchorId: string
  entryId: string
  digest: string
  role: 'user' | 'assistant' | 'toolResult'
  timestamp: string
}
export interface LongTermEvidence {
  episodeId: string
  sources: MemorySourceRef[]
}
export interface TaskEpisode {
  id: string
  title: string
  content: string
  outcome: 'success' | 'partial' | 'fail' | 'uncertain'
  projectKey: string
  sessionId: string
  anchorId: string
  sourceTime: string
  updatedAt: string
  integration: 'pending' | 'done'
  sources: MemorySourceRef[]
}
export interface LongTermRetrievalTrace {
  id: string
  turnId: string
  renderKey: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  durationMs?: number
  memories: Pick<LongTermFact, 'id' | 'content' | 'scope' | 'status'>[]
}
export interface LongTermPage {
  episodes: TaskEpisode[]
  memories: LongTermFact[]
  nextOffset: number | null
}
export type MemoryFailureCode = 'configuration' | 'model' | 'authentication' | 'request' | 'rateLimit' | 'timeout' | 'truncated' | 'json' | 'schema' | 'evidence' | 'budget' | 'conflict' | 'storage'
export type MemoryWorkerStage = 'extraction' | 'integration' | 'relevance'
export interface MemoryLearningStatus {
  runningJobs: number
  pendingJobs: number
  pendingIntegrations: number
  lastSuccess: string | null
  lastError: { code: MemoryFailureCode; stage: MemoryWorkerStage; retryAt: string } | null
  usage: { stage: MemoryWorkerStage; requests: number; input: number; output: number; cost: number }[]
}
export interface LongTermMemoryApi {
  list(kind: MemoryViewKind, offset?: number): Promise<LongTermPage>
  evidence(id: string): Promise<LongTermEvidence[]>
  deleteEpisode(id: string): Promise<void>
  forget(id: string): Promise<void>
  status(): Promise<MemoryLearningStatus>
}
