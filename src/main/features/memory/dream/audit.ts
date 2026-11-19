/** Host-side Dream memory health triage. Combines bounded 90-day telemetry, live memory structure,
 * 60-day keep cooldowns, and verified branch-anchored history whitelist grants. */
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import type { DreamAuditProject, DreamAuditScope } from '../../../../shared/dream'
import type { MemoryScope } from '../../../../shared/long-term-memory'
import { MemoryFiles, memoryRoot, resolveMemoryLink, revisionOf } from '../long-term/files'
import { memoryTelemetryPath } from '../paths'
import { sanitizeTelemetryPath } from '../telemetry/sanitize'
import {
  AUDIT_COOLDOWN_MS, auditKeepKey, readAuditState, readTelemetryWindow
} from '../telemetry/store'
import type {
  AuditCandidateKind, AuditKeepKind, AuditKeptEntry, AuditStructureSubkind, MemoryTelemetryCoverage,
  MemoryTelemetryOp, MemoryTelemetryRow
} from '../telemetry/types'
import type { DreamHistory } from './history'

const STALE_OBSERVATION_MS = 14 * 86_400_000
const STALE_INDEX_MIN_TURNS = 10
const MAX_CANDIDATES_PER_CATEGORY = 5
const MAX_REPRESENTATIVE_ROUNDS = 3
const MARKDOWN_LINK_RE = /\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g

export interface AuditCandidateRound {
  sessionId: string
  turnId: string
  anchorEntryId?: string
  at: number
  outcome: string
  projectId?: string
  weak?: boolean
  historyAvailable: boolean
  historyUnavailableReason?: string
  evidenceIncomplete?: boolean
}

export interface AuditCandidate {
  id: string
  priority: 1 | 2 | 3 | 4
  kind: AuditCandidateKind
  subkind?: 'broken_link' | 'orphan' | 'zero_hit_query' | 'empty_lookup'
  defectKey?: string
  scope: MemoryScope
  projectId?: string
  path?: string
  rev?: string
  from?: string
  fromRev?: string
  query?: string
  brokenLinks?: string[]
  numerator: number
  denominator: number
  reason: string
  weak?: boolean
  signalThrough: number
  rounds: AuditCandidateRound[]
}

export interface AuditHealthReport {
  scope: DreamAuditScope
  generatedAt: number
  verifiedProjects: DreamAuditProject[]
  coverage: MemoryTelemetryCoverage
  candidates: AuditCandidate[]
  suppressedCount: number
}

interface LiveNote {
  scope: MemoryScope
  projectId?: string
  scopeKey: string
  path: string
  rev: string
  mtimeMs: number
  content: string
}

interface ScopeGraph {
  scope: MemoryScope
  projectId?: string
  scopeKey: string
  notes: Map<string, LiveNote>
  reachable: Set<string>
  brokenLinks: Map<string, { targets: string[]; totalLinks: number }>
  orphans: LiveNote[]
}

interface PreprocessedOp {
  index: number
  op: MemoryTelemetryOp
  scope: MemoryScope
  projectId?: string
  scopeKey: string
  forMutationOnly: boolean
}

interface TurnBucket {
  turnKey: string
  row: MemoryTelemetryRow
  ops: PreprocessedOp[]
}

function listScopeNotes(liveRoot: string, scope: MemoryScope, projectId?: string): Map<string, LiveNote> {
  const scopeKey = scope === 'global' ? 'global' : `projects/${projectId}`
  const store = new MemoryFiles(join(liveRoot, scopeKey), liveRoot)
  const map = new Map<string, LiveNote>()
  for (const item of store.list()) {
    const file = store.read(item.path)
    const stat = lstatSync(store.resolve(item.path))
    map.set(item.path, {
      scope,
      ...(projectId ? { projectId } : {}),
      scopeKey,
      path: item.path,
      rev: file.revision,
      mtimeMs: stat.mtimeMs,
      content: file.content
    })
  }
  return map
}

export function structureDefectKey(
  subkind: AuditStructureSubkind,
  detail: { brokenLinks?: string[]; hasIndex?: boolean } = {}
): string {
  if (subkind === 'broken_link') {
    const sorted = [...new Set(detail.brokenLinks ?? [])].sort()
    return revisionOf(JSON.stringify(['broken_link', ...sorted]))
  }
  return revisionOf(JSON.stringify(['orphan', detail.hasIndex ? 'with_index' : 'no_index']))
}

