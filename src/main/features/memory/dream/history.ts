/** Lazy, byte-indexed history. Search scans user/final records; tool bodies are read only on demand.
 * Indexing keeps bounded line probes, so a huge JSONL or tool-result line never becomes one string. */
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { probeSessionRow, readSessionHeader } from '../../../pi/session-jsonl'
import { collectAllFiles } from '../../../pi/session-loader'
import { memoryAccess, isChatMemoryCwd } from '../long-term/access'
import { projectMemoryKey, revisionOf } from '../long-term/files'

export interface DreamSource { id: string; title: string; path: string; cwd: string }
export interface AuditRoundInput { sessionId: string; turnId: string; anchorEntryId?: string; expectedProjectId?: string; altProjectId?: string }
export interface AuditRoundVerification { historyAvailable: boolean; reason?: string; resolvedProjectId?: string; evidenceIncomplete?: boolean }
interface Row { id: string; parentId: string | null; type: string; role: string | null; start: number; bytes: number }
interface HistoryIndex { rows: Row[]; byId: Map<string, Row>; turns: number[]; sessionId: string; leaf: string | null; size: number }
interface RecordText { entryId: string; timestamp?: string; role: string; text: string; incomplete?: string; digest?: string; entry?: SessionEntry }
const PROBE = 8192
const RECORD_LIMIT = 8 * 1024 * 1024
const PAGE = 14000
const PLACEHOLDER_LINES = new Set([
  '[Record omitted: exceeds the bounded record reader]',
  '[Attachment omitted]',
  '[Credential omitted]',
  '[Reply failed]',
  '[Reply interrupted]',
  '[Assistant requested tool calls; no final reply]',
  '[Assistant stopped after tool calls]'
])
function hasSubstantiveReadEvidence(record: RecordText, offset: number, length: number): boolean {
  if (record.incomplete === 'record_bytes_limit' || length <= 0) return false
  const end = offset + length
  let pos = 0
  for (const line of record.text.split('\n')) {
    const lineStart = pos
    const lineEnd = pos + line.length
    pos = lineEnd + 1
    const trimmed = line.trim()
    if (!trimmed || PLACEHOLDER_LINES.has(trimmed)) continue
    const overlapStart = Math.max(offset, lineStart)
    const overlapEnd = Math.min(end, lineEnd)
    if (overlapStart < overlapEnd && record.text.slice(overlapStart, overlapEnd).trim().length > 0) {
      return true
    }
  }
  return false
}
const DREAM_CREDENTIAL_RE = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----|\b(?:sk-|rk-|github_pat_|gh[pousr]_)[A-Za-z0-9_-]{16,}|\bAKIA[A-Z0-9]{16}\b|\b(?:password|api[_-]?key|secret|token)["']?\s*[:=]\s*["']?[^\s"'<>]{12,}/gi
const CREDENTIAL_OMITTED = '[Credential omitted]'
export function redactDreamText(text: string): string {
  return text.replace(DREAM_CREDENTIAL_RE, CREDENTIAL_OMITTED)
}

const TOOL_PAGE = 12000

