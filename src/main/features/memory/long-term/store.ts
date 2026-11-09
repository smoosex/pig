/** Main-owned inbox and knowledge store. Short synchronous transactions never span model requests. */
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { MemoryCandidate } from './candidates'
import type { LongTermFact, LongTermEvidence, LongTermPage, MemoryScope } from '../../../../shared/long-term-memory'
import { memoryQuery, memoryTerms } from './search'
import { MemoryReviewError } from './review-errors'

export interface MemoryAccess { project: string; session: string }
export interface MemoryReview {
  candidate: MemoryCandidate
  action: 'skip' | 'add' | 'merge' | 'supersede' | 'dispute'
  targetId?: string
  fact?: Omit<LongTermFact, 'id' | 'createdAt' | 'status' | 'supersedes'>
  sourceEntryIds: string[]
}

function decodeFact(row: Record<string, unknown>): LongTermFact {
  return JSON.parse(row.payload as string) as LongTermFact
}
function scopeKey(scope: MemoryScope, access: MemoryAccess): string {
  return scope === 'global' ? 'global' : scope === 'project' ? access.project : access.session
}


export class MemoryCandidateStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    // SQLite's creation mode follows umask; pre-create privately before it writes anything.
    closeSync(openSync(path, 'a', 0o600))
    chmodSync(path, 0o600)
    this.db = new DatabaseSync(path, { timeout: 5_000 })
    try {
      this.db.exec('PRAGMA secure_delete = ON; PRAGMA foreign_keys = ON')
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS memory_candidates (
          id TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS candidate_collection_entries (
          session_id TEXT NOT NULL, entry_id TEXT NOT NULL,
          PRIMARY KEY (session_id, entry_id)
        );
        CREATE TABLE IF NOT EXISTS forgotten_candidates (
          id TEXT PRIMARY KEY
        );
        CREATE TABLE IF NOT EXISTS candidate_reviews (
          candidate_id TEXT PRIMARY KEY REFERENCES memory_candidates(id) ON DELETE CASCADE,
          status TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS long_term_facts (
          id TEXT PRIMARY KEY, payload TEXT NOT NULL,
          scope TEXT NOT NULL, scope_key TEXT NOT NULL, status TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_evidence (
          candidate_id TEXT PRIMARY KEY REFERENCES memory_candidates(id),
          memory_id TEXT NOT NULL REFERENCES long_term_facts(id), payload TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED, terms);
        INSERT INTO memory_fts(memory_fts, rank) VALUES ('secure-delete', 1);
        CREATE TABLE IF NOT EXISTS memory_state (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL);
        INSERT OR IGNORE INTO memory_state VALUES (1, 0);
        COMMIT;
      `)
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  collectionEntryProcessed(sessionId: string, entryId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM candidate_collection_entries WHERE session_id = ? AND entry_id = ?').get(sessionId, entryId)
  }

  enqueue(candidates: readonly MemoryCandidate[], progress?: { sessionId: string; entryIds: readonly string[] }): number {
    if (candidates.length === 0 && !progress?.entryIds.length) return 0
    const forgotten = this.db.prepare('SELECT 1 FROM forgotten_candidates WHERE id = ?')
    const existing = this.db.prepare('SELECT payload FROM memory_candidates WHERE id = ?')
    const insert = this.db.prepare('INSERT INTO memory_candidates (id, payload, created_at) VALUES (?, ?, ?)')
    let added = 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const candidate of candidates) {
        if (forgotten.get(candidate.id)) continue
        const payload = JSON.stringify(candidate)
        const previous = existing.get(candidate.id)
        if (previous) {
          if (previous.payload !== payload) throw new Error('Long-term memory candidate source changed')
          continue
        }
        if (this.collectionEntryProcessed(candidate.origin.sessionId, candidate.reflectionEntryId)) continue
        insert.run(candidate.id, payload, new Date().toISOString())
        added++
      }
      if (progress) {
        const checkpoint = this.db.prepare('INSERT OR IGNORE INTO candidate_collection_entries VALUES (?, ?)')
        for (const entryId of progress.entryIds) checkpoint.run(progress.sessionId, entryId)
      }
      this.db.exec('COMMIT')
      return added
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  list(limit = 50): MemoryCandidate[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid candidate page size')
    return this.db.prepare('SELECT payload FROM memory_candidates ORDER BY created_at, id LIMIT ?')
      .all(limit).map(row => JSON.parse(row.payload as string) as MemoryCandidate)
  }

  deleteCandidate(id: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const candidate = this.candidate(id)
      if (candidate) {
        this.discardCandidate(candidate)
        this.bump()
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  candidate(id: string): MemoryCandidate | undefined {
    const row = this.db.prepare('SELECT payload FROM memory_candidates WHERE id = ?').get(id)
    return row ? JSON.parse(row.payload as string) as MemoryCandidate : undefined
  }

  revision(): number {
    return this.db.prepare('SELECT revision FROM memory_state WHERE id = 1').get()!.revision as number
  }

  pending(sessionId: string, branchIds: ReadonlySet<string>, limit = 4): MemoryCandidate[] {
    return this.unreviewed(sessionId).filter(candidate => branchIds.has(candidate.id)).slice(0, limit)
  }

  unreviewed(sessionId: string): MemoryCandidate[] {
    return this.db.prepare(`SELECT c.payload FROM memory_candidates c
      LEFT JOIN candidate_reviews r ON c.id = r.candidate_id
      WHERE r.candidate_id IS NULL AND json_extract(c.payload, '$.origin.sessionId') = ?
      ORDER BY c.created_at, c.id`).all(sessionId)
      .map(row => JSON.parse(row.payload as string) as MemoryCandidate)
  }

  page(kind: 'candidates' | 'memories', offset = 0): LongTermPage {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid memory page offset')
    if (kind === 'candidates') {
      const rows = this.db.prepare(`SELECT c.payload FROM memory_candidates c
        LEFT JOIN candidate_reviews r ON c.id = r.candidate_id
        WHERE r.candidate_id IS NULL
        ORDER BY c.created_at DESC, c.id LIMIT 51 OFFSET ?`).all(offset)
      return {
        candidates: rows.slice(0, 50).map(row => {
          const candidate = JSON.parse(row.payload as string) as MemoryCandidate
          return { id: candidate.id, content: candidate.content, recordedAt: candidate.recordedAt,
            sessionId: candidate.origin.sessionId, status: 'pending' as const }
        }),
        memories: [], nextOffset: rows.length > 50 ? offset + 50 : null,
      }
    }
    const rows = this.db.prepare('SELECT payload FROM long_term_facts ORDER BY rowid DESC LIMIT 51 OFFSET ?').all(offset)
    return { candidates: [], memories: rows.slice(0, 50).map(decodeFact), nextOffset: rows.length > 50 ? offset + 50 : null }
  }

  read(id: string, access: MemoryAccess): LongTermFact | undefined {
    const row = this.db.prepare('SELECT payload FROM long_term_facts WHERE id = ?').get(id)
    if (!row) return undefined
    const fact = decodeFact(row)
    return fact.scopeKey === scopeKey(fact.scope, access) ? fact : undefined
  }

  evidence(id: string): LongTermEvidence[] {
    return this.db.prepare('SELECT payload FROM memory_evidence WHERE memory_id = ? ORDER BY candidate_id').all(id)
      .map(row => JSON.parse(row.payload as string) as LongTermEvidence)
  }

  search(query: string, access: MemoryAccess, limit = 5): LongTermFact[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid memory search limit')
    const expression = memoryQuery(query)
    if (!expression) return []
    return this.db.prepare(`SELECT f.payload FROM memory_fts JOIN long_term_facts f ON f.id = memory_fts.id
      WHERE memory_fts MATCH ? AND f.status IN ('active', 'disputed')
      AND ((f.scope = 'global' AND f.scope_key = 'global') OR (f.scope = 'project' AND f.scope_key = ?)
        OR (f.scope = 'session' AND f.scope_key = ?))
      ORDER BY bm25(memory_fts), f.id LIMIT ?`).all(expression, access.project, access.session, limit).map(decodeFact)
  }

  /** Commit only against the knowledge snapshot used by the worker. Forgetting wins over late replies. */
  review(reviews: readonly MemoryReview[], revision: number): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (this.revision() !== revision) throw new MemoryReviewError('conflict', 'Long-term memory changed during review')
      for (const review of reviews) {
        const { candidate, action } = review
        const row = this.db.prepare('SELECT payload FROM memory_candidates WHERE id = ?').get(candidate.id)
        if (!row || row.payload !== JSON.stringify(candidate)
          || this.db.prepare('SELECT 1 FROM candidate_reviews WHERE candidate_id = ?').get(candidate.id)) {
          throw new MemoryReviewError('conflict', 'Long-term memory candidate changed during review')
        }
        if (action === 'skip') {
          this.discardCandidate(candidate)
          continue
        }
        if (!review.fact) throw new Error('Memory review has no fact')
        let target: LongTermFact | undefined
        if (review.targetId) {
          const existing = this.db.prepare('SELECT payload FROM long_term_facts WHERE id = ?').get(review.targetId)
          target = existing ? decodeFact(existing) : undefined
          if (!target || target.status !== 'active' || target.scope !== review.fact.scope || target.scopeKey !== review.fact.scopeKey) {
            throw new Error('Memory review target is unavailable or outside scope')
          }
        }
        if (action !== 'add' && !target) throw new Error('Memory review target is required')
        if (action === 'supersede' && (review.fact.assertion !== 'user-statement' || review.fact.sourceTime <= target!.sourceTime)) {
          throw new Error('Only a newer user correction can supersede memory')
        }
        // Exact normalized copies merge support, never increase confidence or resurrect old facts.
        const duplicate = action === 'add' ? this.db.prepare(`SELECT payload FROM long_term_facts
          WHERE status = 'active' AND scope = ? AND scope_key = ? AND json_extract(payload, '$.content') = ?`)
          .get(review.fact.scope, review.fact.scopeKey, review.fact.content) : undefined
        const merged = action === 'merge' ? target : duplicate ? decodeFact(duplicate) : undefined
        const id = merged?.id ?? candidate.id
        if (merged && merged.assertion === review.fact.assertion && review.fact.sourceTime > merged.sourceTime) {
          this.db.prepare('UPDATE long_term_facts SET payload = ? WHERE id = ?')
            .run(JSON.stringify({ ...merged, sourceTime: review.fact.sourceTime }), id)
        }
        if (action === 'supersede' || action === 'dispute') {
          const previous = { ...target!, status: action === 'supersede' ? 'superseded' as const : 'disputed' as const }
          this.db.prepare('UPDATE long_term_facts SET payload = ?, status = ? WHERE id = ?')
            .run(JSON.stringify(previous), previous.status, previous.id)
        }
        if (action !== 'merge' && !duplicate) {
          const fact: LongTermFact = { ...review.fact, id, status: action === 'dispute' ? 'disputed' : 'active',
            createdAt: new Date().toISOString(), ...(action === 'supersede' ? { supersedes: target!.id } : {}) }
          this.db.prepare('INSERT INTO long_term_facts VALUES (?, ?, ?, ?, ?)')
            .run(id, JSON.stringify(fact), fact.scope, fact.scopeKey, fact.status)
          this.db.prepare('INSERT INTO memory_fts (id, terms) VALUES (?, ?)').run(id, memoryTerms(fact.content).join(' '))
        }
        const evidence: LongTermEvidence = { candidateId: candidate.id, sessionId: candidate.origin.sessionId,
          reflectionEntryId: candidate.reflectionEntryId, reflectionId: candidate.reflectionId,
          sourceEntryIds: review.sourceEntryIds }
        this.db.prepare('INSERT INTO memory_evidence VALUES (?, ?, ?)').run(candidate.id, id, JSON.stringify(evidence))
        this.db.prepare('INSERT INTO candidate_reviews VALUES (?, ?)').run(candidate.id, 'accepted')
      }
      this.bump()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  forgetFact(id: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try { this.removeFact(id); this.bump(); this.db.exec('COMMIT') }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private bump(): void { this.db.exec('UPDATE memory_state SET revision = revision + 1 WHERE id = 1') }

  /** Manual deletion and model rejection share exactly the same pending-only operation. */
  private discardCandidate(candidate: MemoryCandidate): void {
    if (this.db.prepare('SELECT 1 FROM candidate_reviews WHERE candidate_id = ?').get(candidate.id)
      || this.db.prepare('SELECT 1 FROM memory_evidence WHERE candidate_id = ?').get(candidate.id)) {
      throw new Error('Only pending candidates can be deleted')
    }
    this.db.prepare('INSERT OR IGNORE INTO candidate_collection_entries VALUES (?, ?)')
      .run(candidate.origin.sessionId, candidate.reflectionEntryId)
    this.db.prepare('DELETE FROM memory_candidates WHERE id = ?').run(candidate.id)
  }

  private removeCandidate(id: string): void {
    this.db.prepare('INSERT OR IGNORE INTO forgotten_candidates VALUES (?)').run(id)
    this.db.prepare('DELETE FROM candidate_reviews WHERE candidate_id = ?').run(id)
    this.db.prepare('DELETE FROM memory_candidates WHERE id = ?').run(id)
  }

  private removeFact(id: string): void {
    const ids = this.db.prepare('SELECT candidate_id FROM memory_evidence WHERE memory_id = ?').all(id)
    this.db.prepare('DELETE FROM memory_evidence WHERE memory_id = ?').run(id)
    for (const row of ids) this.removeCandidate(row.candidate_id as string)
    this.db.prepare('DELETE FROM memory_fts WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM long_term_facts WHERE id = ?').run(id)
  }

  close(): void {
    this.db.close()
  }
}
