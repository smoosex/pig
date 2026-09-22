/**
 * Byte-level reader for session JSONL files.
 *
 * The SDK can only write into a session through a `SessionManager` that holds the whole file, but
 * everything pig needs while a session is still unbuilt is a handful of small reads: the entry tree,
 * the current branch, turn boundaries, and the lines a request actually asks for.
 *
 * This reader scans the file as bytes. It reads every byte once (a 584MB session indexes in about
 * 170ms) but decodes only the fields it probes for, retains one small record per line, and parses
 * payloads lazily. Anything it cannot prove throws `UnsupportedSessionFile` so the caller can fall
 * back to `SessionManager.open`.
 *
 * The probes are coupled to the entry key order the SDK writes: `type` is always first, `id` and
 * `parentId` sit next to each other, and only `custom`/`custom_message` entries put their payload
 * ahead of them. A line that does not fit that shape is parsed in full instead of guessed at.
 */
import { appendFileSync, closeSync, openSync, readSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  CURRENT_SESSION_VERSION,
  parseSessionEntries,
  type SessionEntry
} from '@earendil-works/pi-coding-agent'
import type { TurnSummary } from '../../shared/api'
import { PASTED_TEXT_CUSTOM_TYPE } from '../../shared/pasted-text'
import { isHiddenEntryType } from './session-display-model'

const SCAN_CHUNK = 4 * 1024 * 1024
/** Enough of a file's tail to hold its last line; a longer line grows the read. */
const LAST_LINE_BYTES = 64 * 1024
const NEWLINE = 0x0a
const HEADER_SCAN_LIMIT = 1024 * 1024
const TYPE_PREFIX = Buffer.from('{"type"')
const KEY_ID = Buffer.from('"id"')
const KEY_PARENT = Buffer.from('"parentId"')
const KEY_ROLE = Buffer.from('"role"')
const ROLE_PROBE_LIMIT = 512
const EMPTY = Buffer.alloc(0)
/** How an image block starts in a written line: the SDK serializes `type` first. */
const IMAGE_BLOCK = Buffer.from('"type":"image"')
/** The attachment marker of a pasted text: that custom row belongs to the user message after it. */
const PASTED_TEXT_MARKER = Buffer.from(`"customType":"${PASTED_TEXT_CUSTOM_TYPE}"`)
/** The fields the session tree reads from an otherwise heavy row. */
const TOOL_CALL_ID_KEY = Buffer.from('"toolCallId":"')
const TOOL_NAME_KEY = Buffer.from('"toolName":"')
const TOKENS_BEFORE_KEY = Buffer.from('"tokensBefore":')
const TIMESTAMP_KEY = Buffer.from('"timestamp":"')
/** A user line heavier than this is treated as "heavy": the minimap must stay readable. */
/**
 * The byte size a minimap bar grows to before it stops growing. Both sources measure the same thing:
 * the length of the line the SDK writes for the turn's opening entry, with an image turn simply full.
 */
export const SUMMARY_BYTES_CAP = 4096

/** Types whose payload precedes `id`/`parentId`, so the last key occurrence is the real one. */
const PAYLOAD_FIRST = new Set(['custom', 'custom_message'])

export interface SessionFileEntry {
  id: string
  parentId: string | null
  type: string
  role: string | null
  /** Byte offset of the line's first byte. */
  start: number
  /** Byte offset just past the line's newline. */
  end: number
  /** A user line that carries an image block; kept from the scan so the summary needs no re-read. */
  hasImages?: boolean
  /** A `pig.pasted-text` custom row: the attachment metadata of the user message that follows. */
  pastedText?: boolean
  /** A `custom_message` that hides itself, so it neither opens a turn nor reaches the projection. */
  hidden?: boolean
}

export interface SessionFileIndex {
  path: string
  sessionId: string
  cwd: string
  version: number
  size: number
  /** Every entry line in file order, including the entries of abandoned branches. */
  entries: SessionFileEntry[]
  byId: Map<string, SessionFileEntry>
  /** The current branch, root first. */
  branch: SessionFileEntry[]
  /** Positions in `branch` where a user message opens a turn. */
  turnStarts: number[]
  /** The last entry in the file, which the SDK treats as the current leaf. */
  leafId: string | null
}

