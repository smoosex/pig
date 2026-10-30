import { relative as relativePath, sep } from 'node:path'
import { within } from '../sandbox/policy'
import { sessionCwd, withSource } from './session-registry'
import { displayWindow, turnWindow, type SessionSource } from './session-source'
import { summarizeSessionFileChanges } from './session-file-changes'
import type { DisplayTurnsResult } from '../../shared/api'
import type { FileChangeSummary, SessionFileChangesSummary, TurnFileChangesResult } from '../../shared/file-change-api'
import type { SessionFileChange, SessionFileChanges } from '../../shared/session-file-changes'

export type { DisplayAnswer, DisplayTurn, DisplayUser, DisplayTurnsResult } from '../../shared/api'

export { displayTurnsFromEntries } from './session-display-model'

/** The tail of the branch, plus the turn weights the minimap needs for the turns it does not hold. */
export async function getDisplayTurns(sessionId: string): Promise<DisplayTurnsResult> {
  return withSource(sessionId, displayWindow)
}

/** Older turns for a reader who scrolled past the loaded window. */
export async function getTurnWindow(
  sessionId: string,
  start: number,
  count: number
): Promise<DisplayTurnsResult> {
  return withSource(sessionId, (source) => turnWindow(source, start, count))
}

/** One turn's process disclosure: read without projecting the rest of the branch. */
export async function getTurnMessages(sessionId: string, turnId: string): Promise<unknown[]> {
  return withSource(sessionId, (source) => source.turnMessages(turnId))
}

/** Recently read sessions only: the oldest falls out, so closed sessions cannot pile up. */
const FILE_CHANGE_CACHE_SIZE = 16
const fileChangeCache = new Map<string, { leafId: string | null; cwd: string; changes: SessionFileChanges }>()

/** The whole branch is aggregated once per leaf: every hover and every turn reads the same result. */
function branchFileChanges(source: SessionSource, cwd: string): { leafId: string | null; changes: SessionFileChanges } {
  const leafId = source.leafId()
  const cached = fileChangeCache.get(source.sessionId)
  if (cached && cached.leafId === leafId && cached.cwd === cwd) return cached
  const next = { leafId, cwd, changes: summarizeSessionFileChanges(source.branch(), cwd) }
  fileChangeCache.delete(source.sessionId)
  fileChangeCache.set(source.sessionId, next)
  if (fileChangeCache.size > FILE_CHANGE_CACHE_SIZE) fileChangeCache.delete(fileChangeCache.keys().next().value!)
  return next
}

function relativeTo(cwd: string, path: string): string | null {
  const relative = relativePath(cwd, path)
  if (!relative || !within(cwd, path)) return null
  return relative.split(sep).join('/')
}

function summarize(cwd: string, file: SessionFileChange): FileChangeSummary {
  const { operations, ...rest } = file
  return { ...rest, relativePath: relativeTo(cwd, file.path), operationCount: operations.length }
}

export async function getSessionFileChanges(sessionId: string): Promise<SessionFileChangesSummary> {
  const cwd = sessionCwd(sessionId)
  return withSource(sessionId, (source) => {
    const { leafId, changes } = branchFileChanges(source, cwd)
    return {
      leafId,
      files: changes.files.map((file) => summarize(cwd, file)),
      turns: Object.fromEntries(Object.entries(changes.turns).map(([turnId, files]) => [turnId, files.map((file) => summarize(cwd, file))]))
    }
  })
}

/** One file's operations in one turn, in the order they were recorded. `path` is the absolute path a summary returned. */
export async function getTurnFileChanges(sessionId: string, turnId: string): Promise<TurnFileChangesResult> {
  const cwd = sessionCwd(sessionId)
  return withSource(sessionId, (source) => {
    const { leafId, changes } = branchFileChanges(source, cwd)
    const files = (changes.turns[turnId] ?? []).map((file) => ({ ...file, relativePath: relativeTo(cwd, file.path) }))
    return { leafId, files }
  })
}
