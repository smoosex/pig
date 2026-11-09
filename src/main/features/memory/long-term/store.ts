/** Durable task learning and knowledge. Model work never holds a SQLite transaction. */
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { LongTermFact, LongTermEvidence, LongTermPage, MemoryKind, MemoryViewKind, MemoryLearningStatus, TaskEpisode, MemoryFailureCode, MemoryWorkerStage } from '../../../../shared/long-term-memory'
import { memoryQuery, memoryTerms } from './search'
import { MemoryReviewError } from './review-errors'
import type { LearningWindow, WindowRecord } from './sources'
import { windowRecord, sourceHash } from './sources'
import type { KnowledgeProposal, LearningResult } from './learning'

export interface MemoryAccess { project: string; session: string; cwd?: string }
export interface KnowledgeChange { proposalId: string; action: 'skip' | 'add' | 'merge' | 'revise' | 'supersede' | 'dispute'; targetId?: string; fact?: Omit<LongTermFact, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'supersedes'> }
export interface PendingIntegration { episode: TaskEpisode; proposals: KnowledgeProposal[] }
const decode = <T>(row: Record<string, unknown>): T => JSON.parse(row.payload as string) as T
const visible = (fact: LongTermFact, access: MemoryAccess): boolean => (!fact.checkoutKey || fact.checkoutKey === (access.cwd ?? access.project)) && (fact.scope === 'global' ? fact.scopeKey === 'global'
  : fact.scope === 'project' ? fact.scopeKey === access.project : fact.scopeKey === access.session)

