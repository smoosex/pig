/** Resolve persisted evidence by exact session/ledger addresses; missing history is explicit, never guessed. */
import { readFileSync } from 'node:fs'
import { CURRENT_SESSION_VERSION, SessionManager, type FileEntry } from '@earendil-works/pi-coding-agent'
import type { LongTermEvidence } from '../../../../shared/long-term-memory'
import type { Entry } from '../session-ledger/types'
import { collectMemoryCandidates, SENSITIVE_CONTENT, type MemoryCandidate } from './candidates'

export interface RecalledMemorySource {
  candidateId: string
  status: 'available' | 'unavailable' | 'changed'
  sources: { id: string; role: string; timestamp: string; text: string; truncated: boolean }[]
  nextOffset: number | null
}

// SDK file loaders repair and migrate on disk; only the in-memory manager may touch these entries.
function loadSourceSession(path: string): SessionManager | undefined {
  let bytes: Buffer
  try { bytes = readFileSync(path) } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw error
  }
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const entries: FileEntry[] = []
  for (const [index, line] of content.split('\n').entries()) {
    if (!line.trim()) continue
    let entry: FileEntry
    try { entry = JSON.parse(line) } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      // Native JSON errors may quote source text containing credentials.
      throw new SyntaxError(`Invalid memory source JSON at line ${index + 1}`)
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.type !== 'string') {
      throw new SyntaxError(`Invalid memory source entry at line ${index + 1}`)
    }
    entries.push(entry)
  }
  if (!entries.length) return undefined
  const header = entries[0]!
  if (header.type !== 'session' || typeof header.id !== 'string' || !header.id || typeof header.cwd !== 'string') {
    throw new SyntaxError('Invalid memory source session header')
  }
  const version = header.version ?? 1
  if (!Number.isInteger(version) || version < 1 || version > CURRENT_SESSION_VERSION) {
    throw new RangeError('Unsupported memory source session version')
  }
  const ids = new Set<string>()
  for (const entry of entries.slice(1)) {
    if (entry.type === 'session') throw new SyntaxError('Duplicate memory source session header')
    if (version < 2) continue // The SDK assigns legacy linear entries their tree addresses in memory.
    if (typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)
      || (entry.parentId !== null && (typeof entry.parentId !== 'string' || !ids.has(entry.parentId)))) {
      throw new SyntaxError('Invalid memory source entry tree')
    }
    ids.add(entry.id)
  }
  return SessionManager.inMemory(header.cwd, undefined, entries)
}

export function recallLongTermSources(candidate: MemoryCandidate, evidence: LongTermEvidence, offset = 0): RecalledMemorySource {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid memory source offset')
  const result: RecalledMemorySource = { candidateId: candidate.id, status: 'unavailable', sources: [], nextOffset: null }
  const manager = loadSourceSession(candidate.origin.sessionFile)
  if (!manager) return result
  if (manager.getSessionId() !== candidate.origin.sessionId) return { ...result, status: 'changed' }
  const branch = manager.getBranch(candidate.reflectionEntryId) as Entry[]
  const recorded = collectMemoryCandidates(candidate.origin, branch).candidates.find(item => item.id === candidate.id)
  if (!recorded || JSON.stringify(recorded) !== JSON.stringify(candidate)) return { ...result, status: 'changed' }
  const ids = new Set(evidence.sourceEntryIds.slice(offset, offset + 4))
  result.nextOffset = offset + 4 < evidence.sourceEntryIds.length ? offset + 4 : null
  for (const entry of branch) {
    if (!ids.has(entry.id) || entry.type !== 'message') continue
    const message = entry.message as { role: string; content: unknown; timestamp?: number }
    let text = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
      ? message.content.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n') : ''
    if (SENSITIVE_CONTENT.test(text)) text = '[source omitted: may contain credentials]'
    const truncated = text.length > 2000
    result.sources.push({ id: entry.id, role: message.role, timestamp: message.timestamp !== undefined ? new Date(message.timestamp).toISOString() : entry.timestamp ?? 'unknown', text: truncated ? text.slice(0, 2000) + '\n[... truncated ...]' : text, truncated })
    if (result.sources.length === 4) break
  }
  result.status = result.sources.length ? 'available' : 'unavailable'
  return result
}
