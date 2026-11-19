/** Bounded local telemetry schemas for manual Dream memory health audits. Never holds note bodies or raw errors. */
import type { MemoryScope } from '../../../../shared/long-term-memory'

export type MemoryTelemetryOutcome = 'completed' | 'aborted' | 'error' | 'steered' | 'unknown'
export type MemoryTelemetryOpName = 'read' | 'search' | 'list' | 'add' | 'edit' | 'delete'

export interface MemoryTelemetryGap {
  calls: number
  errs: number
}

export interface MemoryTelemetryOp {
  op: MemoryTelemetryOpName
  scope: MemoryScope
  projectId?: string
  ok: boolean
  gap: MemoryTelemetryGap
  path?: string
  pathOmitted?: boolean
  from?: string
  fromOmitted?: boolean
  rev?: string
  beforeRev?: string
  afterRev?: string
  offset?: number
  hasMore?: boolean
  query?: string
  hits?: number
  count?: number
  err?: string
  committed?: boolean
}

export interface MemoryTelemetryRow {
  v: 1
  at: number
  sessionId: string
  turnId: string
  anchorEntryId?: string
  projectId?: string
  outcome: MemoryTelemetryOutcome
  ops: MemoryTelemetryOp[]
  tail: MemoryTelemetryGap
  opsTruncated?: boolean
}

export interface MemoryTelemetryCoverage {
  windowDays: number
  windowStartAt: number
  windowEndAt: number
  observedStartAt?: number
  observedEndAt?: number
  reliableStartAt?: number
  totalRows: number
  totalTurns: number
  truncatedRows: number
  complete: boolean
  incompleteReasons: string[]
  skippedLines: number
  truncatedShards: string[]
  missingShards: string[]
  corruptShards: string[]
  unreadableShards: string[]
}

export interface MemoryTelemetryWindow {
  rows: MemoryTelemetryRow[]
  coverage: MemoryTelemetryCoverage
}

export type AuditCandidateKind = 'poisoned' | 'high_churn' | 'structure' | 'clickbait' | 'repeated_miss' | 'stale'
export type AuditKeepKind = Exclude<AuditCandidateKind, 'repeated_miss'>
export type AuditStructureSubkind = 'broken_link' | 'orphan'

export interface AuditKeptEntry {
  scope: MemoryScope
  projectId?: string
  path: string
  rev: string
  kind: AuditKeepKind
  subkind?: AuditStructureSubkind
  defectKey?: string
  from?: string
  fromRev?: string
  checkedAt: number
  signalThrough: number
}

export interface AuditStateFile {
  v: 1
  kept: AuditKeptEntry[]
}
