/** Bounded monthly JSONL telemetry store and audit-keep cooldown state under $PIG_DIR/memory-telemetry/. */
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync,
  readdirSync, readFileSync, readSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { memoryTelemetryPath } from '../paths'
import { sanitizeTelemetryQuery } from './sanitize'
import type {
  AuditKeepKind, AuditKeptEntry, AuditStateFile, AuditStructureSubkind,
  MemoryTelemetryGap, MemoryTelemetryOp, MemoryTelemetryOutcome,
  MemoryTelemetryRow, MemoryTelemetryWindow
} from './types'

export const MAX_TELEMETRY_OPS_PER_ROW = 32
export const MAX_TELEMETRY_ROW_BYTES = 8192
export const TELEMETRY_WINDOW_DAYS = 90
export const TELEMETRY_RETENTION_MONTHS = 6
export const TELEMETRY_SHARD_BUDGET_BYTES = 8 * 1024 * 1024
export const AUDIT_COOLDOWN_DAYS = 60
export const AUDIT_COOLDOWN_MS = AUDIT_COOLDOWN_DAYS * 86_400_000
export const MAX_AUDIT_KEPT = 1000
const MAX_AUDIT_STATE_BYTES = 4 * 1024 * 1024
const MAX_PENDING_TELEMETRY_APPENDS = 64
const READ_EXISTING_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const SHARD_NAME_RE = /^(\d{4})-(\d{2})\.jsonl$/
const HEX_64_RE = /^[a-f0-9]{64}$/
const DAY_MS = 86_400_000

const rootQueues = new Map<string, Promise<void>>()
let pendingAppends = 0
// A full queue or unavailable writer cannot reliably write its own loss marker.
// Keep the latest gap per root in this process without creating a second store.
const lastDroppedAppendAt = new Map<string, number>()

function recordDroppedAppend(root: string, at: number): false {
  const key = resolve(root)
  lastDroppedAppendAt.set(key, Math.max(lastDroppedAppendAt.get(key) ?? 0, at))
  return false
}

function enqueueRoot<T>(root: string, task: () => Promise<T>): Promise<T> {
  const previous = rootQueues.get(root) ?? Promise.resolve()
  const next = previous.then(task, task)
  const settled = next.then(() => undefined, () => undefined)
  rootQueues.set(root, settled)
  void settled.finally(() => {
    if (rootQueues.get(root) === settled) rootQueues.delete(root)
  })
  return next
}

export function utcMonthKey(at: number): string {
  return new Date(at).toISOString().slice(0, 7)
}

function monthParts(key: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(key)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(month) || month < 1 || month > 12) return null
  return { year, month }
}

function monthIndex(year: number, month: number): number {
  return year * 12 + (month - 1)
}

