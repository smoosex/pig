/** Read immutable raw evidence by session identity, branch address and source digest. */
import { readFileSync } from 'node:fs'
import { CURRENT_SESSION_VERSION, SessionManager, type FileEntry } from '@earendil-works/pi-coding-agent'
import type { LongTermEvidence } from '../../../../shared/long-term-memory'
import { SENSITIVE_CONTENT } from './hygiene'
import { sourceHash, messageText } from './sources'

export interface RecalledMemorySource {
  episodeId: string
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


export function recallLongTermSources(evidence: LongTermEvidence, offset = 0): RecalledMemorySource {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid memory source offset')
  const result: RecalledMemorySource = { episodeId: evidence.episodeId, status: 'unavailable', sources: [],
    nextOffset: offset + 4 < evidence.sources.length ? offset + 4 : null }
  let changed = false
  let unavailable = false
  const managers = new Map<string, SessionManager | undefined>()
  for (const ref of evidence.sources.slice(offset, offset + 4)) {
    if (!managers.has(ref.sessionFile)) managers.set(ref.sessionFile, loadSourceSession(ref.sessionFile))
    const manager = managers.get(ref.sessionFile)
    if (!manager) { unavailable = true; continue }
    const entry = manager.getEntry(ref.entryId)
    const anchor = manager.getEntry(ref.anchorId)
    if (manager.getSessionId() !== ref.sessionId || !entry || !anchor || sourceHash(entry) !== ref.digest
      || !manager.getBranch(ref.anchorId).some(item => item.id === ref.entryId)) { changed = true; continue }
    if (entry.type !== 'message' || entry.message.role !== ref.role) { changed = true; continue }
    let text = messageText(entry.message.content)
    if (SENSITIVE_CONTENT.test(text)) text = '[Source omitted: possible credentials]'
    const truncated = text.length > 2000
    result.sources.push({ id: ref.entryId, role: ref.role, timestamp: ref.timestamp,
      text: truncated ? text.slice(0, 2000) + '\n[... truncated ...]' : text, truncated })
  }
  result.status = changed ? 'changed' : unavailable || !result.sources.length ? 'unavailable' : 'available'
  return result
}
