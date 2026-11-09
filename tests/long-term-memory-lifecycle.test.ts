import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LongTermMemoryStore } from '../src/main/features/memory/long-term/store'
import { parseLearning } from '../src/main/features/memory/long-term/learning'
import { parseIntegration } from '../src/main/features/memory/long-term/integration'
import { rawWindow, learningOutput, seedKnowledge } from './helpers/long-term-memory'

test('integration validates IDs, targets, immutable merge semantics and direct evidence before writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'pig-integration-')); const store = new LongTermMemoryStore(join(root, 'memory.sqlite'))
  try {
    const access = { project: root, session: 'session', cwd: root }
    const previous = seedKnowledge(store, rawWindow(root))[0]!
    const window = rawWindow(root, 2); store.register(window)
    store.commitLearning(window, parseLearning(JSON.stringify(learningOutput(window)), window, []), store.sourceRevision())
    const input = store.pending('session', new Set([window.anchorId]))[0]!
    const proposalId = input.proposals[0]!.id
    const parse = (change: Record<string, unknown>) => parseIntegration(JSON.stringify({ changes: [change] }), input, [previous], access)
    expect(() => parse({ proposalId: 'unknown', action: 'skip' })).toThrow()
    expect(() => parse({ proposalId, action: 'merge', targetId: previous.id, content: 'rewrite' })).toThrow(/rewrite/)
    expect(() => parse({ proposalId, action: 'add', targetId: previous.id, content: 'new', applicability: 'scope' })).toThrow(/boundary/)
    expect(() => parse({ proposalId, action: 'supersede', targetId: 'not supplied', content: 'new', applicability: 'scope' })).toThrow(/boundary/)
    const changes = parse({ proposalId, action: 'merge', targetId: previous.id })
    store.integrate(input, changes, store.revision())
    expect(store.page('knowledge').memories).toHaveLength(1)
    expect(store.evidence(previous.id)).toHaveLength(2)
    expect(store.read(previous.id, access)!.content).toBe(previous.content)
    expect(() => store.integrate(input, changes, store.revision())).toThrow()
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('continuations update one experience and retain exact old/new source references', () => {
  const root = mkdtempSync(join(tmpdir(), 'pig-continuation-')); const store = new LongTermMemoryStore(join(root, 'memory.sqlite'))
  try {
    seedKnowledge(store, rawWindow(root))
    const previous = store.page('episodes').episodes[0]!
    const window = rawWindow(root, 2)
    const draft = learningOutput(window)
    const output = { episodes: draft.episodes.map(item => ({ ...item, continuationId: previous.id, content: '同一任务后续修复已完成并验证', proposals: [] })) }
    const result = parseLearning(JSON.stringify(output), window, [previous])
    store.register(window); store.commitLearning(window, result, store.sourceRevision())
    expect(store.page('episodes').episodes).toHaveLength(1)
    expect(store.episode(previous.id)!.sources.map(ref => ref.entryId)).toEqual(['u1', 't1', 'u2', 't2'])
    expect(() => parseLearning(JSON.stringify(output), window, [])).toThrow(/continuation/)
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('pending jobs retain retry backoff across fresh connections; usage is aggregate-only', () => {
  const root = mkdtempSync(join(tmpdir(), 'pig-learning-status-')); const path = join(root, 'memory.sqlite')
  const store = new LongTermMemoryStore(path)
  try {
    const window = rawWindow(root); store.register(window)
    expect(store.fail(window.id, 'schema', 'extraction', 0)).toBe(60_000)
    expect(store.fail(window.id, 'schema', 'extraction', 0)).toBe(120_000)
    store.recordUsage('extraction', { input: 30, output: 20, cost: 0.01 })
    const other = new LongTermMemoryStore(path)
    try {
      expect(other.job(window.id)!.retryAt).toBe(120_000)
      expect(other.status().usage).toEqual([{ stage: 'extraction', requests: 1, input: 30, output: 20, cost: 0.01 }])
      expect(other.status().lastError!.code).toBe('schema')
      expect(other.status().pendingJobs).toBe(1)
    } finally { other.close() }
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})
