/** Read-only receipts, separate from Dream's live runtime and private JSONL transcripts. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { arr, bool, compile, num, obj, oneOf, opt, str } from '@earendil-works/pi-schema'
import type { DreamRecord, DreamRecordPage } from '../../../../shared/dream'
import { pigPath } from '../../../pig-dir'

const runId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const nonnegative = num({ minimum: 0 })
const budgetKind = oneOf(['tokens', 'cost'] as const)
const recordSchema = compile(obj({
  id: str({ pattern: runId.source }), topic: opt(str()), repair: opt(bool()),
  state: oneOf(['done', 'limited', 'cancelled', 'error'] as const),
  phase: opt(oneOf(['preparing', 'searching', 'reading', 'maintaining', 'wrappingUp', 'publishing'] as const)),
  wrappingUp: opt(budgetKind), budgetStop: opt(obj({ kind: budgetKind, used: nonnegative, limit: nonnegative })),
  current: opt(str()), report: opt(str()), sessionFile: opt(str()), changes: arr(str()),
  input: nonnegative, cacheRead: opt(nonnegative), cacheWrite: opt(nonnegative), output: nonnegative,
  cost: nonnegative, costKnown: opt(bool()), requests: nonnegative, error: opt(str()),
  startedAt: nonnegative, endedAt: nonnegative
}, { open: true }))
const invalid = () => new Error('DREAM_RECORD: Unable to read the saved Dream record')
function root(): string {
  const path = pigPath('dream')
  try {
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid()
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw invalid() }
  return path
}
export function readDreamRecord(id: string): DreamRecord {
  if (typeof id !== 'string' || !runId.test(id)) throw invalid()
  let fd: number | undefined
  try {
    const directory = join(root(), id)
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid()
    fd = openSync(join(directory, 'result.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
    const file = fstatSync(fd)
    if (!file.isFile() || file.nlink !== 1 || file.size > 2 * 1024 * 1024) throw invalid()
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(fd)))
    if (!recordSchema.check(value) || value.id !== id) throw invalid()
    // Unknown legacy receipt fields are not exposed across IPC.
    const { topic, repair, state, phase, wrappingUp, budgetStop, current, report, changes,
      input, cacheRead, cacheWrite, output, cost, costKnown, requests, error, startedAt, endedAt } = value
    return { id, topic, repair, state, phase, wrappingUp, budgetStop, current, report, changes,
      input, cacheRead: cacheRead ?? 0, cacheWrite: cacheWrite ?? 0, output, cost, costKnown: costKnown ?? false,
      usageIncomplete: cacheRead === undefined || cacheWrite === undefined,
      requests, error, startedAt, endedAt }
  } catch { throw invalid() } finally { if (fd !== undefined) closeSync(fd) }
}
export function listDreamRecords(offset = 0): DreamRecordPage {
  if (!Number.isSafeInteger(offset) || offset < 0) throw invalid()
  const directory = root()
  let entries: string[]
  try { entries = readdirSync(directory, { encoding: 'utf8' }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { items: [] }; throw invalid() }
  const files: { id: string; modified: number }[] = []
  for (const id of entries) {
    if (!runId.test(id)) continue
    try {
      const folder = lstatSync(join(directory, id))
      if (!folder.isDirectory() || folder.isSymbolicLink()) throw invalid()
      const file = lstatSync(join(directory, id, 'result.json'))
      if (!file.isFile() || file.isSymbolicLink()) throw invalid()
      files.push({ id, modified: file.mtimeMs })
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw invalid() }
  }
  files.sort((a, b) => b.modified - a.modified || a.id.localeCompare(b.id))
  const page = files.slice(offset, offset + 30)
  return {
    items: page.map(({ id }) => {
      const { topic, repair, state, startedAt, endedAt } = readDreamRecord(id)
      return { id, topic, repair, state, startedAt, endedAt }
    }),
    nextOffset: offset + page.length < files.length ? offset + page.length : undefined
  }
}