function collectOutgoingLinks(
  note: LiveNote,
  notes: Map<string, LiveNote>
): { validTargets: string[]; broken: string[]; totalLinks: number } {
  const validTargets: string[] = []
  const broken: string[] = []
  let totalLinks = 0
  for (const match of note.content.matchAll(MARKDOWN_LINK_RE)) {
    const raw = match[1]!
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(raw)) continue
    const linkPath = raw.split('#')[0]!
    if (!linkPath) continue
    totalLinks += 1
    let target: string
    try {
      target = resolveMemoryLink(linkPath, note.path)
    } catch {
      broken.push(linkPath)
      continue
    }
    if (!notes.has(target)) broken.push(linkPath)
    else validTargets.push(target)
  }
  return { validTargets, broken: [...new Set(broken)], totalLinks }
}

function analyzeScopeGraph(liveRoot: string, scope: MemoryScope, projectId?: string): ScopeGraph {
  const scopeKey = scope === 'global' ? 'global' : `projects/${projectId}`
  const notes = listScopeNotes(liveRoot, scope, projectId)
  const adjacency = new Map<string, string[]>()
  const brokenLinks = new Map<string, { targets: string[]; totalLinks: number }>()

  // Pass 1: inspect outgoing links across every note in the scope independently of MEMORY.md reachability.
  for (const note of notes.values()) {
    const { validTargets, broken, totalLinks } = collectOutgoingLinks(note, notes)
    adjacency.set(note.path, validTargets)
    if (broken.length > 0) brokenLinks.set(note.path, { targets: broken, totalLinks })
  }

  // Pass 2: compute reachability strictly from MEMORY.md so orphan-to-orphan links never confer reachability.
  const reachable = new Set<string>()
  if (notes.has('MEMORY.md')) {
    reachable.add('MEMORY.md')
    const queue = ['MEMORY.md']
    while (queue.length > 0) {
      const path = queue.shift()!
      for (const target of adjacency.get(path) ?? []) {
        if (!reachable.has(target)) {
          reachable.add(target)
          queue.push(target)
        }
      }
    }
  }

  const orphans: LiveNote[] = []
  for (const note of notes.values()) {
    if (note.path !== 'MEMORY.md' && !reachable.has(note.path)) {
      orphans.push(note)
    }
  }

  return { scope, ...(projectId ? { projectId } : {}), scopeKey, notes, reachable, brokenLinks, orphans }
}

export function matchesClickbaitSource(store: MemoryFiles, from?: string, fromRev?: string): boolean {
  return Boolean(from && fromRev && store.optional(from)?.revision === fromRev)
}

export function matchesStructuralKeep(root: string, entry: Pick<AuditKeptEntry, 'scope' | 'projectId' | 'path' | 'subkind' | 'defectKey'>): boolean {
  const { scope, projectId, path, subkind, defectKey } = entry
  if (!subkind || !defectKey) return false
  const graph = analyzeScopeGraph(root, scope, projectId)
  if (subkind === 'orphan') {
    return graph.orphans.some(note => note.path === path)
      && defectKey === structureDefectKey(subkind, { hasIndex: graph.notes.has('MEMORY.md') })
  }
  const broken = graph.brokenLinks.get(path)
  return Boolean(broken && defectKey === structureDefectKey(subkind, { brokenLinks: broken.targets }))
}

function resolveOpScope(
  op: MemoryTelemetryOp,
  rowProjectId?: string
): { scope: MemoryScope; projectId?: string; scopeKey: string } | null {
  if (op.scope === 'global') {
    return { scope: 'global', scopeKey: 'global' }
  }
  const projectId = op.projectId ?? rowProjectId
  if (!projectId) return null
  return { scope: 'project', projectId, scopeKey: `projects/${projectId}` }
}