function monthKeyFromIndex(index: number): string {
  const year = Math.floor(index / 12)
  const month = (index % 12) + 1
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`
}

function monthBoundsMs(key: string): { start: number; end: number } {
  const parts = monthParts(key)!
  const start = Date.UTC(parts.year, parts.month - 1, 1, 0, 0, 0, 0)
  const end = Date.UTC(parts.year, parts.month, 1, 0, 0, 0, 0)
  return { start, end }
}

export function windowMonthKeys(windowStartAt: number, windowEndAt: number): string[] {
  const start = new Date(windowStartAt)
  const end = new Date(windowEndAt)
  const from = monthIndex(start.getUTCFullYear(), start.getUTCMonth() + 1)
  const to = monthIndex(end.getUTCFullYear(), end.getUTCMonth() + 1)
  const keys: string[] = []
  for (let cursor = from; cursor <= to; cursor++) keys.push(monthKeyFromIndex(cursor))
  return keys
}

function assertSafeDirectory(dir: string, create: boolean): boolean {
  const absolute = resolve(dir)
  const parts = absolute.split(sep).filter(Boolean)
  let cursor = absolute.startsWith(sep) ? sep : parts.shift()! + sep
  for (let index = 0; index < parts.length; index++) {
    cursor = join(cursor, parts[index]!)
    const isTarget = index === parts.length - 1
    try {
      const info = lstatSync(cursor)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Telemetry directory cannot be a symbolic link or file')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (!create) return false
      mkdirSync(cursor, { mode: isTarget ? 0o700 : 0o755 })
    }
  }
  return true
}

function acquireTelemetryLeaseSync(root: string): () => void {
  assertSafeDirectory(root, true)
  const lock = join(root, '.writer')
  try { mkdirSync(lock, { mode: 0o700 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const recovery = join(root, '.writer-recovery')
    try { mkdirSync(recovery, { mode: 0o700 }) } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === 'EEXIST') throw Object.assign(new Error('Telemetry writer busy'), { code: 'EBUSY' })
      throw failure
    }
    try {
      if (lstatSync(lock).isSymbolicLink()) throw new Error('Invalid telemetry writer lease')
      const pidPath = join(lock, 'pid')
      const fd = openSync(pidPath, READ_EXISTING_FLAGS)
      let owner: number
      try {
        const info = fstatSync(fd)
        if (!info.isFile() || info.nlink !== 1 || info.size > 32) throw new Error('Invalid telemetry writer lease')
        owner = Number(readFileSync(fd, 'utf8'))
      } finally { closeSync(fd) }
      if (!Number.isSafeInteger(owner) || owner < 1) throw new Error('Invalid telemetry writer lease')
      try {
        process.kill(owner, 0)
        throw Object.assign(new Error('Telemetry writer busy'), { code: 'EBUSY' })
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== 'ESRCH') throw failure
      }
      rmSync(lock, { recursive: true })
      mkdirSync(lock, { mode: 0o700 })
    } finally {
      rmSync(recovery, { recursive: true, force: true })
    }
  }
  try {
    writeFileSync(join(lock, 'pid'), String(process.pid), { mode: 0o600, flag: 'wx' })
  } catch (error) {
    rmSync(lock, { recursive: true, force: true })
    throw error
  }
  return () => {
    rmSync(lock, { recursive: true, force: true })
  }
}

function withTelemetryLeaseSync<T>(root: string, action: () => T): T {
  const release = acquireTelemetryLeaseSync(root)
  try {
    return action()
  } finally {
    release()
  }
}

function waitWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise(resolveDelay => setTimeout(resolveDelay, ms))
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('DREAM_CANCELLED'))
  return new Promise((resolveDelay, rejectDelay) => {
    const onAbort = () => {
      clearTimeout(timer)
      rejectDelay(signal.reason ?? new Error('DREAM_CANCELLED'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolveDelay()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function withTelemetryLeaseRetry<T>(root: string, action: () => T): Promise<T> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return withTelemetryLeaseSync(root, action)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EBUSY' || attempt === 9) throw error
      await waitWithAbort(5 * (attempt + 1))
    }
  }
  throw new Error('Telemetry writer busy')
}

async function withTelemetryLeaseRetryAsync<T>(
  root: string,
  action: () => Promise<T> | T,
  signal?: AbortSignal
): Promise<T> {
  for (let attempt = 0; attempt < 10; attempt++) {
    signal?.throwIfAborted()
    let release: (() => void) | undefined
    try {
      release = acquireTelemetryLeaseSync(root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EBUSY' || attempt === 9) throw error
      await waitWithAbort(5 * (attempt + 1), signal)
      continue
    }
    try {
      return await action()
    } finally {
      release()
    }
  }
  throw new Error('Telemetry writer busy')
}

function isNonNegInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isGap(value: unknown): value is MemoryTelemetryGap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return isNonNegInt(record.calls) && isNonNegInt(record.errs)
}

const VALID_OUTCOMES = new Set<MemoryTelemetryOutcome>(['completed', 'aborted', 'error', 'steered', 'unknown'])
const VALID_OPS = new Set(['read', 'search', 'list', 'add', 'edit', 'delete'])

function isTelemetryOp(value: unknown): value is MemoryTelemetryOp {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const op = value as Record<string, unknown>
  if (typeof op.op !== 'string' || !VALID_OPS.has(op.op)) return false
  if (op.scope !== 'global' && op.scope !== 'project') return false
  if (op.projectId !== undefined && (op.scope !== 'project' || typeof op.projectId !== 'string' || !HEX_64_RE.test(op.projectId))) return false
  if (typeof op.ok !== 'boolean' || !isGap(op.gap)) return false
  if (op.path !== undefined && (typeof op.path !== 'string' || !op.path)) return false
  if (op.pathOmitted !== undefined && typeof op.pathOmitted !== 'boolean') return false
  if (op.pathOmitted === true && op.path !== undefined) return false
  if (op.from !== undefined && (typeof op.from !== 'string' || !op.from)) return false
  if (op.fromOmitted !== undefined && typeof op.fromOmitted !== 'boolean') return false
  if (op.fromOmitted === true && op.from !== undefined) return false
  if (op.rev !== undefined && (typeof op.rev !== 'string' || !HEX_64_RE.test(op.rev))) return false
  if (op.beforeRev !== undefined && (typeof op.beforeRev !== 'string' || !HEX_64_RE.test(op.beforeRev))) return false
  if (op.afterRev !== undefined && (typeof op.afterRev !== 'string' || !HEX_64_RE.test(op.afterRev))) return false
  if (op.offset !== undefined && !isNonNegInt(op.offset)) return false
  if (op.hits !== undefined && !isNonNegInt(op.hits)) return false
  if (op.count !== undefined && !isNonNegInt(op.count)) return false
  if (op.hasMore !== undefined && typeof op.hasMore !== 'boolean') return false
  if (op.committed !== undefined && typeof op.committed !== 'boolean') return false
  if (op.query !== undefined && (typeof op.query !== 'string' || Buffer.byteLength(op.query, 'utf8') > 120)) return false
  if (op.err !== undefined && typeof op.err !== 'string') return false
  const hasPathOrOmitted = (typeof op.path === 'string' && op.path.length > 0) || op.pathOmitted === true
  if (op.ok) {
    if (op.op === 'read' && (!hasPathOrOmitted || typeof op.rev !== 'string' || !isNonNegInt(op.offset) || typeof op.hasMore !== 'boolean')) return false
    if (op.op === 'search' && (!isNonNegInt(op.hits) || !isNonNegInt(op.offset) || typeof op.hasMore !== 'boolean')) return false
    if (op.op === 'list' && (!isNonNegInt(op.count) || !isNonNegInt(op.offset) || typeof op.hasMore !== 'boolean')) return false
    if (op.op === 'add' && (!hasPathOrOmitted || typeof op.afterRev !== 'string')) return false
    if (op.op === 'edit' && (!hasPathOrOmitted || typeof op.beforeRev !== 'string' || typeof op.afterRev !== 'string')) return false
    if (op.op === 'delete' && (!hasPathOrOmitted || typeof op.beforeRev !== 'string')) return false
  } else if (typeof op.err !== 'string') {
    return false
  }
  return true
}

export function isValidTelemetryRow(value: unknown): value is MemoryTelemetryRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  if (row.v !== 1) return false
  if (typeof row.at !== 'number' || !Number.isFinite(row.at) || row.at < 0) return false
  if (typeof row.sessionId !== 'string' || !row.sessionId || row.sessionId.length > 128) return false
  if (typeof row.turnId !== 'string' || !row.turnId || row.turnId.length > 128) return false
  if (row.anchorEntryId !== undefined && (typeof row.anchorEntryId !== 'string' || !row.anchorEntryId || row.anchorEntryId.length > 128)) return false
  if (row.projectId !== undefined && (typeof row.projectId !== 'string' || !HEX_64_RE.test(row.projectId))) return false
  if (typeof row.outcome !== 'string' || !VALID_OUTCOMES.has(row.outcome as MemoryTelemetryOutcome)) return false
  if (!isGap(row.tail)) return false
  if (row.opsTruncated !== undefined && typeof row.opsTruncated !== 'boolean') return false
  if (!Array.isArray(row.ops) || row.ops.length > 128) return false
  if (row.ops.length === 0 && row.opsTruncated !== true) return false
  return row.ops.every(isTelemetryOp)
}

export function serializeTelemetryRow(row: MemoryTelemetryRow): Buffer {
  const ops = row.ops.slice(0, MAX_TELEMETRY_OPS_PER_ROW)
  let opsTruncated = row.opsTruncated === true || row.ops.length > MAX_TELEMETRY_OPS_PER_ROW
  const build = (): string => JSON.stringify({
    v: 1,
    at: row.at,
    sessionId: row.sessionId,
    turnId: row.turnId,
    ...(row.anchorEntryId !== undefined ? { anchorEntryId: row.anchorEntryId } : {}),
    ...(row.projectId !== undefined ? { projectId: row.projectId } : {}),
    outcome: row.outcome,
    ops,
    tail: row.tail,
    ...(opsTruncated ? { opsTruncated: true } : {})
  }) + '\n'
  let serialized = build()
  while (Buffer.byteLength(serialized, 'utf8') > MAX_TELEMETRY_ROW_BYTES && ops.length > 0) {
    ops.pop()
    opsTruncated = true
    serialized = build()
  }
  return Buffer.from(serialized, 'utf8')
}

function appendShardWithLease(root: string, row: MemoryTelemetryRow, now: number): void {
  const month = utcMonthKey(row.at)
  const fileName = `${month}.jsonl`
  const filePath = join(root, fileName)
  const payload = serializeTelemetryRow(row)
  const fd = openSync(filePath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.nlink !== 1) throw new Error('Invalid telemetry shard file')
    let size = info.size
    if (size > 0) {
      const last = Buffer.allocUnsafe(1)
      if (readSync(fd, last, 0, 1, size - 1) !== 1) throw new Error('Unable to read telemetry shard tail')
      // Delimit, don't truncate: the bounded reader recovers a complete row or reports a corrupt line.
      if (last[0] !== 0x0a) {
        writeSyncAll(fd, Buffer.from('\n'), size)
        size += 1
      }
    }
    writeSyncAll(fd, payload, size)
  } finally {
    closeSync(fd)
  }

  // Prune shards strictly older than the 6-month UTC retention window (including current month).
  const ref = new Date(Math.max(now, row.at))
  const cutoff = monthIndex(ref.getUTCFullYear(), ref.getUTCMonth() + 1) - (TELEMETRY_RETENTION_MONTHS - 1)
  for (const name of readdirSync(root)) {
    if (name === fileName) continue
    const match = SHARD_NAME_RE.exec(name)
    if (!match) continue
    const year = Number(match[1])
    const mon = Number(match[2])
    if (mon < 1 || mon > 12) continue
    if (monthIndex(year, mon) >= cutoff) continue
    const oldPath = join(root, name)
    try {
      const stat = lstatSync(oldPath)
      if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) unlinkSync(oldPath)
    } catch {
      // Retention cleanup is best-effort and must not fail the append.
    }
  }
}

function writeSyncAll(fd: number, data: Buffer, offset: number): void {
  let written = 0
  while (written < data.length) {
    written += writeSync(fd, data, written, data.length - written, offset + written)
  }
}

export function appendTelemetryRowSync(row: MemoryTelemetryRow, options: { root?: string; now?: number } = {}): boolean {
  const root = options.root ?? memoryTelemetryPath()
  const now = options.now ?? Date.now()
  try {
    withTelemetryLeaseSync(root, () => appendShardWithLease(root, row, now))
    return true
  } catch {
    return recordDroppedAppend(root, row.at)
  }
}

export async function appendTelemetryRow(row: MemoryTelemetryRow, options: { root?: string; now?: number } = {}): Promise<boolean> {
  const root = options.root ?? memoryTelemetryPath()
  if (pendingAppends >= MAX_PENDING_TELEMETRY_APPENDS) return recordDroppedAppend(root, row.at)
  const now = options.now ?? Date.now()
  pendingAppends++
  return enqueueRoot(root, async () => {
    try {
      await withTelemetryLeaseRetry(root, () => appendShardWithLease(root, row, now))
      return true
    } catch {
      return recordDroppedAppend(root, row.at)
    } finally {
      pendingAppends--
    }
  })
}

export function readTelemetryWindow(options: {
  now?: number
  windowDays?: number
  root?: string
  shardBudgetBytes?: number
} = {}): MemoryTelemetryWindow {
  const now = options.now ?? Date.now()
  const windowDays = options.windowDays ?? TELEMETRY_WINDOW_DAYS
  const windowStartAt = now - windowDays * DAY_MS
  const root = options.root ?? memoryTelemetryPath()
  const shardBudget = options.shardBudgetBytes ?? TELEMETRY_SHARD_BUDGET_BYTES
  const months = windowMonthKeys(windowStartAt, now)

  const rows: MemoryTelemetryRow[] = []
  const incompleteReasons = new Set<string>()
  const truncatedShards: string[] = []
  const missingShards: string[] = []
  const corruptShards: string[] = []
  const unreadableShards: string[] = []
  let skippedLines = 0
  let truncatedRows = 0
  let observedStartAt: number | undefined
  let observedEndAt: number | undefined
  let unreliableBefore = 0
  const droppedAt = lastDroppedAppendAt.get(resolve(root))
  if (droppedAt !== undefined && droppedAt >= windowStartAt) {
    incompleteReasons.add('dropped_appends')
    unreliableBefore = Math.floor(droppedAt) + 1
  }

  let dirPresent = false
  try {
    dirPresent = assertSafeDirectory(root, false)
  } catch {
    incompleteReasons.add('unreadable_telemetry')
    return {
      rows: [],
      coverage: {
        windowDays, windowStartAt, windowEndAt: now, totalRows: 0, totalTurns: 0, truncatedRows: 0,
        complete: false, incompleteReasons: [...incompleteReasons], skippedLines: 0,
        truncatedShards, missingShards, corruptShards, unreadableShards
      }
    }
  }

  if (!dirPresent) {
    incompleteReasons.add('no_telemetry')
    return {
      rows: [],
      coverage: {
        windowDays, windowStartAt, windowEndAt: now, totalRows: 0, totalTurns: 0, truncatedRows: 0,
        complete: false, incompleteReasons: [...incompleteReasons], skippedLines: 0,
        truncatedShards, missingShards: months, corruptShards, unreadableShards
      }
    }
  }

  for (const month of months) {
    const { end: monthEnd } = monthBoundsMs(month)
    const shardPath = join(root, `${month}.jsonl`)
    let fd: number
    try {
      fd = openSync(shardPath, READ_EXISTING_FLAGS)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        missingShards.push(month)
        // Missing months are observation gaps, never zero usage; reliable coverage cannot precede them.
        unreliableBefore = Math.max(unreliableBefore, monthEnd)
        continue
      }
      unreadableShards.push(month)
      incompleteReasons.add('unreadable_shard')
      unreliableBefore = Math.max(unreliableBefore, monthEnd)
      continue
    }

    try {
      const info = fstatSync(fd)
      if (!info.isFile() || info.nlink !== 1) {
        unreadableShards.push(month)
        incompleteReasons.add('unreadable_shard')
        unreliableBefore = Math.max(unreliableBefore, monthEnd)
        continue
      }
      const size = info.size
      if (size === 0) continue

      const readStart = Math.max(0, size - shardBudget)
      const budgetTruncated = readStart > 0
      const length = size - readStart
      const buf = Buffer.allocUnsafe(length)
      let offset = 0
      while (offset < length) {
        const n = readSync(fd, buf, offset, length - offset, readStart + offset)
        if (n === 0) break
        offset += n
      }
      let slice = buf.subarray(0, offset)
      if (budgetTruncated) {
        truncatedShards.push(month)
        incompleteReasons.add('truncated_shard')
        const firstNewline = slice.indexOf(0x0a)
        if (firstNewline < 0) {
          skippedLines++
          unreliableBefore = Math.max(unreliableBefore, monthEnd)
          continue
        }
        slice = slice.subarray(firstNewline + 1)
      }

      if (slice.length > 0 && slice[slice.length - 1] !== 0x0a) {
        const lastNewline = slice.lastIndexOf(0x0a)
        skippedLines++
        corruptShards.push(month)
        incompleteReasons.add('corrupt_lines')
        unreliableBefore = Math.max(unreliableBefore, monthEnd)
        slice = lastNewline >= 0 ? slice.subarray(0, lastNewline + 1) : Buffer.alloc(0)
      }

      let shardHasBadLine = false
      let firstKeptAt: number | undefined
      let cursor = 0
      while (cursor < slice.length) {
        const nl = slice.indexOf(0x0a, cursor)
        const lineEnd = nl >= 0 ? nl : slice.length
        const lineBytes = slice.subarray(cursor, lineEnd)
        cursor = lineEnd + 1
        if (lineBytes.length === 0) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(lineBytes))
        } catch {
          skippedLines++
          shardHasBadLine = true
          continue
        }
        if (!isValidTelemetryRow(parsed)) {
          skippedLines++
          shardHasBadLine = true
          continue
        }
        if (firstKeptAt === undefined || parsed.at < firstKeptAt) firstKeptAt = parsed.at
        if (observedStartAt === undefined || parsed.at < observedStartAt) observedStartAt = parsed.at
        if (observedEndAt === undefined || parsed.at > observedEndAt) observedEndAt = parsed.at
        if (parsed.at >= windowStartAt && parsed.at <= now) {
          // Apply the current query policy to older shards before exposing them to Dream.
          for (const op of parsed.ops) {
            if (op.query !== undefined) {
              const safe = sanitizeTelemetryQuery(op.query)
              if (safe === undefined) delete op.query
              else op.query = safe
            }
          }
          rows.push(parsed)
          if (parsed.opsTruncated === true) {
            truncatedRows++
            incompleteReasons.add('truncated_rows')
            // Dropped tail ops may have read any note; negative inference cannot span across a truncated turn.
            unreliableBefore = Math.max(unreliableBefore, parsed.at + 1)
          }
        }
      }

      if (shardHasBadLine) {
        if (!corruptShards.includes(month)) corruptShards.push(month)
        incompleteReasons.add('corrupt_lines')
        unreliableBefore = Math.max(unreliableBefore, monthEnd)
      } else if (budgetTruncated) {
        unreliableBefore = Math.max(unreliableBefore, firstKeptAt ?? monthEnd)
      }
    } finally {
      closeSync(fd)
    }
  }

  if (observedStartAt === undefined) {
    incompleteReasons.add('no_telemetry')
  } else if (missingShards.length > 0) {
    if (missingShards.some(month => monthBoundsMs(month).end > observedStartAt!)) {
      incompleteReasons.add('missing_shards')
    }
    if (observedStartAt > windowStartAt) {
      incompleteReasons.add('partial_window')
    }
  }

  const reliableStartAt = observedStartAt !== undefined
    ? Math.max(windowStartAt, observedStartAt, unreliableBefore)
    : undefined

  const turns = new Set(rows.map(row => `${row.sessionId}\0${row.turnId}\0${row.anchorEntryId ?? ''}`))

  return {
    rows,
    coverage: {
      windowDays,
      windowStartAt,
      windowEndAt: now,
      observedStartAt,
      observedEndAt,
      reliableStartAt: reliableStartAt !== undefined && reliableStartAt <= now ? reliableStartAt : undefined,
      totalRows: rows.length,
      totalTurns: turns.size,
      truncatedRows,
      complete: incompleteReasons.size === 0 && rows.length > 0,
      incompleteReasons: [...incompleteReasons],
      skippedLines,
      truncatedShards,
      missingShards,
      corruptShards,
      unreadableShards
    }
  }
}

const VALID_KEEP_KINDS = new Set<AuditKeepKind>(['poisoned', 'high_churn', 'structure', 'clickbait', 'stale'])
const VALID_STRUCTURE_SUBKINDS = new Set<AuditStructureSubkind>(['broken_link', 'orphan'])

function isValidKeptEntry(value: unknown): value is AuditKeptEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  if (entry.scope !== 'global' && entry.scope !== 'project') return false
  if (entry.scope === 'project') {
    if (typeof entry.projectId !== 'string' || !HEX_64_RE.test(entry.projectId)) return false
  } else if (entry.projectId !== undefined) {
    return false
  }
  if (typeof entry.path !== 'string' || !entry.path) return false
  if (typeof entry.rev !== 'string' || !HEX_64_RE.test(entry.rev)) return false
  if (typeof entry.kind !== 'string' || !VALID_KEEP_KINDS.has(entry.kind as AuditKeepKind)) return false
  if (entry.subkind !== undefined) {
    if (entry.kind !== 'structure' || typeof entry.subkind !== 'string' || !VALID_STRUCTURE_SUBKINDS.has(entry.subkind as AuditStructureSubkind)) {
      return false
    }
  }
  if (entry.defectKey !== undefined) {
    if (entry.kind !== 'structure' || entry.subkind === undefined || typeof entry.defectKey !== 'string' || !HEX_64_RE.test(entry.defectKey)) {
      return false
    }
  }
  if (entry.from !== undefined || entry.fromRev !== undefined) {
    if (entry.kind !== 'clickbait' || typeof entry.from !== 'string' || !entry.from || typeof entry.fromRev !== 'string' || !HEX_64_RE.test(entry.fromRev)) return false
  }
  if (typeof entry.checkedAt !== 'number' || !Number.isFinite(entry.checkedAt) || entry.checkedAt < 0) return false
  if (typeof entry.signalThrough !== 'number' || !Number.isFinite(entry.signalThrough) || entry.signalThrough < 0) return false
  return true
}

const AUDIT_STATE_ERR = () => new Error('DREAM_AUDIT_STATE: Unable to read or persist audit cooldown state')

export function readAuditState(root = memoryTelemetryPath()): AuditStateFile {
  try {
    if (!assertSafeDirectory(root, false)) return { v: 1, kept: [] }
  } catch {
    throw AUDIT_STATE_ERR()
  }
  const filePath = join(root, 'audit-state.json')
  let fd: number
  try {
    fd = openSync(filePath, READ_EXISTING_FLAGS)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { v: 1, kept: [] }
    throw AUDIT_STATE_ERR()
  }
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_AUDIT_STATE_BYTES) throw AUDIT_STATE_ERR()
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(fd)))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw AUDIT_STATE_ERR()
    const record = parsed as Record<string, unknown>
    if (record.v !== 1 || !Array.isArray(record.kept) || !record.kept.every(isValidKeptEntry)) throw AUDIT_STATE_ERR()
    return { v: 1, kept: record.kept }
  } catch {
    throw AUDIT_STATE_ERR()
  } finally {
    closeSync(fd)
  }
}

export const auditKeepKey = (
  entry: Pick<AuditKeptEntry, 'scope' | 'projectId' | 'path' | 'kind' | 'subkind' | 'from' | 'fromRev'>
): string => JSON.stringify([entry.scope, entry.projectId, entry.path, entry.kind, entry.subkind, entry.from, entry.fromRev])

export interface CommitAuditKeepsOptions {
  root?: string
  now?: number
  signal?: AbortSignal
  check?: () => void
  beforeWrite?: () => Promise<void> | void
  /** Synchronous lock (e.g. MemoryFiles.withCatalogLease) held across final live-revision check and atomic state write. */
  withLiveLock?: <T>(action: () => T) => T
}

function isDreamControlError(error: unknown): boolean {
  return error instanceof Error && /^DREAM_[A-Z_]+/.test(error.message)
}

export async function commitAuditKeeps(
  entries: AuditKeptEntry[],
  verifyLiveRevision: (entry: AuditKeptEntry) => boolean,
  options: CommitAuditKeepsOptions = {}
): Promise<AuditStateFile> {
  const root = options.root ?? memoryTelemetryPath()
  const now = options.now ?? Date.now()
  const withLiveLock = options.withLiveLock ?? (<T>(action: () => T) => action())
  const assertAllowed = () => {
    options.signal?.throwIfAborted()
    options.check?.()
  }
  assertAllowed()
  return enqueueRoot(root, async () => {
    assertAllowed()
    try {
      return await withTelemetryLeaseRetryAsync(root, async () => {
        assertAllowed()
        await options.beforeWrite?.()
        // Lock order is strictly telemetry/.writer -> memory/.writer (no path acquires
        // telemetry/.writer while holding memory/.writer). No awaits occur inside withLiveLock.
        return withLiveLock(() => {
          assertAllowed()
          const current = readAuditState(root)
          const map = new Map<string, AuditKeptEntry>()
          for (const item of current.kept) {
            if (now - item.checkedAt < AUDIT_COOLDOWN_MS) map.set(auditKeepKey(item), item)
          }
          for (const entry of entries) {
            assertAllowed()
            if (!isValidKeptEntry(entry)) continue
            if (!verifyLiveRevision(entry)) continue
            map.set(auditKeepKey(entry), entry)
          }
          const kept = [...map.values()]
            .sort((a, b) => a.checkedAt - b.checkedAt)
            .slice(-MAX_AUDIT_KEPT)
          const next: AuditStateFile = { v: 1, kept }
          // Final synchronous gate right before atomic temp-file write + rename under both leases.
          assertAllowed()
          const filePath = join(root, 'audit-state.json')
          const temp = join(dirname(filePath), `.audit-state-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`)
          try {
            writeFileSync(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' })
            renameSync(temp, filePath)
          } catch {
            rmSync(temp, { force: true })
            throw AUDIT_STATE_ERR()
          }
          return next
        })
      }, options.signal)
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error
      if (isDreamControlError(error)) throw error
      throw AUDIT_STATE_ERR()
    }
  })
}