export class LongTermMemoryStore {
  private readonly db: DatabaseSync
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    closeSync(openSync(path, 'a', 0o600)); chmodSync(path, 0o600)
    this.db = new DatabaseSync(path, { timeout: 5_000 })
    try {
      // Old reflection schemas are neither read nor migrated; never silently destroy a user's file.
      if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_candidates'").get()) {
        throw new Error('Long-term memory schema changed. Quit Pig and explicitly clear the old long-term.sqlite database.')
      }
      this.db.exec(`PRAGMA secure_delete = ON; PRAGMA foreign_keys = ON;
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS learning_sessions (session_id TEXT PRIMARY KEY, initialized_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS learning_checkpoints (session_id TEXT NOT NULL, entry_id TEXT NOT NULL, PRIMARY KEY(session_id, entry_id));
        CREATE TABLE IF NOT EXISTS learning_jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL, retry_at INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS task_episodes (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, anchor_id TEXT NOT NULL, integration TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS episodes_session ON task_episodes(session_id, integration);
        CREATE TABLE IF NOT EXISTS knowledge_proposals (id TEXT PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES task_episodes(id) ON DELETE CASCADE, payload TEXT NOT NULL);
        CREATE VIRTUAL TABLE IF NOT EXISTS episode_fts USING fts5(id UNINDEXED, terms);
        INSERT INTO episode_fts(episode_fts, rank) VALUES ('secure-delete', 1);
        CREATE TABLE IF NOT EXISTS knowledge_items (id TEXT PRIMARY KEY, kind TEXT NOT NULL, scope TEXT NOT NULL, scope_key TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS knowledge_evidence (memory_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE, episode_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(memory_id, episode_id));
        CREATE TABLE IF NOT EXISTS knowledge_relations (source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation TEXT NOT NULL, PRIMARY KEY(source_id, target_id));
        CREATE TABLE IF NOT EXISTS forgotten_sources (source_key TEXT PRIMARY KEY);
        CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(id UNINDEXED, terms);
        INSERT INTO knowledge_fts(knowledge_fts, rank) VALUES ('secure-delete', 1);
        CREATE TABLE IF NOT EXISTS learning_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, source_revision INTEGER NOT NULL DEFAULT 0, last_success TEXT, last_error TEXT);
        INSERT OR IGNORE INTO learning_state(id, revision) VALUES (1, 0);
        CREATE TABLE IF NOT EXISTS learning_usage (stage TEXT PRIMARY KEY, requests INTEGER NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cost REAL NOT NULL);
        COMMIT;`)
    } catch (error) { this.db.close(); throw error }
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = work(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private bump(): void { this.db.exec('UPDATE learning_state SET revision=revision+1 WHERE id=1') }
  private check(revision: number): void {
    if (this.revision() !== revision) throw new MemoryReviewError('conflict', 'Long-term memory changed during learning')
  }
  revision(): number { return this.db.prepare('SELECT revision FROM learning_state WHERE id=1').get()!.revision as number }
  sourceRevision(): number { return this.db.prepare('SELECT source_revision FROM learning_state WHERE id=1').get()!.source_revision as number }
  private invalidateSources(): void { this.db.exec('UPDATE learning_state SET source_revision=source_revision+1 WHERE id=1') }
  initializeSession(sessionId: string, entryIds: readonly string[], now = new Date().toISOString()): void {
    this.transaction(() => {
      if (this.initializedAt(sessionId)) return
      this.db.prepare('INSERT INTO learning_sessions VALUES (?,?)').run(sessionId, now)
      for (const id of entryIds) this.db.prepare('INSERT OR IGNORE INTO learning_checkpoints VALUES (?,?)').run(sessionId, id)
    })
  }
  initializedAt(sessionId: string): string | undefined {
    return this.db.prepare('SELECT initialized_at FROM learning_sessions WHERE session_id=?').get(sessionId)?.initialized_at as string | undefined
  }
  processed(sessionId: string, entryId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM learning_checkpoints WHERE session_id=? AND entry_id=?').get(sessionId, entryId)
  }
  private checkpoint(window: LearningWindow): void {
    for (const id of window.entryIds) this.db.prepare('INSERT OR IGNORE INTO learning_checkpoints VALUES (?,?)').run(window.origin.sessionId, id)
  }
  register(window: LearningWindow): void {
    const record = windowRecord(window)
    const old = this.db.prepare('SELECT payload FROM learning_jobs WHERE id=?').get(window.id)
    if (old && old.payload !== JSON.stringify(record)) throw new MemoryReviewError('evidence', 'Task source changed')
    this.db.prepare('INSERT OR IGNORE INTO learning_jobs(id,payload) VALUES (?,?)').run(window.id, JSON.stringify(record))
  }
  job(id: string): { record: WindowRecord; retryAt: number } | undefined {
    const row = this.db.prepare('SELECT payload,retry_at FROM learning_jobs WHERE id=?').get(id)
    return row ? { record: decode<WindowRecord>(row), retryAt: row.retry_at as number } : undefined
  }
  fail(id: string, code: MemoryFailureCode, stage: MemoryWorkerStage, now = Date.now()): number {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT attempts FROM learning_jobs WHERE id=?').get(id)
      const attempts = Number(row?.attempts ?? 0) + 1
      const delay = Math.min(30 * 60_000, 60_000 * 2 ** Math.min(attempts - 1, 5))
      this.db.prepare('UPDATE learning_jobs SET attempts=?,retry_at=? WHERE id=?').run(attempts, now + delay, id)
      this.db.prepare('UPDATE learning_state SET last_error=? WHERE id=1').run(JSON.stringify({ code, stage, retryAt: new Date(now + delay).toISOString() }))
      return delay
    })
  }
  recentEpisodes(sessionId: string, branchIds: ReadonlySet<string>, limit = 3): TaskEpisode[] {
    return this.db.prepare('SELECT payload FROM task_episodes WHERE session_id=? ORDER BY rowid DESC').all(sessionId)
      .map(row => decode<TaskEpisode>(row)).filter(item => branchIds.has(item.anchorId)).slice(0, limit)
  }
  commitLearning(window: LearningWindow, result: LearningResult, sourceRevision: number): void {
    this.transaction(() => {
      // Independent extraction commits may coexist; only deletion/forgetting invalidates their inputs.
      if (this.sourceRevision() !== sourceRevision) throw new MemoryReviewError('conflict', 'Task sources changed during learning')
      const job = this.job(window.id)
      if (!job || JSON.stringify(job.record) !== JSON.stringify(windowRecord(window))) throw new MemoryReviewError('conflict', 'Learning job was removed or changed')
      for (const source of window.sources) {
        if (this.db.prepare('SELECT 1 FROM forgotten_sources WHERE source_key=?').get(sourceHash([source.ref.sessionId, source.ref.entryId]))) {
          throw new MemoryReviewError('conflict', 'Forgotten source cannot be learned again')
        }
      }
      for (const episode of result.episodes) {
        if (episode.projectKey !== window.origin.project || episode.sessionId !== window.origin.sessionId) throw new MemoryReviewError('evidence')
        // Continuations must integrate their older proposals first; no pending knowledge is overwritten.
        const previous = this.episode(episode.id)
        if (previous?.integration === 'pending') throw new MemoryReviewError('conflict', 'Task integration is pending')
        this.db.prepare(`INSERT INTO task_episodes VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET anchor_id=excluded.anchor_id,integration=excluded.integration,payload=excluded.payload`)
          .run(episode.id, episode.sessionId, episode.anchorId, episode.integration, JSON.stringify(episode))
        this.db.prepare('DELETE FROM episode_fts WHERE id=?').run(episode.id)
        this.db.prepare('INSERT INTO episode_fts VALUES (?,?)').run(episode.id, memoryTerms(episode.title + ' ' + episode.content).join(' '))
      }
      for (const proposal of result.proposals) {
        if (!result.episodes.some(item => item.id === proposal.episodeId)) throw new MemoryReviewError('evidence')
        // Persist only minimal excerpts; raw tool outputs and full conversations stay in JSONL.
        const saved = { ...proposal, sources: proposal.sources.map(source => ({ ...source,
          text: source.text.length <= 600 ? source.text : source.text.slice(0, 300) + '\n[... evidence excerpt omitted ...]\n' + source.text.slice(-300),
          truncated: source.truncated || source.text.length > 600 })) }
        this.db.prepare('INSERT INTO knowledge_proposals VALUES (?,?,?)').run(saved.id, saved.episodeId, JSON.stringify(saved))
      }
      this.checkpoint(window)
      this.db.prepare('DELETE FROM learning_jobs WHERE id=?').run(window.id)
      this.db.prepare('UPDATE learning_state SET last_success=?,last_error=NULL WHERE id=1').run(new Date().toISOString())
    })
  }
  pending(sessionId: string, branchIds: ReadonlySet<string>): PendingIntegration[] {
    return this.db.prepare("SELECT payload FROM task_episodes WHERE session_id=? AND integration='pending' ORDER BY rowid").all(sessionId)
      .map(row => decode<TaskEpisode>(row)).filter(episode => branchIds.has(episode.anchorId)).map(episode => ({ episode,
        proposals: this.db.prepare('SELECT payload FROM knowledge_proposals WHERE episode_id=? ORDER BY id').all(episode.id).map(row => decode<KnowledgeProposal>(row)) }))
  }
  episode(id: string, access?: MemoryAccess): TaskEpisode | undefined {
    const row = this.db.prepare('SELECT payload FROM task_episodes WHERE id=?').get(id)
    const episode = row ? decode<TaskEpisode>(row) : undefined
    return episode && (!access || episode.projectKey === access.project || episode.sessionId === access.session) ? episode : undefined
  }
  read(id: string, access: MemoryAccess): LongTermFact | undefined {
    const fact = this.fact(id)
    return fact && visible(fact, access) ? fact : undefined
  }
  private fact(id: string): LongTermFact | undefined {
    const row = this.db.prepare('SELECT payload FROM knowledge_items WHERE id=?').get(id)
    return row ? decode<LongTermFact>(row) : undefined
  }
  evidence(id: string): LongTermEvidence[] {
    return this.db.prepare('SELECT payload FROM knowledge_evidence WHERE memory_id=? ORDER BY episode_id').all(id).map(row => decode<LongTermEvidence>(row))
  }
  search(query: string, access: MemoryAccess, limit = 5, kinds?: readonly MemoryKind[]): LongTermFact[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid memory search limit')
    const expression = memoryQuery(query)
    if (!expression) return []
    const filter = kinds?.length ? ` AND f.kind IN (${kinds.map(() => '?').join(',')})` : ''
    return this.db.prepare(`SELECT f.payload FROM knowledge_fts JOIN knowledge_items f ON f.id=knowledge_fts.id
      WHERE knowledge_fts MATCH ? AND f.status IN ('active','disputed')
      AND ((f.scope='global' AND f.scope_key='global') OR (f.scope='project' AND f.scope_key=?) OR (f.scope='session' AND f.scope_key=?)) AND json_extract(f.payload,'$.checkoutKey') IN ('',?)${filter}
      ORDER BY bm25(knowledge_fts),f.id LIMIT ?`).all(expression, access.project, access.session, access.cwd ?? access.project, ...(kinds ?? []), limit).map(row => decode<LongTermFact>(row))
  }
  searchEpisodes(query: string, access: MemoryAccess, limit = 5): TaskEpisode[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid episode search limit')
    const expression = memoryQuery(query)
    if (!expression) return []
    return this.db.prepare(`SELECT e.payload FROM episode_fts JOIN task_episodes e ON e.id=episode_fts.id
      WHERE episode_fts MATCH ? AND (json_extract(e.payload,'$.projectKey')=? OR e.session_id=?)
      ORDER BY bm25(episode_fts),e.id LIMIT ?`).all(expression, access.project, access.session, limit).map(row => decode<TaskEpisode>(row))
  }
  projectDirectory(limit = 20, offset = 0): LongTermFact[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid project directory page')
    return this.db.prepare("SELECT payload FROM knowledge_items WHERE kind='project' AND scope='global' AND status='active' ORDER BY rowid DESC LIMIT ? OFFSET ?")
      .all(limit, offset).map(row => decode<LongTermFact>(row))
  }
  related(proposal: KnowledgeProposal, access: MemoryAccess): LongTermFact[] {
    // Include the type's most recent current-scope knowledge even when new wording has no FTS overlap.
    const recent = this.db.prepare("SELECT payload FROM knowledge_items WHERE kind=? AND status IN ('active','disputed') ORDER BY rowid DESC").all(proposal.kind)
      .map(row => decode<LongTermFact>(row)).filter(fact => visible(fact, access) && (proposal.kind === 'preference' || fact.projectKey === access.project)).slice(0, 12)
    return [...new Map([...this.search(proposal.content, access, 8, [proposal.kind]), ...recent]
      .filter(fact => proposal.kind === 'preference' || fact.projectKey === access.project).map(fact => [fact.id, fact])).values()]
  }
  private put(fact: LongTermFact): void {
    this.db.prepare(`INSERT INTO knowledge_items VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,scope=excluded.scope,scope_key=excluded.scope_key,status=excluded.status,payload=excluded.payload`)
      .run(fact.id, fact.kind, fact.scope, fact.scopeKey, fact.status, JSON.stringify(fact))
    this.db.prepare('DELETE FROM knowledge_fts WHERE id=?').run(fact.id)
    this.db.prepare('INSERT INTO knowledge_fts VALUES (?,?)').run(fact.id, memoryTerms(fact.content + ' ' + fact.applicability).join(' '))
  }
  integrate(input: PendingIntegration, changes: readonly KnowledgeChange[], revision: number): void {
    this.transaction(() => {
      this.check(revision)
      const current = this.episode(input.episode.id)
      if (!current || current.integration !== 'pending' || JSON.stringify(current) !== JSON.stringify(input.episode)) throw new MemoryReviewError('conflict')
      const proposals = this.db.prepare('SELECT payload FROM knowledge_proposals WHERE episode_id=? ORDER BY id').all(current.id).map(row => decode<KnowledgeProposal>(row))
      if (JSON.stringify(proposals) !== JSON.stringify(input.proposals) || changes.length !== proposals.length || new Set(changes.map(item => item.proposalId)).size !== proposals.length) throw new MemoryReviewError('conflict')
      for (const change of changes) {
        const proposal = proposals.find(item => item.id === change.proposalId)
        if (!proposal) throw new MemoryReviewError('evidence')
        if (change.action === 'skip') continue
        if (!change.fact) throw new MemoryReviewError('evidence')
        let target = change.targetId ? this.fact(change.targetId) : undefined
        if (change.action !== 'add' && (!target || (target.status !== 'active' && !(change.action === 'supersede' && target.status === 'disputed')) || target.kind !== change.fact.kind || target.scope !== change.fact.scope || target.scopeKey !== change.fact.scopeKey || target.projectKey !== change.fact.projectKey || target.checkoutKey !== change.fact.checkoutKey)) throw new MemoryReviewError('conflict')
        const now = new Date().toISOString()
        if (change.action === 'add') {
          const duplicate = this.db.prepare("SELECT payload FROM knowledge_items WHERE kind=? AND scope=? AND scope_key=? AND status='active' AND json_extract(payload,'$.content')=? AND json_extract(payload,'$.applicability')=? AND json_extract(payload,'$.projectKey')=? AND json_extract(payload,'$.checkoutKey')=?")
            .get(change.fact.kind, change.fact.scope, change.fact.scopeKey, change.fact.content, change.fact.applicability, change.fact.projectKey, change.fact.checkoutKey)
          if (duplicate) target = decode<LongTermFact>(duplicate)
        }
        let fact: LongTermFact
        if ((change.action === 'merge' || change.action === 'add') && target) fact = { ...target, updatedAt: now,
          sourceTime: target.assertion === change.fact.assertion && change.fact.sourceTime > target.sourceTime ? change.fact.sourceTime : target.sourceTime }
        else if (change.action === 'revise' && target) fact = { ...target, ...change.fact, updatedAt: now }
        else {
          fact = { ...change.fact, id: proposal.id, createdAt: now, updatedAt: now,
            status: change.action === 'dispute' ? 'disputed' : 'active', ...(change.action === 'supersede' ? { supersedes: target!.id } : {}) }
          if (target && (change.action === 'supersede' || change.action === 'dispute')) {
            const targets = new Set([target.id])
            if (change.action === 'supersede' && target.status === 'disputed') {
              let expanded = true
              while (expanded) {
                expanded = false
                for (const row of this.db.prepare("SELECT source_id,target_id FROM knowledge_relations WHERE relation='dispute'").all()) {
                  if (targets.has(row.source_id as string) || targets.has(row.target_id as string)) for (const id of [row.source_id, row.target_id] as string[]) {
                    if (!targets.has(id)) { targets.add(id); expanded = true }
                  }
                }
              }
            }
            for (const id of targets) {
              const prior = this.fact(id)!
              if (prior.kind !== fact.kind || prior.scopeKey !== fact.scopeKey || prior.projectKey !== fact.projectKey || prior.checkoutKey !== fact.checkoutKey
                || (change.action === 'supersede' && prior.sourceTime >= fact.sourceTime)) throw new MemoryReviewError('evidence', 'Conflict resolution crosses boundaries or lacks newer evidence')
              this.put({ ...prior, status: change.action === 'supersede' ? 'superseded' : 'disputed', updatedAt: now })
              this.db.prepare('INSERT INTO knowledge_relations VALUES (?,?,?)').run(fact.id, prior.id, change.action)
            }
          }
        }
        this.put(fact)
        const oldEvidence = this.evidence(fact.id).find(item => item.episodeId === current.id)
        const refs = [...new Map([...(oldEvidence?.sources ?? []), ...proposal.sources.map(source => source.ref)].map(ref => [sourceHash(ref), ref])).values()]
        this.db.prepare('INSERT OR REPLACE INTO knowledge_evidence VALUES (?,?,?)').run(fact.id, current.id, JSON.stringify({ episodeId: current.id, sources: refs }))
      }
      this.db.prepare('DELETE FROM learning_jobs WHERE id=?').run(current.id)
      this.db.prepare('DELETE FROM knowledge_proposals WHERE episode_id=?').run(current.id)
      this.db.prepare("UPDATE task_episodes SET integration='done',payload=? WHERE id=?").run(JSON.stringify({ ...current, integration: 'done' }), current.id)
      this.db.prepare('UPDATE learning_state SET last_success=?,last_error=NULL WHERE id=1').run(new Date().toISOString())
      this.bump()
    })
  }
  page(kind: MemoryViewKind, offset = 0): LongTermPage {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid memory page offset')
    const rows = kind === 'episodes' ? this.db.prepare('SELECT payload FROM task_episodes ORDER BY rowid DESC LIMIT 51 OFFSET ?').all(offset)
      : this.db.prepare('SELECT payload FROM knowledge_items WHERE kind=? ORDER BY rowid DESC LIMIT 51 OFFSET ?').all(kind, offset)
    return { episodes: kind === 'episodes' ? rows.slice(0, 50).map(row => decode<TaskEpisode>(row)) : [],
      memories: kind === 'episodes' ? [] : rows.slice(0, 50).map(row => decode<LongTermFact>(row)), nextOffset: rows.length > 50 ? offset + 50 : null }
  }
  preferenceCandidates(access: MemoryAccess): LongTermFact[] {
    const rows = this.db.prepare("SELECT payload FROM knowledge_items WHERE status='active' AND kind='preference' AND scope='global' ORDER BY rowid DESC").all()
    let bytes = 0
    return rows.map(row => decode<LongTermFact>(row)).filter(fact => {
      if (!visible(fact, access) || fact.assertion !== 'user-statement') return false
      const size = Buffer.byteLength(JSON.stringify(fact))
      if (bytes + size > 2800) return false
      bytes += size; return true
    }).slice(0, 5)
  }
  deleteEpisode(id: string): void {
    this.transaction(() => { const item = this.episode(id); if (!item) return
      for (const ref of item.sources) this.db.prepare('INSERT OR IGNORE INTO forgotten_sources VALUES (?)').run(sourceHash([ref.sessionId, ref.entryId]))
      this.db.prepare('DELETE FROM learning_jobs WHERE id=?').run(id)
      this.db.prepare('DELETE FROM episode_fts WHERE id=?').run(id)
      this.db.prepare('DELETE FROM task_episodes WHERE id=?').run(id); this.invalidateSources(); this.bump()
    })
  }
  forgetFact(id: string): void {
    this.transaction(() => {
      this.invalidateSources()
      const related = new Set([id])
      let changed = true
      while (changed) { changed = false
        for (const row of this.db.prepare('SELECT source_id,target_id FROM knowledge_relations').all()) {
          if (related.has(row.source_id as string) || related.has(row.target_id as string)) for (const key of [row.source_id, row.target_id] as string[]) {
            if (!related.has(key)) { related.add(key); changed = true }
          }
        }
      }
      for (const key of related) {
        for (const evidence of this.evidence(key)) {
          const episode = this.episode(evidence.episodeId)
          for (const ref of [...evidence.sources, ...(episode?.sources ?? [])]) this.db.prepare('INSERT OR IGNORE INTO forgotten_sources VALUES (?)').run(sourceHash([ref.sessionId, ref.entryId]))
          this.db.prepare('DELETE FROM learning_jobs WHERE id=?').run(evidence.episodeId)
          this.db.prepare('DELETE FROM episode_fts WHERE id=?').run(evidence.episodeId)
          this.db.prepare('DELETE FROM task_episodes WHERE id=?').run(evidence.episodeId)
        }
        this.db.prepare('DELETE FROM knowledge_fts WHERE id=?').run(key)
        this.db.prepare('DELETE FROM knowledge_items WHERE id=?').run(key)
        this.db.prepare('DELETE FROM knowledge_relations WHERE source_id=? OR target_id=?').run(key, key)
      }
      this.bump()
    })
  }
  isForgotten(sessionId: string, entryId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM forgotten_sources WHERE source_key=?').get(sourceHash([sessionId, entryId]))
  }
  recordUsage(stage: MemoryWorkerStage, usage: { input: number; output: number; cost: number }): void {
    this.db.prepare(`INSERT INTO learning_usage VALUES (?,1,?,?,?) ON CONFLICT(stage) DO UPDATE SET requests=requests+1,input=input+excluded.input,output=output+excluded.output,cost=cost+excluded.cost`)
      .run(stage, usage.input, usage.output, usage.cost)
  }
  status(): MemoryLearningStatus {
    const state = this.db.prepare('SELECT last_success,last_error FROM learning_state WHERE id=1').get()!
    return { runningJobs: 0, pendingJobs: Number(this.db.prepare('SELECT count(*) AS n FROM learning_jobs j LEFT JOIN task_episodes e ON e.id=j.id WHERE e.id IS NULL').get()!.n),
      pendingIntegrations: Number(this.db.prepare("SELECT count(*) AS n FROM task_episodes WHERE integration='pending'").get()!.n),
      lastSuccess: state.last_success as string | null, lastError: state.last_error ? JSON.parse(state.last_error as string) : null,
      usage: this.db.prepare('SELECT * FROM learning_usage ORDER BY stage').all() as unknown as MemoryLearningStatus['usage'] }
  }
  close(): void { this.db.close() }
}