function preprocessTurns(
  rows: MemoryTelemetryRow[],
  scopeAllowed: (scopeKey: string) => boolean,
  verifiedProjectIds: Set<string>
): TurnBucket[] {
  const buckets = new Map<string, TurnBucket>()
  for (const row of rows) {
    const turnKey = `${row.sessionId}\0${row.turnId}\0${row.anchorEntryId ?? ''}`
    const existing = buckets.get(turnKey)
    if (existing && existing.row.at >= row.at) continue
    const ops: PreprocessedOp[] = []
    const conflictPaths = new Set<string>()
    for (let i = 0; i < row.ops.length; i++) {
      const op = row.ops[i]!
      const resolved = resolveOpScope(op, row.projectId)
      if (!resolved) continue
      if (resolved.scope === 'project' && (!resolved.projectId || !verifiedProjectIds.has(resolved.projectId))) continue
      if (!scopeAllowed(resolved.scopeKey)) continue

      let forMutationOnly = false
      const noteKey = op.path ? `${resolved.scopeKey}/${op.path}` : ''
      if (op.op === 'read' && op.ok && op.path && op.rev) {
        if (conflictPaths.has(noteKey)) {
          forMutationOnly = true
        } else {
          const next = row.ops[i + 1]
          const nextResolved = next ? resolveOpScope(next, row.projectId) : null
          if (
            next &&
            nextResolved &&
            (next.op === 'edit' || next.op === 'delete') &&
            nextResolved.scopeKey === resolved.scopeKey &&
            next.path === op.path &&
            next.gap.calls === 0 &&
            (next.beforeRev === undefined || next.beforeRev === op.rev)
          ) {
            forMutationOnly = true
          }
        }
      } else if ((op.op === 'edit' || op.op === 'delete') && !op.ok && op.err === 'MEMORY_REVISION_CONFLICT' && op.path) {
        conflictPaths.add(noteKey)
      }
      ops.push({
        index: i,
        op,
        scope: resolved.scope,
        ...(resolved.projectId ? { projectId: resolved.projectId } : {}),
        scopeKey: resolved.scopeKey,
        forMutationOnly
      })
    }
    if (ops.length > 0) buckets.set(turnKey, { turnKey, row, ops })
  }
  return [...buckets.values()].sort((a, b) => b.row.at - a.row.at)
}

interface RawRoundCandidate {
  row: MemoryTelemetryRow
  opProjectId?: string
  hasAnchor: boolean
}

interface NoteStats {
  opTurns: number
  currentReadTurns: number
  suspectReads: RawRoundCandidate[]
  mutations: RawRoundCandidate[]
  versions: Set<string>
  latestReadAt: number
}

function aggregateNoteStats(turns: TurnBucket[], graphs: Map<string, ScopeGraph>, now: number) {
  const notes = new Map<LiveNote, NoteStats>()
  const indexReads = new Map<string, number[]>()
  for (const bucket of turns) {
    const { row } = bucket
    let totalErrs = row.tail.errs
    const preErrs: number[] = []
    let errors = 0
    for (const op of row.ops) {
      errors += op.gap.errs
      preErrs.push(errors)
    }
    totalErrs += errors

    const visited = new Set<NoteStats>()
    const readCurrent = new Set<NoteStats>()
    const mutated = new Map<NoteStats, RawRoundCandidate>()
    const readIndexes = new Set<string>()
    const complete = !row.opsTruncated && row.at <= now
    for (const item of bucket.ops) {
      const { op } = item
      const note = op.path && graphs.get(item.scopeKey)?.notes.get(op.path)
      if (!note) continue
      let stats = notes.get(note)
      if (!stats) {
        stats = { opTurns: 0, currentReadTurns: 0, suspectReads: [], mutations: [], versions: new Set(), latestReadAt: -Infinity }
        notes.set(note, stats)
      }
      if (!visited.has(stats)) {
        visited.add(stats)
        stats.opTurns++
      }
      if (!op.ok) continue
      const round = { row, opProjectId: item.projectId, hasAnchor: Boolean(row.anchorEntryId) }
      if ((op.op === 'add' && op.afterRev) || (op.op === 'edit' && op.afterRev && op.beforeRev !== op.afterRev) || op.op === 'delete') {
        mutated.set(stats, round)
        if (op.afterRev) stats.versions.add(op.afterRev)
        if (op.beforeRev) stats.versions.add(op.beforeRev)
      }
      if (op.op !== 'read' || item.forMutationOnly) continue
      if (complete) {
        stats.latestReadAt = Math.max(stats.latestReadAt, row.at)
        if (note.path === 'MEMORY.md' && op.offset === 0) readIndexes.add(item.scopeKey)
      }
      if (op.rev !== note.rev || readCurrent.has(stats)) continue
      readCurrent.add(stats)
      stats.currentReadTurns++
      const before = preErrs[item.index]!
      if (row.outcome === 'error' || row.outcome === 'aborted' || row.outcome === 'steered' || (before === 0 && totalErrs > 0)) {
        stats.suspectReads.push(round)
      }
    }
    for (const [stats, round] of mutated) stats.mutations.push(round)
    for (const scopeKey of readIndexes) {
      const reads = indexReads.get(scopeKey) ?? []
      reads.push(row.at)
      indexReads.set(scopeKey, reads)
    }
  }
  return { notes, indexReads }
}

// Turns are visited newest first; the first timestamp below the observation cutoff ends the count.
function countReadsSince(reads: number[], cutoff: number): number {
  let lo = 0, hi = reads.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (reads[mid]! >= cutoff) lo = mid + 1
    else hi = mid
  }
  return lo
}

