/** Long-term memory's UI contract; evidence references never contain raw conversation bodies. */
import type { ThinkingLevel } from './api'

export interface LongTermSettings {
  enabled: boolean
  model?: { provider: string; id: string; thinking?: ThinkingLevel }
}
export type MemoryKind = 'preference' | 'decision' | 'lesson' | 'outcome'
export type MemoryScope = 'global' | 'project' | 'session'
export type MemoryStatus = 'active' | 'superseded' | 'disputed'
export interface LongTermFact {
  id: string
  content: string
  kind: MemoryKind
  scope: MemoryScope
  scopeKey: string
  status: MemoryStatus
  assertion: 'user-statement' | 'tool-verified'
  sourceTime: string
  createdAt: string
  supersedes?: string
}
/** Transient UI diagnostics, never persisted or provided to an observer as new evidence. */
export interface LongTermRetrievalTrace {
  id: string
  turnId: string
  renderKey: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  durationMs?: number
  memories: Pick<LongTermFact, 'id' | 'content' | 'scope' | 'status'>[]
}
export interface LongTermEvidence {
  candidateId: string
  sessionId: string
  reflectionEntryId: string
  reflectionId: string
  sourceEntryIds: string[]
}
export interface LongTermCandidateView {
  id: string
  content: string
  sessionId: string
  recordedAt: string
  status: 'pending' | 'accepted' | 'skipped'
}
export interface LongTermPage {
  candidates: LongTermCandidateView[]
  memories: LongTermFact[]
  nextOffset: number | null
}
export interface LongTermMemoryApi {
  list(kind: 'candidates' | 'memories', offset?: number): Promise<LongTermPage>
  evidence(id: string): Promise<LongTermEvidence[]>
  forget(kind: 'candidates' | 'memories', id: string): Promise<void>
}