function hasPayloadEvidence(json: string, start: number, end: number): boolean {
  const tokens = /"((?:\\.|[^"\\])*)"(\s*:)?|true|false|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g
  for (const token of json.matchAll(tokens)) {
    const at = token.index!
    if (at >= end) break
    if (at + token[0].length <= start || token[2]) continue // Property names are not evidence.
    if (token[1] === undefined) return true
    // Match whole encoded characters and placeholders before intersecting the page, even if it cuts through them.
    const chars = /\[[^[\]\\]*\]|\\u[\da-fA-F]{4}|\\.|[^\\[]+|\[/g
    for (const part of token[1].matchAll(chars)) {
      const pos = at + 1 + part.index!
      if (pos >= end) break
      if (pos + part[0].length <= start || PLACEHOLDER_LINES.has(part[0])) continue
      if (part[0].startsWith('\\')) {
        if (pos >= start && pos + part[0].length <= end && (JSON.parse('"' + part[0] + '"') as string).trim()) return true
      } else if (part[0].slice(Math.max(0, start - pos), end - pos).trim()) return true
    }
  }
  return false
}

function toolPage(records: { serialized: string; payload?: string }[], offset: number) {
  const text = '[' + records.map(record => record.serialized).join(',') + ']'
  let pos = 1
  const payloads = records.flatMap(({ serialized, payload }) => {
    const end = pos + serialized.length - 1
    pos = end + 2
    return payload ? [{ start: end - payload.length, end, json: payload }] : []
  })
  let sourceOffset = 0, pageOffset = 0
  let inspected = false
  // Map only the unchanged ranges of the returned redacted page back to payload coordinates.
  const inspect = (end: number) => {
    const start = Math.max(sourceOffset, sourceOffset + offset - pageOffset)
    const stop = Math.min(end, sourceOffset + offset + TOOL_PAGE - pageOffset)
    if (!inspected && start < stop) {
      inspected = payloads.some(payload => payload.start < stop && payload.end > start &&
        hasPayloadEvidence(payload.json, start - payload.start, stop - payload.start))
    }
    pageOffset += end - sourceOffset
  }
  const redacted = text.replace(DREAM_CREDENTIAL_RE, (match, at: number) => {
    inspect(at)
    sourceOffset = at + match.length
    pageOffset += CREDENTIAL_OMITTED.length
    return CREDENTIAL_OMITTED
  })
  inspect(text.length)
  return { fragment: redacted.slice(offset, offset + TOOL_PAGE), hasMore: offset + TOOL_PAGE < redacted.length, inspected }
}

function toolRecord(metadata: object, field?: string, value?: unknown) {
  const payload = field && JSON.stringify(value)
  const serialized = JSON.stringify(metadata)
  return payload ? { serialized: serialized.slice(0, -1) + ',' + JSON.stringify(field) + ':' + payload + '}', payload } : { serialized }
}
const textOf = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content)
  ? content.flatMap(block => block?.type === 'text' && typeof block.text === 'string' ? [block.text] : block?.type === 'image' || block?.type === 'file' ? ['[Attachment omitted]'] : []).join('\n') : ''
export async function loadDreamSources(signal?: AbortSignal): Promise<DreamSource[]> {
  const sources: { source: DreamSource; modified: number }[] = []
  for (const path of await collectAllFiles(signal)) {
    signal?.throwIfAborted()
    const info = await stat(path)
    signal?.throwIfAborted()
    // Header reads are capped; discovery never decodes messages just to obtain a title.
    const header = readSessionHeader(path)
    if (header.cwd) sources.push({ source: { id: header.sessionId, title: redactDreamText(`${basename(header.cwd)} · ${header.sessionId.slice(0, 8)}`).slice(0, 100), path, cwd: header.cwd }, modified: info.mtimeMs })
  }
  return sources.sort((a, b) => b.modified - a.modified || b.source.path.localeCompare(a.source.path)).map(item => item.source)
}