export interface SessionHeader {
  sessionId: string
  cwd: string
  version: number
}

/** A file this reader must not interpret; the caller falls back to the SDK. */
export class UnsupportedSessionFile extends Error {
  constructor(path: string, reason: string) {
    super(`Unsupported session file: ${path} (${reason})`)
    this.name = 'UnsupportedSessionFile'
  }
}

function readAt(path: string, start: number, end: number): Buffer {
  const length = Math.max(0, end - start)
  const buffer = Buffer.allocUnsafe(length)
  if (length === 0) return buffer
  const fd = openSync(path, 'r')
  try {
    let read = 0
    while (read < length) {
      const bytes = readSync(fd, buffer, read, length - read, start + read)
      if (bytes === 0) break
      read += bytes
    }
    return read === length ? buffer : buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

/** The first line that parses as a session header, mirroring the SDK's bounded header scan. */
export function readSessionHeader(path: string): SessionHeader {
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    throw new UnsupportedSessionFile(path, 'not readable')
  }
  const scanned = readAt(path, 0, Math.min(size, HEADER_SCAN_LIMIT))
  for (const line of scanned.toString('utf8').split('\n')) {
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const candidate = parsed as { type?: unknown; id?: unknown; cwd?: unknown; version?: unknown }
    if (candidate.type !== 'session' || typeof candidate.id !== 'string' || candidate.id === '') continue
    return {
      sessionId: candidate.id,
      cwd: typeof candidate.cwd === 'string' ? candidate.cwd : '',
      version: typeof candidate.version === 'number' ? candidate.version : 1
    }
  }
  throw new UnsupportedSessionFile(path, 'no session header')
}

export interface ProbedRow {
  id: string
  parentId: string | null
  type: string
  role: string | null
}

function stringAt(line: Buffer, at: number): string | null {
  if (line[at] !== 0x22) return null
  const end = line.indexOf(0x22, at + 1)
  if (end < 0) return null
  const raw = line.subarray(at + 1, end)
  if (raw.length === 0 || raw.includes(0x5c)) return null
  return raw.toString('utf8')
}

/** The value of the key whose closing quote ends at `afterKey`; undefined when the shape differs. */
function valueAfterKey(line: Buffer, afterKey: number): string | null | undefined {
  if (line[afterKey] !== 0x3a) return undefined
  if (line[afterKey + 1] === 0x6e) return null
  return stringAt(line, afterKey + 1) ?? undefined
}

/**
 * The fields a line exposes without parsing its payload, or null when the shape is not the one this
 * reader knows: `custom`/`custom_message` carry their payload before `id`/`parentId`, so nested
 * `"parentId"` text inside that payload must not be mistaken for the real key.
 *
 * Exported for tests: this coupling to the SDK's key order is the reader's main assumption.
 */
export function probeSessionRow(line: Buffer): ProbedRow | null {
  if (line.length < 10 || line.indexOf(TYPE_PREFIX) !== 0) return null
  if (line[line.length - 1] !== 0x7d) return null
  const type = valueAfterKey(line, TYPE_PREFIX.length)
  if (typeof type !== 'string' || type === 'session') return null

  const parentAt = PAYLOAD_FIRST.has(type) ? line.lastIndexOf(KEY_PARENT) : line.indexOf(KEY_PARENT)
  if (parentAt < 0) return null
  const idAt = line.lastIndexOf(KEY_ID, parentAt)
  if (idAt < 0) return null
  const id = valueAfterKey(line, idAt + KEY_ID.length)
  if (typeof id !== 'string') return null
  const parentId = valueAfterKey(line, parentAt + KEY_PARENT.length)
  if (parentId === undefined) return null

  let role: string | null = null
  if (type === 'message') {
    const roleAt = line.indexOf(KEY_ROLE)
    if (roleAt < 0 || roleAt > ROLE_PROBE_LIMIT) return null
    role = valueAfterKey(line, roleAt + KEY_ROLE.length) ?? null
    if (role === null) return null
  }
  return { id, parentId, type, role }
}

function rowOf(line: Buffer, start: number, end: number): SessionFileEntry | null {
  const probed = probeSessionRow(line)
  if (probed) {
    return { ...probed, start, end, ...rowFlags(line, probed.type, probed.role) }
  }
  const parsed = parseRow(line, start, end)
  return parsed && parsed.type !== 'session' ? parsed : null
}

/** The two payload facts the scan keeps so no later pass has to read a line again. */
function rowFlags(line: Buffer, type: string, role: string | null): Partial<SessionFileEntry> {
  const flags: Partial<SessionFileEntry> = {}
  if (type === 'custom' && line.includes(PASTED_TEXT_MARKER)) flags.pastedText = true
  if (type === 'message' && role === 'user' && line.includes(IMAGE_BLOCK)) flags.hasImages = true
  if (type === 'custom_message' && customMessageHidden(line)) flags.hidden = true
  return flags
}

/**
 * Whether a `custom_message` hides itself (`display: false`). The projection then skips it, so it
 * cannot open a turn either. Its payload has to be read for this: there are only a few per session.
 */
function customMessageHidden(line: Buffer): boolean {
  const parsed = parseSessionEntries(line.toString('utf8'))[0] as { display?: unknown } | undefined
  return parsed?.display === false
}

/** A line the probe refused, read the slow way; null matches the SDK's silently-skipped lines. */
function parseRow(line: Buffer, start: number, end: number): SessionFileEntry | null {
  const parsed = parseSessionEntries(line.toString('utf8')) as SessionEntry[]
  if (parsed.length !== 1) return null
  const entry = parsed[0] as { id?: unknown; parentId?: unknown; type?: unknown; message?: unknown; customType?: unknown }
  if (typeof entry.id !== 'string' || typeof entry.type !== 'string') return null
  const parentId = entry.parentId === null || entry.parentId === undefined ? null : entry.parentId
  if (parentId !== null && typeof parentId !== 'string') return null
  const role = (entry.message as { role?: unknown } | undefined)?.role
  return {
    id: entry.id,
    parentId,
    type: entry.type,
    role: typeof role === 'string' ? role : null,
    start,
    end,
    ...rowFlags(
      line,
      entry.type,
      typeof role === 'string' ? role : null
    ),
    ...(entry.customType === PASTED_TEXT_CUSTOM_TYPE ? { pastedText: true } : {})
  }
}

/** Walk every line in `[from, to)` as bytes, one chunk at a time. */
function scanLines(
  path: string,
  from: number,
  to: number,
  onLine: (line: Buffer, start: number, end: number) => void
): void {
  const fd = openSync(path, 'r')
  const buffer = Buffer.allocUnsafe(Math.min(SCAN_CHUNK, Math.max(4096, to - from)))
  let offset = from
  let pending: Buffer = EMPTY
  let pendingStart = from
  try {
    while (offset < to) {
      const limit = Math.min(buffer.length, to - offset)
      const read = readSync(fd, buffer, 0, limit, offset)
      if (read === 0) break
      let lineStart = 0
      if (pending.length > 0) {
        let newline = buffer.indexOf(0x0a, 0)
        if (newline < 0 || newline >= read) {
          pending = Buffer.concat([pending, buffer.subarray(0, read)])
          offset += read
          continue
        }
        onLine(Buffer.concat([pending, buffer.subarray(0, newline)]), pendingStart, offset + newline + 1)
        lineStart = newline + 1
      }
      let newline = lineStart < read ? buffer.indexOf(0x0a, lineStart) : -1
      while (newline >= 0 && newline < read) {
        onLine(buffer.subarray(lineStart, newline), offset + lineStart, offset + newline + 1)
        lineStart = newline + 1
        newline = lineStart < read ? buffer.indexOf(0x0a, lineStart) : -1
      }
      pending = lineStart < read ? Buffer.from(buffer.subarray(lineStart, read)) : EMPTY
      pendingStart = offset + lineStart
      offset += read
    }
    if (pending.length > 0) onLine(pending, pendingStart, to)
  } finally {
    closeSync(fd)
  }
}

function branchOf(
  byId: Map<string, SessionFileEntry>,
  leafId: string | null
): SessionFileEntry[] {
  const branch: SessionFileEntry[] = []
  const seen = new Set<string>()
  let cursor = leafId
  while (cursor !== null && !seen.has(cursor)) {
    const row = byId.get(cursor)
    if (!row) break
    seen.add(cursor)
    branch.push(row)
    cursor = row.parentId
  }
  return branch.reverse()
}

/**
 * Where turns begin, using the same rule the projection groups by: the run of visible rows before
 * the first user message is a turn of its own, and every user message opens another. Counting only
 * user rows would disagree with the projected turn list and cut the newest turn off a window.
 */
function turnStartsOf(branch: SessionFileEntry[]): number[] {
  const starts: number[] = []
  branch.forEach((row, position) => {
    if (row.hidden === true || isHiddenEntryType(row.type)) return
    if (row.type === 'message' && row.role === 'user') starts.push(position)
    else if (starts.length === 0) starts.push(position)
  })
  return starts
}

/**
 * A `pig.pasted-text` row sits in front of the user message it annotates and is invisible in the
 * projection, so a window that starts at the user row would lose the turn's attachment card.
 */
function pastedTextStart(branch: SessionFileEntry[], from: number): number {
  let start = from
  while (start > 0 && branch[start - 1]?.pastedText) start--
  return start
}

/**
 * The probe proves a line's shape, not that its bytes are valid JSON: a write cut off mid-line can
 * still end with an inner `}` and be indexed as an entry no parser can produce. The tail is cheap to
 * check for real, so the index only ever counts rows a parser agrees with — a file whose tail is
 * unreadable beyond that is handed to the SDK instead of being guessed at.
 */
const TAIL_VERIFY_LIMIT = 8

function trimUnreadableTail(
  path: string,
  entries: SessionFileEntry[],
  byId: Map<string, SessionFileEntry>
): void {
  let attempts = 0
  while (entries.length > 0 && attempts < TAIL_VERIFY_LIMIT) {
    const last = entries[entries.length - 1]!
    if (readRows(path, [last]).length === 1) return
    entries.pop()
    byId.delete(last.id)
    attempts += 1
  }
  if (entries.length === 0 || attempts >= TAIL_VERIFY_LIMIT) {
    throw new UnsupportedSessionFile(path, 'unreadable tail')
  }
}

/** Index a session file; throws `UnsupportedSessionFile` when the file needs the SDK instead. */
export function indexSessionFile(path: string): SessionFileIndex {
  const header = readSessionHeader(path)
  if (header.version < CURRENT_SESSION_VERSION) {
    throw new UnsupportedSessionFile(path, `version ${header.version} needs migration`)
  }
  const size = statSync(path).size
  const entries: SessionFileEntry[] = []
  const byId = new Map<string, SessionFileEntry>()
  let duplicate = false
  scanLines(path, 0, size, (line, start, end) => {
    const row = rowOf(line, start, end)
    if (!row) return
    if (byId.has(row.id)) duplicate = true
    entries.push(row)
    byId.set(row.id, row)
  })
  if (duplicate) throw new UnsupportedSessionFile(path, 'duplicate entry ids')
  trimUnreadableTail(path, entries, byId)
  const dangling = entries.find((row) => row.parentId !== null && !byId.has(row.parentId))
  if (dangling) {
    throw new UnsupportedSessionFile(path, `entry ${dangling.id} has a missing parent`)
  }
  const leafId = entries[entries.length - 1]?.id ?? null
  const branch = branchOf(byId, leafId)
  return {
    path,
    sessionId: header.sessionId,
    cwd: header.cwd,
    version: header.version,
    size,
    entries,
    byId,
    branch,
    turnStarts: turnStartsOf(branch),
    leafId
  }
}

/**
 * The last `minTurns` turns, without indexing the whole file: the tail is scanned for the same
 * fields and the parent chain is walked back inside it, so a branch switch near the end still
 * yields only the current branch.
 *
 * `hasMoreAbove` is true whenever the window does not reach the start of the branch; the caller
 * serves older turns from `indexSessionFile` once it needs them.
 */
export function readTailWindow(
  path: string,
  options: { bytes: number; minTurns: number }
): { entries: SessionEntry[]; leafId: string | null; hasMoreAbove: boolean } {
  const size = statSync(path).size
  let length = Math.min(size, options.bytes)
  for (;;) {
    const start = Math.max(0, size - length)
    const rows: SessionFileEntry[] = []
    const byId = new Map<string, SessionFileEntry>()
    scanLines(path, start, size, (line, lineStart, lineEnd) => {
      const row = rowOf(line, lineStart, lineEnd)
      if (!row) return
      rows.push(row)
      byId.set(row.id, row)
    })
    // A window that starts mid-line loses that line's entry; whatever remains must be one chain.
    const leafId = rows[rows.length - 1]?.id ?? null
    const branch = branchOf(byId, leafId)
    const starts = turnStartsOf(branch)
    const complete = start === 0 || starts.length > options.minTurns
    if (complete || length >= size) {
      // A window that already reaches the start of the file hands back everything it read: the turns
      // are in memory by then, and a wider window saves the caller a page request.
      const wanted = start === 0
        ? 0
        : starts.length > options.minTurns
          ? starts[starts.length - options.minTurns]!
          : starts[0]
      // A window that begins mid-turn would project its partial rows as a turn of their own; a scan
      // that found no boundary at all hands back an empty window and lets the index answer instead.
      const from = wanted == null ? branch.length : pastedTextStart(branch, wanted)
      return { entries: readRows(path, branch.slice(from)), leafId, hasMoreAbove: from > 0 }
    }
    length = Math.min(size, length * 2)
  }
}

/**
 * Where an append lands: the id of the last line that reads as an entry, and whether the file already
 * ends on a line break. Lines the readers skip are walked over, blank or truncated alike, because both
 * this index and the SDK hang the branch off the last line they can parse: landing there agrees with
 * whatever either reader rebuilds, while a root of its own would hide the session behind a second one.
 * Only a file whose every line is unreadable has nowhere to land.
 */
function appendTarget(path: string): { parentId: string | null; terminated: boolean } | null {
  const size = statSync(path).size
  if (size === 0) return null
  let length = Math.min(size, LAST_LINE_BYTES)
  for (;;) {
    const start = Math.max(0, size - length)
    const chunk = readAt(path, start, size)
    const terminated = chunk[chunk.length - 1] === NEWLINE
    let end = chunk.length
    for (;;) {
      while (end > 0 && chunk[end - 1] === NEWLINE) end -= 1
      if (end === 0) break
      const from = chunk.lastIndexOf(NEWLINE, end - 1) + 1
      const line = chunk.subarray(from, end)
      const row = probeSessionRow(line) ?? parseRow(line, 0, line.length)
      // A file without entries yet ends on its header, which no entry hangs from.
      if (row) return { parentId: row.type === 'session' ? null : row.id, terminated }
      // A line that starts before the window may only be unreadable because it is cut off here.
      if (from === 0) break
      end = from - 1
    }
    if (start === 0) throw new UnsupportedSessionFile(path, 'no readable line')
    length *= 2
  }
}

/**
 * Appends one entry line for a session no manager holds. The entry hangs from the last readable
 * entry the file holds so the tree the SDK rebuilds later keeps its single root, and it lands at the
 * end of the file, which leaves every byte offset the index recorded above it intact. The id,
 * parentId and timestamp are filled in here so every writer keeps the SDK's field order.
 */
function appendEntryLine(path: string, entry: { type: string; [key: string]: unknown }): void {
  const target = appendTarget(path)
  const { type, ...rest } = entry
  const line = {
    type,
    id: randomUUID().slice(0, 8),
    parentId: target?.parentId ?? null,
    timestamp: new Date().toISOString(),
    ...rest
  }
  appendFileSync(path, `${target === null || target.terminated ? '' : '\n'}${JSON.stringify(line)}\n`)
}

/**
 * Appends the SDK's `session_info` line, for a session no manager holds.
 */
export function appendSessionInfo(path: string, name: string): void {
  appendEntryLine(path, { type: 'session_info', name })
}

/**
 * Appends the SDK's `label` line, for a session no manager holds. An empty label clears the mark,
 * exactly like the SDK resolves it.
 */
export function appendLabelChange(path: string, targetId: string, label: string): void {
  appendEntryLine(path, { type: 'label', targetId, label })
}

/**
 * One row per turn for the minimap, from what the index scan already recorded: a turn's weight is
 * its opening line's byte size, and an image turn is the heavy one worth a full bar.
 */
export function turnSummaries(index: SessionFileIndex): TurnSummary[] {
  return index.turnStarts.map((at) => {
    const row = index.branch[at]!
    const hasImages = row.hasImages === true
    return {
      id: row.id,
      // The line without its newline, which is what the live source measures from the entry itself.
      bytes: hasImages ? SUMMARY_BYTES_CAP : Math.min(Math.max(0, row.end - row.start - 1), SUMMARY_BYTES_CAP),
      hasImages
    }
  })
}

/** Read the given rows, coalescing lines that sit next to each other in the file. */
export function readRows(path: string, rows: SessionFileEntry[]): SessionEntry[] {
  const entries: SessionEntry[] = []
  let runStart = -1
  let runEnd = -1
  const flush = () => {
    if (runStart < 0) return
    entries.push(...(parseSessionEntries(readAt(path, runStart, runEnd).toString('utf8')) as SessionEntry[]))
    runStart = -1
    runEnd = -1
  }
  for (const row of rows) {
    if (runStart < 0 || row.start !== runEnd) {
      flush()
      runStart = row.start
    }
    runEnd = row.end
  }
  flush()
  return entries
}

/**
 * The same read for rows the index claims to be entries: a row that parses to nothing (or to more
 * than one entry) means the byte index and the file disagree, and every count derived from the index
 * would be wrong. The caller falls back to the SDK instead of serving those counts.
 */
export function readRowsStrict(path: string, rows: SessionFileEntry[]): SessionEntry[] {
  const entries = readRows(path, rows)
  if (entries.length !== rows.length) {
    throw new UnsupportedSessionFile(path, 'index disagrees with the file')
  }
  return entries
}

export function turnCount(index: SessionFileIndex): number {
  return index.turnStarts.length
}

/** The rows of turns `[from, to)`, plus the leading userless group when `from` is 0. */
export function turnWindowRows(
  index: SessionFileIndex,
  from: number,
  to: number
): SessionFileEntry[] {
  const total = index.turnStarts.length
  const last = to >= total ? index.branch.length : index.turnStarts[to] ?? index.branch.length
  const first = from <= 0
    ? 0
    : pastedTextStart(index.branch, index.turnStarts[from] ?? index.branch.length)
  return index.branch.slice(first, Math.max(first, last))
}

/** The rows of the turn `turnId` belongs to; `null` when the branch has no such entry. */
export function turnRowsOf(index: SessionFileIndex, turnId: string): SessionFileEntry[] | null {
  const at = index.branch.findIndex((row) => row.id === turnId)
  if (at < 0) return null
  const next = index.turnStarts.find((turnStart) => turnStart > at) ?? index.branch.length
  let position = 0
  for (const turnStart of index.turnStarts) {
    if (turnStart > at) break
    position = turnStart
  }
  return index.branch.slice(pastedTextStart(index.branch, position), next)
}

export function readTurnEntries(index: SessionFileIndex, from: number, to: number): SessionEntry[] {
  return readRowsStrict(index.path, turnWindowRows(index, from, to))
}

/** One entry by id, parsed on demand: what a `pig-image` URL needs and nothing more. */
export function readEntryById(index: SessionFileIndex, entryId: string): SessionEntry | undefined {
  const row = index.byId.get(entryId)
  if (!row) return undefined
  return readRowsStrict(index.path, [row])[0]
}

export function readBranchEntries(index: SessionFileIndex, rows = index.branch): SessionEntry[] {
  return readRowsStrict(index.path, rows)
}

export function readAllEntries(index: SessionFileIndex, rows = index.entries): SessionEntry[] {
  return readRowsStrict(index.path, rows)
}

function stringAfter(line: Buffer, key: Buffer): string | null {
  const at = line.indexOf(key)
  return at < 0 ? null : stringAt(line, at + key.length - 1)
}

/** A tool result the tree only needs as the call it answers: its output is never parsed. */
function toolResultStub(line: Buffer, row: SessionFileEntry): SessionEntry | null {
  const timestamp = stringAfter(line, TIMESTAMP_KEY)
  const toolCallId = stringAfter(line, TOOL_CALL_ID_KEY)
  const toolName = stringAfter(line, TOOL_NAME_KEY)
  if (!timestamp || !toolCallId || !toolName) return null
  return {
    type: 'message',
    id: row.id,
    parentId: row.parentId,
    timestamp,
    message: {
      role: 'toolResult',
      toolCallId,
      toolName,
      content: [],
      isError: false,
      timestamp: Date.parse(timestamp) || 0
    }
  }
}

/** A compaction the tree labels with its token count, without reading the summary behind it. */
function compactionStub(line: Buffer, row: SessionFileEntry): SessionEntry | null {
  const timestamp = stringAfter(line, TIMESTAMP_KEY)
  const at = line.indexOf(TOKENS_BEFORE_KEY)
  if (!timestamp || at < 0) return null
  const rest = line.subarray(at + TOKENS_BEFORE_KEY.length)
  let digits = 0
  while (digits < rest.length && rest[digits]! >= 0x30 && rest[digits]! <= 0x39) digits += 1
  if (digits === 0) return null
  return {
    type: 'compaction',
    id: row.id,
    parentId: row.parentId,
    timestamp,
    summary: '',
    firstKeptEntryId: '',
    tokensBefore: Number(rest.subarray(0, digits).toString('ascii'))
  }
}

function rowStub(line: Buffer, row: SessionFileEntry): SessionEntry | null {
  if (row.type === 'message' && row.role === 'toolResult') return toolResultStub(line, row)
  if (row.type === 'compaction') return compactionStub(line, row)
  return null
}

/**
 * Rows for the session tree. Tool results and compactions are reduced to the fields their label
 * needs, so the multi-megabyte payloads of a long session never reach the parser; the lines are read
 * in runs like `readRows`, and anything that does not look exactly like the shape this reader knows
 * is parsed the slow way instead.
 */
export function readTreeEntries(index: SessionFileIndex, rows = index.entries): SessionEntry[] {
  const entries: SessionEntry[] = []
  let runStart = -1
  let runEnd = -1
  let runRows: SessionFileEntry[] = []
  const flush = () => {
    if (runStart < 0) return
    const buffer = readAt(index.path, runStart, runEnd)
    for (const row of runRows) {
      const line = buffer.subarray(row.start - runStart, row.end - runStart)
      const stub = rowStub(line, row)
      if (stub) {
        entries.push(stub)
        continue
      }
      const parsed = parseSessionEntries(line.toString('utf8')) as SessionEntry[]
      if (parsed.length !== 1) {
        throw new UnsupportedSessionFile(index.path, 'index disagrees with the file')
      }
      entries.push(parsed[0]!)
    }
    runStart = -1
    runEnd = -1
    runRows = []
  }
  for (const row of rows) {
    if (runStart < 0 || row.start !== runEnd) {
      flush()
      runStart = row.start
    }
    runEnd = row.end
    runRows.push(row)
  }
  flush()
  return entries
}
