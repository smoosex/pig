/* Append-only token records for the mood observer, kept apart from mood-state.json so analytics never
 * take the persona lock or touch its revisions. One JSONL file per UTC month; no conversation text. */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  PERSONA_OBSERVER_OUTCOMES, type PersonaObserverOutcome, type PersonaObserverUsageModel,
  type PersonaObserverUsageRange, type PersonaObserverUsageSummary, type PersonaObserverUsageTotals,
} from '../../../shared/persona'
import type { ThinkingLevel } from '../../../shared/api'
import { isMissing, personaDir } from './storage'

export interface ObserverUsageRecord {
  v: 1
  at: number
  sessionId: string
  provider: string
  modelId: string
  inherited: boolean
  thinking: ThinkingLevel
  rounds: { fresh: number; background: number }
  estimatedInput: number
  /** Null when the request was abandoned before the provider reported usage. */
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number } | null
  cost: number | null
  durationMs: number
  outcome: PersonaObserverOutcome
}

const FILE = /^observer-usage-(\d{4})-(\d{2})\.jsonl$/
/** Far above one record; a tail this long without a newline is not a torn append. */
const TAIL_LIMIT = 64 * 1024
const DAY = 86_400_000
const THINKING = new Set<string>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function fileName(at: number): string {
  const date = new Date(at)
  return `observer-usage-${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}.jsonl`
}

export async function appendObserverUsage(record: ObserverUsageRecord): Promise<void> {
  const dir = personaDir()
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  // O_APPEND keeps concurrent single-line writers from main and jiti runtimes from interleaving.
  const file = await fs.open(join(dir, fileName(record.at)), 'a+', 0o600)
  try {
    await dropTornTail(file)
    await file.appendFile(JSON.stringify(record) + '\n', 'utf8')
  } finally {
    await file.close()
  }
}

/** A failed append (e.g. ENOSPC) can leave half a line; the next record must not be glued onto it,
 * or every later summary would fail on one malformed line. Only that unterminated tail is removed. */
async function dropTornTail(file: fs.FileHandle): Promise<void> {
  const { size } = await file.stat()
  if (!size) return
  const length = Math.min(size, TAIL_LIMIT)
  const tail = Buffer.alloc(length)
  await file.read(tail, 0, length, size - length)
  if (tail[length - 1] === 0x0a) return
  const newline = tail.lastIndexOf(0x0a)
  if (newline < 0 && size > TAIL_LIMIT) throw new Error('Mood observer usage file has an oversized unterminated line')
  await file.truncate(size - length + newline + 1)
}

async function usageFiles(): Promise<{ name: string; end: number }[]> {
  let names: string[]
  try { names = await fs.readdir(personaDir()) } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  return names.flatMap(name => {
    const match = FILE.exec(name)
    return match ? [{ name, end: Date.UTC(Number(match[1]), Number(match[2])) }] : []
  })
}

const count = (value: unknown): value is number => Number.isFinite(value) && (value as number) >= 0

function parseRecord(line: string, file: string): ObserverUsageRecord {
  const value = JSON.parse(line) as ObserverUsageRecord
  const usage = value?.usage
  if (value?.v !== 1 || !count(value.at) || typeof value.provider !== 'string' || typeof value.modelId !== 'string'
    || typeof value.inherited !== 'boolean' || !THINKING.has(value.thinking) || !count(value.estimatedInput) || !count(value.durationMs)
    || !PERSONA_OBSERVER_OUTCOMES.includes(value.outcome)
    || (usage !== null && !(count(usage?.input) && count(usage.output) && count(usage.cacheRead) && count(usage.cacheWrite) && count(usage.reasoning)))
    || (value.cost !== null && !count(value.cost))) {
    throw new Error(`Invalid mood observer usage record in ${file}`)
  }
  return value
}

function emptyTotals(): PersonaObserverUsageTotals {
  return { requests: 0, measured: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, durationMs: 0, estimatedInput: 0 }
}

function add(totals: PersonaObserverUsageTotals, record: ObserverUsageRecord): void {
  totals.requests++
  totals.durationMs += record.durationMs
  if (!record.usage) return
  totals.measured++
  totals.input += record.usage.input
  totals.output += record.usage.output
  totals.cacheRead += record.usage.cacheRead
  totals.cacheWrite += record.usage.cacheWrite
  totals.reasoning += record.usage.reasoning
  totals.cost += record.cost ?? 0
  totals.estimatedInput += record.estimatedInput
}

export async function summarizeObserverUsage(range: PersonaObserverUsageRange, now = Date.now()): Promise<PersonaObserverUsageSummary> {
  if (range !== 7 && range !== 30 && range !== 'all') throw new Error('Invalid mood observer usage range')
  const since = range === 'all' ? 0 : now - range * DAY
  const totals = emptyTotals()
  const models = new Map<string, PersonaObserverUsageModel>()
  const outcomes = Object.fromEntries(PERSONA_OBSERVER_OUTCOMES.map(outcome => [outcome, 0])) as PersonaObserverUsageSummary['outcomes']
  for (const { name } of (await usageFiles()).filter(file => file.end > since)) {
    const raw = await fs.readFile(join(personaDir(), name), 'utf8')
    // Only newline-terminated lines are complete; the tail may be an append still in progress.
    const lines = raw.split('\n').slice(0, -1)
    for (const line of lines) {
      if (!line) continue
      const record = parseRecord(line, name)
      if (record.at < since) continue
      add(totals, record)
      outcomes[record.outcome]++
      const key = JSON.stringify([record.provider, record.modelId, record.inherited, record.thinking])
      let model = models.get(key)
      if (!model) {
        model = { provider: record.provider, modelId: record.modelId, inherited: record.inherited, thinking: record.thinking, ...emptyTotals() }
        models.set(key, model)
      }
      add(model, record)
    }
  }
  return { range, totals, outcomes, models: [...models.values()].sort((a, b) => b.requests - a.requests) }
}

export async function clearObserverUsage(): Promise<void> {
  for (const { name } of await usageFiles()) await fs.rm(join(personaDir(), name), { force: true })
}