export async function indexDreamSource(source: DreamSource, signal?: AbortSignal, snapshot?: { size: number; leaf: string | null }): Promise<HistoryIndex> {
  const size = snapshot?.size ?? (await stat(source.path)).size
  const byId = new Map<string, Row>()
  let header = ''
  let first = Buffer.alloc(0), last = Buffer.alloc(0), length = 0, start = 0
  const append = (part: Buffer) => {
    if (first.length < PROBE) first = Buffer.concat([first, part.subarray(0, PROBE - first.length)])
    last = Buffer.concat([last, part.subarray(-PROBE)]).subarray(-PROBE)
    length += part.length
  }
  const finish = (terminated: boolean) => {
    let line = length <= PROBE ? first : Buffer.concat([first.subarray(0, Math.min(PROBE, length - last.length)), last])
    if (line.at(-1) === 13) line = line.subarray(0, -1)
    if (line.length) {
      let row = probeSessionRow(line)
      if (!row && length <= PROBE * 2) {
        try {
          const entry = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line))
          if (entry.type === 'session') header = entry.id
          else if (typeof entry.id === 'string' && (entry.parentId == null || typeof entry.parentId === 'string')) row = { id: entry.id, parentId: entry.parentId ?? null, type: entry.type, role: entry.message?.role ?? null }
          else throw new Error('Unsupported historical record')
        } catch { if (terminated && line.toString('utf8').trim()) throw new Error('DREAM_SOURCE: Invalid historical record') }
      }
      if (!row && length > PROBE * 2) throw new Error('DREAM_SOURCE: Unsupported historical record layout')
      if (row) {
        if (byId.has(row.id)) throw new Error('DREAM_SOURCE: Duplicate history entry')
        if (byId.size >= 1_000_000) throw new Error('DREAM_BUDGET: History index limit reached')
        byId.set(row.id, { ...row, start, bytes: length })
      }
    }
    start += length + (terminated ? 1 : 0); length = 0; first = Buffer.alloc(0); last = Buffer.alloc(0)
  }
  if (size) for await (const chunk of createReadStream(source.path, { highWaterMark: 64 * 1024, end: size - 1, signal })) {
    signal?.throwIfAborted()
    const bytes = chunk as Buffer
    let offset = 0
    for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, offset)) {
      append(bytes.subarray(offset, end)); finish(true); offset = end + 1
    }
    append(bytes.subarray(offset))
  }
  if (length) finish(false)
  if (header !== source.id) throw new Error('DREAM_SOURCE: Historical session identity changed')
  const leaf = snapshot ? snapshot.leaf : [...byId.keys()].at(-1) ?? null
  const rows: Row[] = [], seen = new Set<string>()
  for (let id = leaf; id;) {
    if (seen.has(id)) throw new Error('DREAM_SOURCE: Cyclic history branch')
    seen.add(id)
    const row = byId.get(id)
    if (!row) throw new Error('DREAM_SOURCE: Missing history parent')
    rows.push(row); id = row.parentId
  }
  rows.reverse()
  return { rows, byId, sessionId: header, leaf, size, turns: rows.flatMap((row, index) => row.type === 'message' && row.role === 'user' ? [index] : []) }
}
async function readRecord(source: DreamSource, row: Row): Promise<RecordText> {
  if (row.bytes > RECORD_LIMIT) return { entryId: row.id, role: row.role ?? row.type, text: '[Record omitted: exceeds the bounded record reader]', incomplete: 'record_bytes_limit' }
  const handle = await open(source.path, 'r')
  try {
    const bytes = Buffer.alloc(row.bytes)
    let offset = 0
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, row.start + offset)
      if (!read.bytesRead) throw new Error('DREAM_SOURCE: Historical record is no longer available')
      offset += read.bytesRead
    }
    let entry: SessionEntry
    try { entry = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch { throw new Error('DREAM_SOURCE: Unable to parse historical record') }
    if (entry.id !== row.id || entry.parentId !== row.parentId) throw new Error('DREAM_SOURCE: Historical record changed')
    const message = entry.type === 'message' ? entry.message : undefined
    return { entryId: row.id, timestamp: entry.timestamp, role: row.role ?? row.type, text: redactDreamText(message ? textOf('content' in message ? message.content : '') : ''), digest: revisionOf(bytes.toString('utf8')), entry }
  } finally { await handle.close() }
}

