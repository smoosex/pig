/** Derives review candidates from branch-local OM evidence, never promotes reflections to facts. */
import { createHash } from 'node:crypto'
import {
  isObservationsRecordedEntry,
  isReflectionsRecordedEntry,
  type Entry,
  type Observation
} from '../session-ledger/types'

export interface CandidateOrigin {
  sessionId: string
  sessionFile: string
  cwd: string
}

export interface CandidateEvidence {
  observationId: string
  observationEntryId: string
  observationRecordIndex: number
  sourceEntryIds: string[]
}

export interface MemoryCandidate {
  id: string
  origin: CandidateOrigin
  reflectionEntryId: string
  reflectionRecordIndex: number
  reflectionId: string
  recordedAt: string
  content: string
  evidence: CandidateEvidence[]
}

export interface CandidateCollection {
  candidates: MemoryCandidate[]
  incomplete: number
  sensitive: number
}

// A first-pass exclusion, not a promise of universal secret detection. Never copy raw source bodies.
export const SENSITIVE_CONTENT = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|rk)-[a-zA-Z0-9_-]{20,}|\bgh[pousr]_[a-zA-Z0-9]{20,}|\bgithub_pat_[a-zA-Z0-9_]{20,}|\bAKIA[A-Z0-9]{16}\b|\b(?:password|api[_ -]?key|access[_ -]?token|secret)\s*[:=]\s*["']?[^\s"']{8,}/i

export function isDerivedMemoryTool(name: unknown): boolean {
  return typeof name === 'string' && (name.startsWith('memory_') || name === 'recall' || name === 'session_read')
}

export function collectMemoryCandidates(origin: CandidateOrigin, branch: readonly Entry[], reflectionEntryIds?: ReadonlySet<string>): CandidateCollection {
  const result: CandidateCollection = { candidates: [], incomplete: 0, sensitive: 0 }
  const sources = new Set<string>()
  const observations = new Map<string, { observation: Observation; entryId: string; index: number; validSources: boolean }[]>()
  for (const entry of branch) {
    // Only direct messages are evidence here. Branch summaries and injected custom messages may
    // contain inherited memory and must not manufacture independent cross-session support.
    if (entry.type === 'message') {
      const message = entry.message as { role?: string; toolName?: string } | undefined
      if (['user', 'assistant', 'toolResult'].includes(message?.role ?? '')
        && !(message?.role === 'toolResult' && isDerivedMemoryTool(message.toolName))) sources.add(entry.id)
    }
    if (isObservationsRecordedEntry(entry)) {
      entry.data.observations.forEach((observation, index) => {
        const matches = observations.get(observation.id) ?? []
        matches.push({ observation, entryId: entry.id, index, validSources: observation.sourceEntryIds.every(id => sources.has(id)) })
        observations.set(observation.id, matches)
      })
    }
    if (!isReflectionsRecordedEntry(entry) || (reflectionEntryIds && !reflectionEntryIds.has(entry.id))) continue
    entry.data.reflections.forEach((reflection, reflectionRecordIndex) => {
      const evidence: CandidateEvidence[] = []
      for (const id of new Set(reflection.supportingObservationIds)) {
        const matches = observations.get(id)
        // Ambiguous hashes and missing/forward/out-of-branch evidence fail closed.
        if (matches?.length !== 1) break
        const match = matches[0]!
        if (!match.validSources) break
        evidence.push({
          observationId: id,
          observationEntryId: match.entryId,
          observationRecordIndex: match.index,
          sourceEntryIds: [...new Set(match.observation.sourceEntryIds)]
        })
      }
      if (evidence.length === 0 || evidence.some(item => item.sourceEntryIds.length === 0) || evidence.length !== new Set(reflection.supportingObservationIds).size || !entry.timestamp || !Number.isFinite(Date.parse(entry.timestamp))) {
        result.incomplete++
        return
      }
      if (SENSITIVE_CONTENT.test(reflection.content)) {
        result.sensitive++
        return
      }
      const id = createHash('sha256').update(JSON.stringify([
        origin.sessionId, entry.id, reflectionRecordIndex, reflection.id
      ])).digest('hex')
      result.candidates.push({
        id, origin: { ...origin }, reflectionEntryId: entry.id, reflectionRecordIndex,
        reflectionId: reflection.id, recordedAt: entry.timestamp, content: reflection.content, evidence
      })
    })
  }
  return result
}
