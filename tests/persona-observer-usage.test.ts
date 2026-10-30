import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFile, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendObserverUsage, clearObserverUsage, summarizeObserverUsage, type ObserverUsageRecord } from '../src/main/plugins/pi-persona/usage'

let root: string
let oldPig: string | undefined
beforeEach(async () => {
  oldPig = process.env.PIG_DIR
  root = await mkdtemp(join(tmpdir(), 'pig-observer-usage-'))
  process.env.PIG_DIR = join(root, 'pig')
})
afterEach(async () => {
  if (oldPig === undefined) delete process.env.PIG_DIR
  else process.env.PIG_DIR = oldPig
  await rm(root, { recursive: true, force: true })
})

const now = Date.UTC(2026, 9, 30, 12)
const DAY = 86_400_000
function record(patch: Partial<ObserverUsageRecord> = {}): ObserverUsageRecord {
  return {
    v: 1, at: now, sessionId: 's', provider: 'p', modelId: 'm', inherited: true, thinking: 'off',
    rounds: { fresh: 3, background: 0 }, estimatedInput: 100, durationMs: 1000, outcome: 'changed',
    usage: { input: 10, output: 5, cacheRead: 90, cacheWrite: 0, reasoning: 0 }, cost: 0.01, ...patch,
  }
}

test('records append to private monthly files and summarize by range and model', async () => {
  await appendObserverUsage(record())
  await appendObserverUsage(record({ at: now - 10 * DAY, outcome: 'unchanged' }))
  await appendObserverUsage(record({ at: now - 40 * DAY, provider: 'q', inherited: false, thinking: 'low' }))
  await appendObserverUsage(record({ outcome: 'timeout', usage: null, cost: null }))
  const dir = join(process.env.PIG_DIR!, 'persona')
  expect((await readdir(dir)).sort()).toEqual(['observer-usage-2026-09.jsonl', 'observer-usage-2026-10.jsonl'])
  expect((await stat(join(dir, 'observer-usage-2026-10.jsonl'))).mode & 0o777).toBe(0o600)

  const week = await summarizeObserverUsage(7, now)
  expect(week.totals).toMatchObject({ requests: 2, measured: 1, input: 10, cacheRead: 90, cost: 0.01, durationMs: 2000, estimatedInput: 100 })
  expect(week.outcomes).toMatchObject({ changed: 1, timeout: 1, unchanged: 0 })
  expect((await summarizeObserverUsage(30, now)).totals.requests).toBe(3)
  const all = await summarizeObserverUsage('all', now)
  expect(all.totals.requests).toBe(4)
  expect(all.models.map(model => [model.provider, model.inherited, model.thinking, model.requests])).toEqual([['p', true, 'off', 3], ['q', false, 'low', 1]])
})

test('an unterminated tail is an append in progress; malformed complete lines and ranges throw', async () => {
  await appendObserverUsage(record())
  const file = join(process.env.PIG_DIR!, 'persona', 'observer-usage-2026-10.jsonl')
  await appendFile(file, '{"v":1,"at":')
  expect((await summarizeObserverUsage(7, now)).totals.requests).toBe(1)
  await appendFile(file, '\n')
  await expect(summarizeObserverUsage(7, now)).rejects.toThrow()
  await expect(summarizeObserverUsage(5 as never, now)).rejects.toThrow(/range/)
})

test('a torn append is dropped before the next record instead of corrupting it', async () => {
  await appendObserverUsage(record())
  const file = join(process.env.PIG_DIR!, 'persona', 'observer-usage-2026-10.jsonl')
  await appendFile(file, '{"v":1,"at":')
  await appendObserverUsage(record({ outcome: 'unchanged' }))
  const summary = await summarizeObserverUsage(7, now)
  expect(summary.totals.requests).toBe(2)
  expect(summary.outcomes).toMatchObject({ changed: 1, unchanged: 1 })

  await rm(file)
  await appendFile(file, '{"v":1')
  await appendObserverUsage(record())
  expect((await summarizeObserverUsage(7, now)).totals.requests).toBe(1)
})

test('missing storage summarizes as empty and clear removes every record file', async () => {
  expect((await summarizeObserverUsage('all', now)).totals.requests).toBe(0)
  await appendObserverUsage(record())
  await appendObserverUsage(record({ at: now - 40 * DAY }))
  await clearObserverUsage()
  expect((await summarizeObserverUsage('all', now)).totals.requests).toBe(0)
})