function selectRepresentativeRounds(rounds: RawRoundCandidate[]): RawRoundCandidate[] {
  const seen = new Set<string>()
  const deduped: RawRoundCandidate[] = []
  const sorted = [...rounds].sort((a, b) => {
    if (a.hasAnchor !== b.hasAnchor) return a.hasAnchor ? -1 : 1
    return b.row.at - a.row.at
  })
  for (const item of sorted) {
    const key = `${item.row.sessionId}\0${item.row.turnId}\0${item.row.anchorEntryId ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(item)
    if (deduped.length >= MAX_REPRESENTATIVE_ROUNDS) break
  }
  return deduped
}

function isKeepSuppressed(
  keptMap: Map<string, AuditKeptEntry>,
  candidate: Omit<AuditCandidate, 'id' | 'rounds'>,
  now: number
): boolean {
  if (candidate.kind === 'repeated_miss' || !candidate.path || !candidate.rev) return false
  const structureSubkind: AuditStructureSubkind | undefined = candidate.kind === 'structure'
    ? (candidate.subkind === 'broken_link' || candidate.subkind === 'orphan' ? candidate.subkind : undefined)
    : undefined
  if (candidate.kind === 'structure' && (!structureSubkind || !candidate.defectKey)) return false
  const kept = keptMap.get(auditKeepKey({
    scope: candidate.scope,
    projectId: candidate.projectId,
    path: candidate.path,
    kind: candidate.kind as AuditKeepKind,
    ...(structureSubkind ? { subkind: structureSubkind } : {}),
    ...(candidate.kind === 'clickbait' ? { from: candidate.from, fromRev: candidate.fromRev } : {})
  }))
  if (!kept) return false
  if (candidate.kind === 'clickbait' && (
    !candidate.from || !candidate.fromRev || kept.from !== candidate.from || kept.fromRev !== candidate.fromRev
  )) return false
  if (kept.rev !== candidate.rev) return false
  if (now - kept.checkedAt >= AUDIT_COOLDOWN_MS) return false
  if (candidate.kind === 'structure') {
    // Legacy broad structure keeps lack subkind/defectKey and never suppress precise structural defects.
    return kept.subkind === structureSubkind && typeof kept.defectKey === 'string' && kept.defectKey === candidate.defectKey
  }
  if (candidate.kind === 'stale') return true
  return candidate.signalThrough <= kept.signalThrough
}

export async function buildAuditHealthReport(options: {
  scope: DreamAuditScope
  history: DreamHistory
  verifiedProjects: Map<string, DreamAuditProject>
  liveRoot?: string
  telemetryRoot?: string
  now?: number
  shardBudgetBytes?: number
  verifyHistory?: boolean
  topicFilter?: { topic: string; paths?: string[] }
}): Promise<AuditHealthReport> {
  const now = options.now ?? Date.now()
  const liveRoot = options.liveRoot ?? memoryRoot()
  const telemetryRoot = options.telemetryRoot ?? memoryTelemetryPath()
  const verifiedIds = new Set(options.verifiedProjects.keys())

  if (options.scope.kind === 'project' && !verifiedIds.has(options.scope.projectId)) {
    throw new Error('DREAM_SCOPE: Selected project could not be verified by the host')
  }

  const scopeAllowed = (scopeKey: string): boolean => {
    if (options.scope.kind === 'global') return scopeKey === 'global'
    if (options.scope.kind === 'project') return scopeKey === `projects/${options.scope.projectId}`
    if (scopeKey === 'global') return true
    const match = /^projects\/([a-f0-9]{64})$/.exec(scopeKey)
    return Boolean(match && verifiedIds.has(match[1]!))
  }

  const targetScopes: { scope: MemoryScope; projectId?: string; scopeKey: string }[] = []
  if (options.scope.kind !== 'project') targetScopes.push({ scope: 'global', scopeKey: 'global' })
  if (options.scope.kind === 'project') {
    targetScopes.push({ scope: 'project', projectId: options.scope.projectId, scopeKey: `projects/${options.scope.projectId}` })
  } else if (options.scope.kind === 'all') {
    for (const id of verifiedIds) targetScopes.push({ scope: 'project', projectId: id, scopeKey: `projects/${id}` })
  }

  const graphs = new Map<string, ScopeGraph>()
  for (const target of targetScopes) {
    graphs.set(target.scopeKey, analyzeScopeGraph(liveRoot, target.scope, target.projectId))
  }

  const telemetry = readTelemetryWindow({ now, root: telemetryRoot, shardBudgetBytes: options.shardBudgetBytes })
  const auditState = readAuditState(telemetryRoot)
  const keptMap = new Map<string, AuditKeptEntry>()
  for (const item of auditState.kept) {
    if (now - item.checkedAt < AUDIT_COOLDOWN_MS) keptMap.set(auditKeepKey(item), item)
  }

  const turns = preprocessTurns(telemetry.rows, scopeAllowed, verifiedIds)
  const { notes: noteStats, indexReads } = aggregateNoteStats(turns, graphs, now)
  let suppressedCount = 0

  type DraftCandidate = Omit<AuditCandidate, 'id' | 'rounds'> & { rawRounds: RawRoundCandidate[]; score: number }
  const topicMatches = options.topicFilter && matchTopic(options.topicFilter.topic, options.topicFilter.paths)
  const addCandidate = (group: DraftCandidate[], draft: DraftCandidate) => {
    if (topicMatches && !topicMatches(draft)) return
    if (isKeepSuppressed(keptMap, draft, now)) suppressedCount++
    else group.push(draft)
  }

  // 1. Poisoned (current rev) & high_churn (cross-version substantive edits)
  const priority1: DraftCandidate[] = []
  for (const graph of graphs.values()) {
    for (const note of graph.notes.values()) {
      const stats = noteStats.get(note)
      if (!stats) continue
      const { suspectReads, mutations, versions } = stats

      if (suspectReads.length >= 2) {
        const roundsList = suspectReads
        const signalThrough = roundsList[0]!.row.at
        const draft: DraftCandidate = {
          priority: 1, kind: 'poisoned', scope: graph.scope, ...(graph.projectId ? { projectId: graph.projectId } : {}),
          path: note.path, rev: note.rev, numerator: suspectReads.length, denominator: stats.currentReadTurns,
          reason: `Post-read anomalies or user interventions observed across ${suspectReads.length} independent turns on the current revision`,
          signalThrough, rawRounds: roundsList, score: 1000 + suspectReads.length * 10,
          weak: roundsList.every(item => !item.hasAnchor)
        }
        addCandidate(priority1, draft)
        continue
      }

      if (mutations.length >= 3 && versions.size >= 2) {
        const roundsList = mutations
        const signalThrough = roundsList[0]!.row.at
        const draft: DraftCandidate = {
          priority: 1, kind: 'high_churn', scope: graph.scope, ...(graph.projectId ? { projectId: graph.projectId } : {}),
          path: note.path, rev: note.rev, numerator: mutations.length, denominator: stats.opTurns,
          reason: `Frequent substantive edits across ${versions.size} revisions in ${mutations.length} independent turns (high churn, not necessarily wrong in current revision)`,
          signalThrough, rawRounds: roundsList, score: mutations.length * 10 + versions.size,
          weak: roundsList.every(item => !item.hasAnchor)
        }
        addCandidate(priority1, draft)
      }
    }
  }
  priority1.sort((a, b) => b.score - a.score)

  // 2. Structure (broken links & orphans) & clickbait (from -> path backtracks)
  const priority2: DraftCandidate[] = []
  for (const graph of graphs.values()) {
    for (const [sourcePath, info] of graph.brokenLinks) {
      const note = graph.notes.get(sourcePath)!
      const draft: DraftCandidate = {
        priority: 2, kind: 'structure', subkind: 'broken_link',
        defectKey: structureDefectKey('broken_link', { brokenLinks: info.targets }),
        scope: graph.scope,
        ...(graph.projectId ? { projectId: graph.projectId } : {}),
        path: sourcePath, rev: note.rev, brokenLinks: info.targets,
        numerator: info.targets.length, denominator: info.totalLinks,
        reason: `Broken relative Markdown links: ${info.targets.slice(0, 3).join(', ')}`,
        signalThrough: 0, rawRounds: [], score: 1000 + info.targets.length
      }
      addCandidate(priority2, draft)
    }

    const totalTopicNotes = Math.max(1, [...graph.notes.keys()].filter(path => path !== 'MEMORY.md').length)
    const hasIndex = graph.notes.has('MEMORY.md')
    for (const orphan of graph.orphans) {
      const draft: DraftCandidate = {
        priority: 2, kind: 'structure', subkind: 'orphan',
        defectKey: structureDefectKey('orphan', { hasIndex }),
        scope: graph.scope,
        ...(graph.projectId ? { projectId: graph.projectId } : {}),
        path: orphan.path, rev: orphan.rev,
        numerator: 1, denominator: totalTopicNotes,
        reason: hasIndex
          ? 'Unreachable from MEMORY.md link graph'
          : 'No MEMORY.md index exists in this scope to link this note',
        signalThrough: 0, rawRounds: [], score: 500
      }
      addCandidate(priority2, draft)
    }
  }

  const clickbaitStats = new Map<string, {
    scope: MemoryScope; projectId?: string; scopeKey: string; from: string; path: string;
    openTurns: Map<string, RawRoundCandidate>; backtrackTurns: Map<string, RawRoundCandidate>
  }>()

  for (const bucket of turns) {
    const openedInTurn = new Set<string>()
    for (let i = 0; i < bucket.ops.length; i++) {
      const cur = bucket.ops[i]!
      const op = cur.op
      if (op.op !== 'read' || !op.ok || !op.path || !op.from || op.offset !== 0 || cur.forMutationOnly) continue
      const graph = graphs.get(cur.scopeKey)
      if (!graph?.notes.has(op.path)) continue
      const noteKey = `${cur.scopeKey}/${op.path}`
      if (openedInTurn.has(noteKey)) continue
      openedInTurn.add(noteKey)

      const statKey = `${cur.scopeKey}\0${op.from}\0${op.path}`
      let stat = clickbaitStats.get(statKey)
      if (!stat) {
        stat = {
          scope: cur.scope, ...(cur.projectId ? { projectId: cur.projectId } : {}),
          scopeKey: cur.scopeKey, from: op.from, path: op.path,
          openTurns: new Map(), backtrackTurns: new Map()
        }
        clickbaitStats.set(statKey, stat)
      }
      const roundEntry: RawRoundCandidate = { row: bucket.row, opProjectId: cur.projectId, hasAnchor: Boolean(bucket.row.anchorEntryId) }
      stat.openTurns.set(bucket.turnKey, roundEntry)

      let nextIndex = i + 1
      while (nextIndex < bucket.ops.length) {
        const candidateNext = bucket.ops[nextIndex]!
        if (candidateNext.scopeKey !== cur.scopeKey || candidateNext.op.gap.calls !== 0) break
        if (candidateNext.op.op === 'read' && candidateNext.op.ok && candidateNext.op.path === op.path) {
          nextIndex += 1
          continue
        }
        break
      }
      const next = bucket.ops[nextIndex]
      if (!next || next.scopeKey !== cur.scopeKey || next.op.gap.calls !== 0 || !next.op.ok) continue
      const isReSearch = next.op.op === 'search'
      const isSwitchEntry = next.op.op === 'read' && next.op.path !== undefined && next.op.path !== op.path && next.op.from !== op.path
      const isReList = next.op.op === 'list'
      if (isReSearch || isSwitchEntry || isReList) {
        stat.backtrackTurns.set(bucket.turnKey, roundEntry)
      }
    }
  }

  for (const stat of clickbaitStats.values()) {
    if (stat.openTurns.size < 3 || stat.backtrackTurns.size * 2 <= stat.openTurns.size) continue
    const graph = graphs.get(stat.scopeKey)!
    const note = graph.notes.get(stat.path)!
    const fromNote = graph.notes.get(stat.from)
    const roundsList = [...stat.backtrackTurns.values()]
    const signalThrough = Math.max(...roundsList.map(item => item.row.at))
    const draft: DraftCandidate = {
      priority: 2, kind: 'clickbait', scope: stat.scope, ...(stat.projectId ? { projectId: stat.projectId } : {}),
      path: stat.path, rev: note.rev, from: stat.from, ...(fromNote ? { fromRev: fromNote.rev } : {}),
      numerator: stat.backtrackTurns.size, denominator: stat.openTurns.size,
      reason: `Opened from ${stat.from} and immediately backtracked to search/another entry in ${stat.backtrackTurns.size}/${stat.openTurns.size} independent turns`,
      signalThrough, rawRounds: roundsList, score: 200 + stat.backtrackTurns.size * 10,
      weak: roundsList.every(item => !item.hasAnchor)
    }
    addCandidate(priority2, draft)
  }
  priority2.sort((a, b) => b.score - a.score)

  // 3. Repeated misses (cross-turn zero-hit queries; empty-lookup turns listed separately as weak leads)
  const priority3: DraftCandidate[] = []
  const queryMisses = new Map<string, {
    scope: MemoryScope; projectId?: string; scopeKey: string; displayQuery: string;
    missTurns: Map<string, RawRoundCandidate>; totalQueryTurns: Set<string>
  }>()
  const scopeTurnCounts = new Map<string, number>()
  const emptyLookupsByScope = new Map<string, { scope: MemoryScope; projectId?: string; turns: Map<string, RawRoundCandidate> }>()

  for (const bucket of turns) {
    const byScope = new Map<string, PreprocessedOp[]>()
    for (const item of bucket.ops) {
      const list = byScope.get(item.scopeKey) ?? []
      list.push(item)
      byScope.set(item.scopeKey, list)

      const op = item.op
      if (op.op === 'search' && op.ok && typeof op.query === 'string' && op.query.trim()) {
        const norm = op.query.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
        const key = `${item.scopeKey}\0${norm}`
        let entry = queryMisses.get(key)
        if (!entry) {
          entry = {
            scope: item.scope, ...(item.projectId ? { projectId: item.projectId } : {}),
            scopeKey: item.scopeKey, displayQuery: op.query,
            missTurns: new Map(), totalQueryTurns: new Set()
          }
          queryMisses.set(key, entry)
        }
        entry.totalQueryTurns.add(bucket.turnKey)
        if (op.offset === 0 && op.hits === 0 && op.hasMore === false) {
          entry.missTurns.set(bucket.turnKey, { row: bucket.row, opProjectId: item.projectId, hasAnchor: Boolean(bucket.row.anchorEntryId) })
        }
      }
    }

    for (const scopeKey of byScope.keys()) scopeTurnCounts.set(scopeKey, (scopeTurnCounts.get(scopeKey) ?? 0) + 1)
    if (!bucket.row.opsTruncated) {
      for (const [scopeKey, scopeOps] of byScope) {
        const onlyIndexOrList = scopeOps.every(({ op }) =>
          op.ok && (op.op === 'list' || (op.op === 'read' && op.path === 'MEMORY.md'))
        )
        if (!onlyIndexOrList) continue
        const first = scopeOps[0]!
        let entry = emptyLookupsByScope.get(scopeKey)
        if (!entry) {
          entry = { scope: first.scope, ...(first.projectId ? { projectId: first.projectId } : {}), turns: new Map() }
          emptyLookupsByScope.set(scopeKey, entry)
        }
        entry.turns.set(bucket.turnKey, { row: bucket.row, opProjectId: first.projectId, hasAnchor: Boolean(bucket.row.anchorEntryId) })
      }
    }
  }

  for (const entry of queryMisses.values()) {
    if (entry.missTurns.size < 2) continue
    const roundsList = [...entry.missTurns.values()]
    addCandidate(priority3, {
      priority: 3, kind: 'repeated_miss', subkind: 'zero_hit_query',
      scope: entry.scope, ...(entry.projectId ? { projectId: entry.projectId } : {}),
      query: entry.displayQuery, numerator: entry.missTurns.size, denominator: entry.totalQueryTurns.size,
      reason: `Initial search for "${entry.displayQuery}" returned 0 hits in ${entry.missTurns.size} independent turns`,
      signalThrough: Math.max(...roundsList.map(item => item.row.at)),
      rawRounds: roundsList, score: 1000 + entry.missTurns.size * 10,
      weak: roundsList.every(item => !item.hasAnchor)
    })
  }

  for (const [scopeKey, entry] of emptyLookupsByScope) {
    if (entry.turns.size < 2) continue
    const roundsList = [...entry.turns.values()]
    addCandidate(priority3, {
      priority: 3, kind: 'repeated_miss', subkind: 'empty_lookup',
      scope: entry.scope, ...(entry.projectId ? { projectId: entry.projectId } : {}),
      numerator: entry.turns.size,
      denominator: scopeTurnCounts.get(scopeKey)!,
      reason: `Read MEMORY.md or listed directory without opening any topic note across ${entry.turns.size} independent turns (weak lead)`,
      weak: true,
      signalThrough: Math.max(...roundsList.map(item => item.row.at)),
      rawRounds: roundsList, score: 100 + entry.turns.size
    })
  }
  priority3.sort((a, b) => b.score - a.score)

  // 4. Stale unread (14-day observation period, reliable coverage, >=10 MEMORY.md initial-read turns, reachable only)
  const priority4: DraftCandidate[] = []
  const reliableStart = telemetry.coverage.reliableStartAt
  if (reliableStart !== undefined && now - reliableStart >= STALE_OBSERVATION_MS) {
    for (const graph of graphs.values()) {
      for (const note of graph.notes.values()) {
        if (note.path === 'MEMORY.md' || !graph.reachable.has(note.path)) continue
        if (sanitizeTelemetryPath(note.path) === undefined) continue
        if (now - note.mtimeMs < STALE_OBSERVATION_MS) continue
        const observeFrom = Math.max(note.mtimeMs, reliableStart)
        if (now - observeFrom < STALE_OBSERVATION_MS) continue

        const indexTurns = countReadsSince(indexReads.get(graph.scopeKey) ?? [], observeFrom)
        if (indexTurns < STALE_INDEX_MIN_TURNS || (noteStats.get(note)?.latestReadAt ?? -Infinity) >= observeFrom) continue

        const draft: DraftCandidate = {
          priority: 4, kind: 'stale', scope: graph.scope, ...(graph.projectId ? { projectId: graph.projectId } : {}),
          path: note.path, rev: note.rev, numerator: 0, denominator: indexTurns,
          reason: `No direct reads observed within window (${indexTurns} MEMORY.md first-read turns over ${Math.floor((now - observeFrom) / 86_400_000)} days)`,
          signalThrough: 0, rawRounds: [], score: indexTurns
        }
        addCandidate(priority4, draft)
      }
    }
  }
  priority4.sort((a, b) => b.score - a.score)

  const perPriorityLimit = topicMatches ? 3 : MAX_CANDIDATES_PER_CATEGORY
  const rankedGroups = [priority1, priority2, priority3, priority4]
  const selectedDrafts = rankedGroups.flatMap(group => group.slice(0, perPriorityLimit))
  if (topicMatches) selectedDrafts.splice(8)

  const candidates: AuditCandidate[] = []
  let seq = 0
  for (const draft of selectedDrafts) {
    seq += 1
    const picked = selectRepresentativeRounds(draft.rawRounds)
    const rounds: AuditCandidateRound[] = picked.map(item => ({
      sessionId: item.row.sessionId,
      turnId: item.row.turnId,
      ...(item.row.anchorEntryId ? { anchorEntryId: item.row.anchorEntryId } : {}),
      at: item.row.at,
      outcome: item.row.outcome,
      ...(item.row.projectId ? { projectId: item.row.projectId } : {}),
      ...(!item.hasAnchor ? { weak: true } : {}),
      historyAvailable: false,
      ...(item.opProjectId && item.opProjectId !== item.row.projectId ? { altProjectId: item.opProjectId } : {})
    }))
    const { rawRounds: _raw, score: _score, ...rest } = draft
    candidates.push({
      id: `cand-${seq}`,
      ...rest,
      ...(rest.brokenLinks ? { brokenLinks: rest.brokenLinks.slice(0, 10) } : {}),
      rounds
    })
  }

  const report: AuditHealthReport = {
    scope: options.scope,
    generatedAt: now,
    verifiedProjects: [...options.verifiedProjects.values()],
    coverage: telemetry.coverage,
    candidates,
    suppressedCount
  }

  if (options.verifyHistory !== false) {
    await verifyAuditReportHistory(report, options.history)
  }

  return report
}

export async function verifyAuditReportHistory(report: AuditHealthReport, history: DreamHistory): Promise<AuditHealthReport> {
  for (const candidate of report.candidates) {
    for (const round of candidate.rounds) {
      const altProjectId = candidate.scope === 'project' ? candidate.projectId : undefined
      const verification = await history.verifyAuditRound({
        sessionId: round.sessionId,
        turnId: round.turnId,
        anchorEntryId: round.anchorEntryId,
        expectedProjectId: round.projectId,
        altProjectId
      })
      round.historyAvailable = verification.historyAvailable
      if (verification.reason) round.historyUnavailableReason = verification.reason
      else delete round.historyUnavailableReason
      if (verification.evidenceIncomplete) {
        round.evidenceIncomplete = true
        round.weak = true
      }
    }
    if (candidate.rounds.length > 0 && candidate.rounds.every(r => r.weak)) {
      candidate.weak = true
    }
  }
  return report
}

function matchTopic(topic: string, requestedPaths?: string[]) {
  const tokens = topic.toLocaleLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff_./-]+/)
    .filter(token => token.length >= 2)
  const wantedPaths = (requestedPaths ?? []).map(path => path.toLocaleLowerCase()).filter(Boolean)
  return (candidate: Pick<AuditCandidate, 'path' | 'from' | 'query' | 'brokenLinks'>): boolean => {
    const paths = [candidate.path, candidate.from, ...(candidate.brokenLinks ?? [])]
    if (paths.some(path => {
      const lower = path?.toLocaleLowerCase()
      return lower && wantedPaths.some(wanted => lower === wanted || lower.endsWith(`/${wanted}`))
    })) return true
    const haystack = [...paths, candidate.query].join(' ').toLocaleLowerCase()
    return tokens.some(token => haystack.includes(token))
  }
}