export class DreamHistory {
  private indexes = new Map<string, HistoryIndex>()
  private snapshots = new Map<string, { size: number; leaf: string | null }>()
  private contexts = new Map<string, Awaited<ReturnType<DreamHistory['context']>>>()
  private projects = new Map<string, string>()
  private hits = new Map<string, Set<string>>()
  private auditWhitelist = new Map<string, Set<string>>()
  private inspectedRounds = new Set<string>()
  private auditMode = false
  private readSet = new Map<string, { source: DreamSource; row: Row; digest: string }>()
  private cursors = new Map<string, { key: string; position: number[] }>()
  constructor(readonly sources: DreamSource[], private readonly signal?: AbortSignal,
    private readonly progress: (phase: 'searching' | 'reading', current: string) => void = () => {}) {}
  enableAuditWhitelist(): void { this.auditMode = true }
  allowAuditRound(sessionId: string, turnId: string): void {
    const allowed = this.auditWhitelist.get(sessionId) ?? new Set<string>()
    allowed.add(turnId)
    this.auditWhitelist.set(sessionId, allowed)
    const hits = this.hits.get(sessionId) ?? new Set<string>()
    hits.add(turnId)
    this.hits.set(sessionId, hits)
  }
  hasInspectedRound(sessionId: string, turnId: string): boolean {
    return this.inspectedRounds.has(`${sessionId}\0${turnId}`)
  }
  async verifyAuditRound(input: AuditRoundInput): Promise<AuditRoundVerification> {
    const source = this.sources.find(item => item.id === input.sessionId)
    if (!source) return { historyAvailable: false, reason: 'session_missing' }
    const ctx = await this.context(source)
    if (ctx.projectIdentity === 'unresolved') return { historyAvailable: false, reason: 'project_unverified' }
    if (input.expectedProjectId !== undefined || input.altProjectId !== undefined) {
      const allowed = new Set([input.expectedProjectId, input.altProjectId].filter((id): id is string => typeof id === 'string'))
      if (!ctx.projectId || !allowed.has(ctx.projectId)) return { historyAvailable: false, reason: 'project_mismatch' }
    } else if (ctx.projectIdentity !== 'chat') {
      return { historyAvailable: false, reason: 'project_mismatch' }
    }
    let index: HistoryIndex
    try {
      index = await this.index(source)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || (error instanceof Error && error.message.startsWith('DREAM_SOURCE:'))) {
        return { historyAvailable: false, reason: 'source_unreadable' }
      }
      throw error
    }
    const userRow = index.byId.get(input.turnId)
    if (!userRow || userRow.type !== 'message' || userRow.role !== 'user') {
      return { historyAvailable: false, reason: 'turn_missing' }
    }
    const activeIds = new Set(index.rows.map(row => row.id))
    if (!activeIds.has(input.turnId)) {
      return { historyAvailable: false, reason: 'branch_switched' }
    }
    if (input.anchorEntryId) {
      const anchor = index.byId.get(input.anchorEntryId)
      if (!anchor) return { historyAvailable: false, reason: 'anchor_missing' }
      if (!activeIds.has(input.anchorEntryId)) return { historyAvailable: false, reason: 'branch_switched' }
      let cursor: Row | undefined = anchor
      let reachedTurn = false
      const seen = new Set<string>()
      while (cursor) {
        if (seen.has(cursor.id)) break
        seen.add(cursor.id)
        if (cursor.id === userRow.id) { reachedTurn = true; break }
        if (cursor.type === 'message' && cursor.role === 'user') break
        cursor = cursor.parentId ? index.byId.get(cursor.parentId) : undefined
      }
      if (!reachedTurn) return { historyAvailable: false, reason: 'anchor_mismatch' }
      this.allowAuditRound(input.sessionId, input.turnId)
      return { historyAvailable: true, resolvedProjectId: ctx.projectId }
    }
    const children = new Map<string, Row[]>()
    for (const row of index.byId.values()) {
      if (!row.parentId) continue
      const list = children.get(row.parentId)
      if (list) list.push(row)
      else children.set(row.parentId, [row])
    }
    const queue: Row[] = [userRow]
    const visited = new Set<string>([userRow.id])
    while (queue.length > 0) {
      const current = queue.shift()!
      const kids = children.get(current.id) ?? []
      if (kids.length > 1) return { historyAvailable: false, reason: 'ambiguous_branch' }
      for (const kid of kids) {
        if (!activeIds.has(kid.id)) return { historyAvailable: false, reason: 'ambiguous_branch' }
        if (visited.has(kid.id)) continue
        visited.add(kid.id)
        if (!(kid.type === 'message' && kid.role === 'user')) queue.push(kid)
      }
    }
    this.allowAuditRound(input.sessionId, input.turnId)
    return { historyAvailable: true, resolvedProjectId: ctx.projectId, evidenceIncomplete: true }
  }
  private source(id: string) {
    const source = this.sources.find(source => source.id === id)
    if (!source) throw new Error('DREAM_SOURCE: Conversation is outside this run')
    return source
  }
  private async index(source: DreamSource) {
    this.signal?.throwIfAborted()
    let index = this.indexes.get(source.id)
    if (!index) {
      index = await indexDreamSource(source, this.signal, this.snapshots.get(source.id))
      this.snapshots.set(source.id, { size: index.size, leaf: index.leaf })
      if (this.indexes.size >= 8) this.indexes.delete(this.indexes.keys().next().value!)
    }
    this.indexes.delete(source.id); this.indexes.set(source.id, index)
    return index
  }
  async context(source: DreamSource): Promise<{ project: string; originalCwd: string; projectId?: string; projectIdentity: 'resolved' | 'unresolved' | 'chat' }> {
    const cached = this.contexts.get(source.id)
    if (cached) return cached
    let project: string | null = null
    const chat = isChatMemoryCwd(source.cwd)
    try {
      const access = await memoryAccess({ cwd: source.cwd, sessionManager: { getSessionId: () => source.id } as Parameters<typeof memoryAccess>[0]['sessionManager'] })
      if (!access.project.startsWith('chat:')) project = access.project
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      try { await stat(source.cwd); throw error } catch (cause) {
        if (!['ENOENT', 'ENOTDIR'].includes((cause as NodeJS.ErrnoException).code ?? '')) throw cause
      }
    }
    const projectId = project ? projectMemoryKey(project) : undefined
    if (projectId) this.projects.set(projectId, project!)
    const value = { project: chat ? 'Chat' : basename(source.cwd), originalCwd: redactDreamText(source.cwd), projectId,
      projectIdentity: (chat ? 'chat' : project ? 'resolved' : 'unresolved') as 'chat' | 'resolved' | 'unresolved' }
    this.contexts.set(source.id, value)
    return value
  }
  projectKey(id: string): string {
    const key = this.projects.get(id)
    if (!key) throw new Error('DREAM_SCOPE: Use a reliable projectId returned by history tools')
    return key
  }
  writableScopes(): Set<string> { return new Set(['global', ...[...this.projects.keys()].map(id => `projects/${id}`)]) }
  private position(key: string, cursor: string | undefined, initial: number[]): number[] {
    if (!cursor) return initial
    const value = this.cursors.get(cursor)
    if (!value || value.key !== key) throw new Error('DREAM_CURSOR: Cursor does not belong to these arguments')
    return value.position
  }
  private next(key: string, position: number[]) { const cursor = randomUUID(); this.cursors.set(cursor, { key, position }); return cursor }
  private remember(source: DreamSource, row: Row, record: RecordText) {
    if (record.digest) this.readSet.set(`${source.id}/${row.id}`, { source, row, digest: record.digest })
  }
  private async round(source: DreamSource, index: HistoryIndex, turn: number) {
    const from = index.turns[turn], end = index.turns[turn + 1] ?? index.rows.length
    const userRow = index.rows[from]
    const assistantRow = index.rows.slice(from + 1, end).findLast(row => row.role === 'assistant')
    if (!assistantRow) return null
    const assistant = await readRecord(source, assistantRow)
    if (assistant.entry?.type === 'message' && assistant.entry.message.role === 'assistant') {
      const message = assistant.entry.message
      if (message.stopReason === 'aborted' || message.stopReason === 'error') assistant.text = message.stopReason === 'error' ? '[Reply failed]' : '[Reply interrupted]'
      else if (message.stopReason !== 'stop' || message.content.some(block => block.type === 'toolCall')) return null
    }
    const user = await readRecord(source, userRow)
    return { turnId: userRow.id, records: [{ row: userRow, record: user }, { row: assistantRow, record: assistant }], from, end }
  }
  private async auditRound(source: DreamSource, index: HistoryIndex, turn: number) {
    const from = index.turns[turn], end = index.turns[turn + 1] ?? index.rows.length
    const userRow = index.rows[from]
    const user = await readRecord(source, userRow)
    const assistantRow = index.rows.slice(from + 1, end).findLast(row => row.role === 'assistant')
    if (!assistantRow) {
      return { turnId: userRow.id, records: [{ row: userRow, record: user }], from, end }
    }
    const assistant = await readRecord(source, assistantRow)
    if (assistant.entry?.type === 'message' && assistant.entry.message.role === 'assistant') {
      const message = assistant.entry.message
      if (message.stopReason === 'error') {
        assistant.text = '[Reply failed]'
      } else if (message.stopReason === 'aborted') {
        assistant.text = '[Reply interrupted]'
      } else if (message.stopReason === 'toolUse') {
        const suffix = '[Assistant requested tool calls; no final reply]'
        assistant.text = assistant.text.trim() ? `${assistant.text}\n${suffix}` : suffix
        assistant.incomplete ??= 'tool_use_no_final_reply'
      } else if (message.stopReason === 'stop' && message.content.some(block => block.type === 'toolCall')) {
        const suffix = '[Assistant stopped after tool calls]'
        assistant.text = assistant.text.trim() ? `${assistant.text}\n${suffix}` : suffix
      }
    }
    return { turnId: userRow.id, records: [{ row: userRow, record: user }, { row: assistantRow, record: assistant }], from, end }
  }
  async search(args: { query: string; projectId?: string; sessionId?: string; cursor?: string }) {
    if (!args.query.trim() || args.query.length > 200) throw new Error('DREAM_QUERY: Use a nonempty query of at most 200 characters')
    if (args.projectId) this.projectKey(args.projectId)
    if (args.sessionId) this.source(args.sessionId)
    this.progress('searching', redactDreamText(args.query))
    const key = JSON.stringify(['search', args.query, args.projectId, args.sessionId])
    const [startSource, startTurn] = this.position(key, args.cursor, [0, 0])
    const items: unknown[] = []
    let omittedRecords = 0
    for (let s = startSource; s < this.sources.length; s++) {
      this.signal?.throwIfAborted()
      const source = this.sources[s]
      if (args.sessionId && source.id !== args.sessionId) continue
      if (args.projectId && (await this.context(source)).projectId !== args.projectId) continue
      const index = await this.index(source)
      for (let t = s === startSource ? startTurn : 0; t < index.turns.length; t++) {
        this.signal?.throwIfAborted()
        const round = await this.round(source, index, t)
        if (!round) continue
        const text = round.records.map(item => item.record.text).join('\n')
        omittedRecords += round.records.filter(item => item.record.incomplete).length
        const hit = text.toLocaleLowerCase().indexOf(args.query.toLocaleLowerCase())
        if (hit < 0) continue
        const allowed = this.hits.get(source.id) ?? new Set<string>(); allowed.add(round.turnId); this.hits.set(source.id, allowed)
        for (const item of round.records) this.remember(source, item.row, item.record)
        items.push({ sessionId: source.id, turnId: round.turnId, ...await this.context(source), timestamp: round.records[0].record.timestamp,
          excerpt: text.slice(Math.max(0, hit - 100), hit + 300), incomplete: round.records.some(item => item.record.incomplete) })
        if (items.length === 20) return { items, omittedRecords, nextCursor: this.next(key, [s, t + 1]) }
      }
    }
    return { items, omittedRecords, nextCursor: null }
  }
  async read(args: { sessionId: string; turnId: string; before?: number; after?: number; cursor?: string }) {
    const source = this.source(args.sessionId), index = await this.index(source)
    const before = args.before ?? 1, after = args.after ?? 1
    if (![before, after].every(value => Number.isInteger(value) && value >= 0 && value <= 10)) throw new Error('DREAM_QUERY: Context range must be between 0 and 10 rounds')
    const allowedSet = this.auditMode ? this.auditWhitelist.get(source.id) : this.hits.get(source.id)
    if (!allowedSet?.has(args.turnId)) {
      throw new Error(this.auditMode ? 'DREAM_SOURCE: Round is outside the host audit whitelist' : 'DREAM_SOURCE: Locate this round with history search first')
    }
    const at = index.turns.findIndex(position => index.rows[position].id === args.turnId)
    if (at < 0) throw new Error('DREAM_SOURCE: Round not found')
    this.progress('reading', source.title)
    const key = JSON.stringify(['read', args.sessionId, args.turnId, before, after])
    const [start, pieceOffset] = this.position(key, args.cursor, [Math.max(0, at - before), 0])
    const records: unknown[] = []
    let budget = PAGE
    const useAuditRound = this.auditMode || Boolean(this.auditWhitelist.get(source.id)?.has(args.turnId))
    for (let t = start; t <= Math.min(index.turns.length - 1, at + after); t++) {
      const round = useAuditRound ? await this.auditRound(source, index, t) : await this.round(source, index, t)
      if (!round) continue
      if (!this.auditMode) this.hits.get(source.id)!.add(round.turnId)
      let offset = t === start ? pieceOffset : 0
      for (const { row, record } of round.records) {
        if (offset >= record.text.length && record.text.length) { offset -= record.text.length; continue }
        const text = record.text.slice(offset, offset + budget)
        records.push({ turnId: round.turnId, entryId: record.entryId, role: record.role, timestamp: record.timestamp, text,
          offset, incomplete: record.incomplete, hasMore: offset + text.length < record.text.length })
        this.remember(source, row, record)
        if (round.turnId === args.turnId && hasSubstantiveReadEvidence(record, offset, text.length)) {
          this.inspectedRounds.add(`${source.id}\0${args.turnId}`)
        }
        budget -= text.length; offset += text.length
        if (offset < record.text.length || budget === 0) {
          const preceding = round.records[0].record.entryId === record.entryId ? 0 : round.records[0].record.text.length
          return { sessionId: source.id, ...await this.context(source), records, nextCursor: this.next(key, [t, preceding + offset]) }
        }
        offset = 0
      }
    }
    return { sessionId: source.id, ...await this.context(source), records, nextCursor: null }
  }
  async tools(args: { sessionId: string; turnId: string; cursor?: string }) {
    const source = this.source(args.sessionId), index = await this.index(source)
    const allowedSet = this.auditMode ? this.auditWhitelist.get(source.id) : this.hits.get(source.id)
    if (!allowedSet?.has(args.turnId)) {
      throw new Error(this.auditMode ? 'DREAM_SOURCE: Round is outside the host audit whitelist' : 'DREAM_SOURCE: Locate or read this round first')
    }
    const at = index.turns.findIndex(position => index.rows[position].id === args.turnId)
    if (at < 0) throw new Error('DREAM_SOURCE: Round not found')
    this.progress('reading', source.title)
    const key = JSON.stringify(['tools', args.sessionId, args.turnId])
    const [start, textOffset] = this.position(key, args.cursor, [index.turns[at] + 1, 0])
    const end = index.turns[at + 1] ?? index.rows.length
    for (let i = start; i < end; i++) {
      const row = index.rows[i]
      if (row.type !== 'message' || !['assistant', 'toolResult'].includes(row.role ?? '')) continue
      const record = await readRecord(source, row)
      const message = record.entry?.type === 'message' ? record.entry.message : undefined
      const records = record.incomplete ? [toolRecord({ entryId: row.id, omitted: record.incomplete, bytes: row.bytes })]
        : message?.role === 'assistant' ? message.content.flatMap(block => block.type === 'toolCall'
          ? [toolRecord({ type: 'call', id: block.id, name: block.name }, 'arguments', block.arguments)] : [])
        : message?.role === 'toolResult' ? [toolRecord({ type: 'result', id: message.toolCallId, name: message.toolName, isError: message.isError }, 'content', record.text)]
        : []
      if (!records.length) continue
      this.remember(source, row, record)
      const offset = i === start ? textOffset : 0
      const { fragment, hasMore, inspected } = toolPage(records, offset)
      if (inspected) this.inspectedRounds.add(`${source.id}\0${args.turnId}`)
      return { sessionId: source.id, turnId: args.turnId, format: 'JSON text fragment', text: fragment,
        nextCursor: hasMore ? this.next(key, [i, offset + TOOL_PAGE]) : i + 1 < end ? this.next(key, [i + 1, 0]) : null }
    }
    return { sessionId: source.id, turnId: args.turnId, text: '', nextCursor: null }
  }
  async validateReadSources() {
    const checked = new Set<string>()
    for (const { source, row, digest } of this.readSet.values()) {
      this.signal?.throwIfAborted()
      if (!checked.has(source.id)) {
        if (readSessionHeader(source.path).sessionId !== source.id) throw new Error('DREAM_SOURCE: Reviewed session identity changed')
        checked.add(source.id)
      }
      const current = await readRecord(source, row)
      if (current.digest !== digest) throw new Error('DREAM_SOURCE: A reviewed historical record changed')
    }
  }
}
