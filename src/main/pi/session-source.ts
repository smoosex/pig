/**
 * A read-only view of one session's entries.
 *
 * Live and draft sessions read the SDK manager they already hold. An opened JSONL session reads its
 * file through the byte-level index instead, which is why opening one no longer parses it whole.
 */
import { statSync } from 'node:fs'
import type { SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent'
import {
  indexSessionFile,
  readAllEntries,
  readBranchEntries,
  readEntryById,
  readRows,
  readTailWindow,
  readTreeEntries,
  readTurnEntries,
  turnRowsOf,
  turnSummaries,
  SUMMARY_BYTES_CAP,
  type SessionFileIndex
} from './session-jsonl'
import type { SessionEntry as SdkEntry } from '@earendil-works/pi-coding-agent'
import type { SessionFileSession } from './session-state'
import { displayTurnsFromEntries, turnMessagesFromEntries } from './session-display-model'
import type { DisplayTurn, DisplayTurnsResult, SessionWindowUpdate, TurnSummary } from '../../shared/api'

/** Turns a freshly opened session starts with: the tail is what a reader looks at first. */
export const WINDOW_TURNS = 60

/** The tail read starts from a slice of the file and grows only if it holds too few turns. */
const TAIL_MIN_BYTES = 1024 * 1024
const TAIL_MAX_BYTES = 64 * 1024 * 1024

/**
 * Reading a tail needs no index, so this is all opening pays: the last turns are scanned and parsed
 * while the counts stay provisional. `indexPending` says a follow-up window will correct them, and
 * is only set when turns really do remain above: a tail that reaches the file start is already final.
 */
export function openTail(
  sessionId: string,
  path: string
): { entries: SdkEntry[]; display: DisplayTurnsResult } {
  const size = statSync(path).size
  const bytes = Math.min(TAIL_MAX_BYTES, Math.max(TAIL_MIN_BYTES, Math.ceil(size / 16)))
  const tail = readTailWindow(path, { bytes, minTurns: WINDOW_TURNS })
  const turns = displayTurnsFromEntries(sessionId, tail.entries)
  return {
    entries: tail.entries,
    display: {
      leafId: tail.leafId,
      turns,
      startIndex: 0,
      totalTurns: turns.length,
      indexPending: tail.hasMoreAbove
    }
  }
}

/**
 * The one promise per session that produces the branch index. Opening does not await it; every read
 * that needs the whole branch awaits this instead, which is usually already resolved by then.
 */
export function sessionIndex(session: SessionFileSession): Promise<SessionFileIndex> {
  if (session.index) return Promise.resolve(session.index)
  if (!session.indexing) {
    session.indexing = Promise.resolve()
      .then(() => indexSessionFile(session.path))
      .then((index) => {
        session.index = index
        return index
      })
      // A failed scan is not a permanent verdict: keep the failure visible but let a later read retry.
      .catch((error: unknown) => {
        session.indexing = null
        throw error
      })
  }
  return session.indexing
}

export interface SessionSource {
  sessionId: string
  leafId(): string | null
  /** The entries of the current branch, oldest first. */
  branch(): SessionEntry[]
  /**
   * The ids of the same branch, oldest first. Callers that only need to know which entries are on
   * the current path (the session tree) must not pay for parsing the branch to find out.
   */
  branchIds(): string[]
  /** Every entry in the file, including abandoned branches. */
  entries(): SessionEntry[]
  /** The same rows reduced to what the tree shows: tool outputs and compaction summaries stay on disk. */
  treeEntries(): SessionEntry[]
  entryById(id: string): SessionEntry | undefined
  /** Turns in the branch, without projecting them. */
  turnCount(): number
  /** Projected turns `[from, from + count)` of the branch. */
  turnWindow(from: number, count: number): DisplayTurn[]
  /** One weight per turn, when the source can produce them without reading the conversation. */
  turnSummaries(): TurnSummary[] | undefined
  /** One turn's messages, read without projecting the rest of the branch. */
  turnMessages(turnId: string): unknown[]
}

/**
 * The tail of a branch plus, when the source can afford it, the weights of every turn. A window is
 * complete on its own: it starts at a user message, which is what opens a turn.
 */
export function displayWindow(source: SessionSource): DisplayTurnsResult {
  const totalTurns = source.turnCount()
  const startIndex = Math.max(0, totalTurns - WINDOW_TURNS)
  const summary = source.turnSummaries()
  return {
    leafId: source.leafId(),
    turns: source.turnWindow(startIndex, totalTurns - startIndex),
    startIndex,
    totalTurns,
    ...(summary ? { summary } : {})
  }
}

export function turnWindow(source: SessionSource, start: number, count: number): DisplayTurnsResult {
  const totalTurns = source.turnCount()
  const from = Math.min(Math.max(0, start), totalTurns)
  const size = Math.min(Math.max(0, count), totalTurns - from)
  return {
    leafId: source.leafId(),
    turns: source.turnWindow(from, size),
    startIndex: from,
    totalTurns
  }
}

/**
 * What the branch index adds to the window opening already handed out: how many turns sit above the
 * ones the renderer holds, and how heavy they are. The offset comes from the held window itself, so
 * a tail that already covered the whole file keeps its first turn aligned.
 */
export function windowUpdate(
  source: SessionSource,
  heldTurns: number
): Omit<SessionWindowUpdate, 'sessionId'> {
  const totalTurns = source.turnCount()
  const summary = source.turnSummaries()
  return {
    leafId: source.leafId(),
    startIndex: Math.max(0, Math.min(totalTurns, totalTurns - heldTurns)),
    totalTurns,
    ...(summary ? { summary } : {})
  }
}

/**
 * The minimap weight of a projected turn, measured the way the byte reader measures the same turn:
 * the length of the line the SDK writes for the turn's opening entry. A turn with images is full
 * whatever the images weigh, so both sources agree without either of them reading image bytes.
 */
function summaryOfTurn(turn: DisplayTurn, entry: unknown): TurnSummary {
  const hasImages = (turn.user?.images.length ?? 0) > 0
  const bytes = entry === undefined ? 0 : Buffer.byteLength(JSON.stringify(entry))
  return {
    id: turn.id,
    bytes: hasImages ? SUMMARY_BYTES_CAP : Math.min(bytes, SUMMARY_BYTES_CAP),
    hasImages
  }
}

export function managerSource(sessionManager: SessionManager): SessionSource {
  // One projection per source: counts and content come from the same list, so a window can never
  // disagree with itself about where a turn begins or how many turns the branch has.
  let projection: DisplayTurn[] | null = null
  const turns = () => {
    projection ??= displayTurnsFromEntries(sessionManager.getSessionId(), sessionManager.getBranch())
    return projection
  }
  // A turn's id is the id of the entry that opened it, which is the line the weights are measured on.
  let entriesById: Map<string, unknown> | null = null
  let summaryCache: TurnSummary[] | null = null
  const summaries = (): TurnSummary[] => {
    entriesById ??= new Map(sessionManager.getBranch().map((entry) => [entry.id, entry as unknown]))
    summaryCache ??= turns().map((turn) => summaryOfTurn(turn, entriesById!.get(turn.id)))
    return summaryCache
  }
  return {
    sessionId: sessionManager.getSessionId(),
    leafId: () => sessionManager.getLeafId(),
    branch: () => sessionManager.getBranch(),
    branchIds: () => sessionManager.getBranch().map((entry) => entry.id),
    entries: () => sessionManager.getEntries(),
    treeEntries: () => sessionManager.getEntries(),
    entryById: (id) => sessionManager.getEntry(id),
    turnCount: () => turns().length,
    turnWindow: (from, count) => turns().slice(from, from + count),
    turnSummaries: summaries,
    turnMessages: (turnId) => turnMessagesFromEntries(sessionManager.getBranch(), turnId)
  }
}

export function fileSource(index: SessionFileIndex): SessionSource {
  return {
    sessionId: index.sessionId,
    leafId: () => index.leafId,
    branch: () => readBranchEntries(index),
    branchIds: () => index.branch.map((row) => row.id),
    entries: () => readAllEntries(index),
    treeEntries: () => readTreeEntries(index),
    entryById: (id) => readEntryById(index, id),
    turnCount: () => index.turnStarts.length,
    turnWindow: (from, count) => turnEntries(index, from, count),
    turnSummaries: () => turnSummaries(index),
    // One disclosure reads one turn's lines: the rest of the branch stays on disk.
    turnMessages: (turnId) => {
      const rows = turnRowsOf(index, turnId)
      if (!rows) throw new Error(`Turn not found: ${turnId}`)
      return turnMessagesFromEntries(readRows(index.path, rows), turnId)
    }
  }
}

/** Only the turns asked for are read, so a window costs its own bytes rather than the branch's. */
function turnEntries(index: SessionFileIndex, from: number, count: number): DisplayTurn[] {
  if (count <= 0) return []
  const entries = readTurnEntries(index, from, Math.min(from + count, index.turnStarts.length))
  return displayTurnsFromEntries(index.sessionId, entries)
}
