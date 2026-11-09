import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LongTermMemoryStore } from '../src/main/features/memory/long-term/store'
import { parseLearning } from '../src/main/features/memory/long-term/learning'
import { parseIntegration } from '../src/main/features/memory/long-term/integration'
import { rawWindow, learningOutput, seedKnowledge } from './helpers/long-term-memory'
import { sourceWindow, type SourceEntry } from '../src/main/features/memory/long-term/sources'

function fixture(work: (store: LongTermMemoryStore, root: string, path: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'pig-learning-store-')); const path = join(root, 'memory.sqlite')
  const store = new LongTermMemoryStore(path)
  try { work(store, root, path) } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
}

test('learning and source checkpoints commit atomically; no-op creates no experiences or proposals', () => fixture((store, root, path) => {
  const window = rawWindow(root)
  store.register(window)
  const result = parseLearning(JSON.stringify(learningOutput(window)), window, [])
  expect(() => store.commitLearning(window, result, store.sourceRevision() + 1)).toThrow(/changed/)
  expect(store.processed('session', 'u1')).toBe(false)
  store.commitLearning(window, { episodes: [], proposals: [] }, store.sourceRevision())
  expect(store.processed('session', 'u1')).toBe(true)
  expect(store.page('episodes').episodes).toEqual([])
  const other = new LongTermMemoryStore(path)
  try { expect(other.processed('session', 'u1')).toBe(true); expect(other.status().pendingJobs).toBe(0) } finally { other.close() }
}))

test('fresh-session baseline skips existing history and old sibling branches, but admits future sources', () => fixture((store, root) => {
  const window = rawWindow(root)
  store.initializeSession('session', window.entryIds, '2026-11-09T00:00:00.000Z')
  expect(store.processed('session', 'u1')).toBe(true)
  store.initializeSession('session', ['future'], '2026-11-11T00:00:00.000Z')
  expect(store.processed('session', 'future')).toBe(false)
  const entries: SourceEntry[] = [
    { id: 'old-sibling', parentId: null, type: 'message', message: { role: 'user', content: 'old history', timestamp: Date.parse('2026-11-08T00:00:00Z') } },
    { id: 'future', parentId: 'old-sibling', type: 'message', message: { role: 'user', content: 'new learning', timestamp: Date.parse('2026-11-10T00:00:00Z') } },
  ]
  const manager = { getLeafId: () => 'future', getEntry: (id: string) => entries.find(entry => entry.id === id) } as Parameters<typeof sourceWindow>[0]
  const next = sourceWindow(manager, window.origin, id => store.processed('session', id), store.initializedAt('session'))!
  expect(next.entryIds).toEqual(['old-sibling', 'future'])
  expect(next.sources.map(source => source.ref.entryId)).toEqual(['future'])
}))

test('integration skip clears proposals, retains experience and never writes a skipped knowledge record', () => fixture((store, root, path) => {
  const window = rawWindow(root); store.register(window)
  store.commitLearning(window, parseLearning(JSON.stringify(learningOutput(window)), window, []), store.sourceRevision())
  const input = store.pending('session', new Set([window.anchorId]))[0]!
  store.integrate(input, input.proposals.map(proposal => ({ proposalId: proposal.id, action: 'skip' })), store.revision())
  expect(store.page('knowledge').memories).toEqual([])
  expect(store.page('episodes').episodes[0]!.integration).toBe('done')
  const db = new DatabaseSync(path)
  try { expect(db.prepare('SELECT count(*) AS n FROM knowledge_proposals').get()!.n).toBe(0) } finally { db.close() }
}))

test('project profiles are discoverable globally; project details and checkout-specific lessons are isolated', () => fixture((store, root) => {
  seedKnowledge(store, rawWindow(root), ['用户开发 Pig 项目'], 'project')
  const knowledge = seedKnowledge(store, rawWindow(root, 2), ['项目使用中文检索'])[0]!
  const remote = { project: '/other', session: 'other', cwd: '/other' }
  expect(store.search('Pig', remote)).toHaveLength(1)
  expect(store.read(knowledge.id, remote)).toBeUndefined()
  const window = rawWindow(root, 3); const output = learningOutput(window, ['mock 导出缺失，补齐后测试通过'], 'lesson')
  Object.assign(output.episodes[0]!.proposals[0]!, { assertion: 'tool-verified', sourceEntryIds: ['t3'] })
  store.register(window); store.commitLearning(window, parseLearning(JSON.stringify(output), window, []), store.sourceRevision())
  const input = store.pending('session', new Set([window.anchorId]))[0]!
  const changes = parseIntegration(JSON.stringify({ changes: input.proposals.map(p => ({ proposalId: p.id, action: 'add', content: p.content, applicability: p.applicability })) }), input, [], { project: root, session: 'session', cwd: root })
  store.integrate(input, changes, store.revision())
  const lesson = store.page('lesson').memories[0]!
  expect(store.read(lesson.id, { project: root, session: 'new-session', cwd: root })).toBeDefined()
  expect(store.read(lesson.id, { project: root, session: 'session', cwd: root + '/sibling' })).toBeUndefined()
}))

test('preference candidates contain only explicit preferences, never globally visible project profiles', () => fixture((store, root) => {
  const profile = seedKnowledge(store, rawWindow(root), ['Atlas 是 Rust 日志查看 CLI。'], 'project')[0]!
  const preference = seedKnowledge(store, rawWindow(root, 2), ['以后默认使用 Bun。'], 'preference')[0]!
  const access = { project: root, session: 'session', cwd: root }
  expect(store.preferenceCandidates(access).map(item => item.id)).toEqual([preference.id])
  const window = rawWindow(root, 3)
  store.register(window)
  store.commitLearning(window, parseLearning(JSON.stringify(learningOutput(window, ['Atlas 项目'], 'project')), window, []), store.sourceRevision())
  const input = store.pending('session', new Set([window.anchorId]))[0]!
  const output = JSON.stringify({ changes: [{ proposalId: input.proposals[0]!.id, action: 'add', content: '实现见 src/main/extension.ts', applicability: 'Atlas' }] })
  expect(() => parseIntegration(output, input, [], access)).toThrow(/profile/)
  expect(store.projectDirectory().map(item => item.id)).toContain(profile.id)
}))

test('newer direct adoption supersedes current knowledge while preserving auditable history', () => fixture((store, root) => {
  const old = seedKnowledge(store, rawWindow(root), ['项目使用 JSONL 偏移检查点'])[0]!
  const window = rawWindow(root, 2); store.register(window)
  store.commitLearning(window, parseLearning(JSON.stringify(learningOutput(window, ['项目使用祖先链检查点'])), window, []), store.sourceRevision())
  const input = store.pending('session', new Set([window.anchorId]))[0]!
  const access = { project: root, session: 'session', cwd: root }
  const draft = { changes: [{ proposalId: input.proposals[0]!.id, action: 'supersede', targetId: old.id,
    content: '项目使用祖先链检查点', applicability: '该项目的增量学习来源同步' }] }
  const changes = parseIntegration(JSON.stringify(draft), input, [old], access)
  store.integrate(input, changes, store.revision())
  expect(store.read(old.id, access)!.status).toBe('superseded')
  expect(store.search('检查点', access).map(item => item.content)).toEqual(['项目使用祖先链检查点'])
  expect(store.evidence(input.proposals[0]!.id)[0]!.sources[0]!.entryId).toBe('u2')
}))

test('forget removes derived experiences, proposal copies, FTS and replacement history; stale commits fail', () => fixture((store, root, path) => {
  const fact = seedKnowledge(store, rawWindow(root))[0]!
  const staleRevision = store.sourceRevision()
  const episode = store.page('episodes').episodes[0]!
  store.forgetFact(fact.id)
  expect(store.read(fact.id, { project: root, session: 'session' })).toBeUndefined()
  expect(store.episode(episode.id)).toBeUndefined()
  expect(store.search('中文', { project: root, session: 'session' })).toEqual([])
  expect(store.isForgotten('session', 'u1')).toBe(true)
  expect(store.processed('session', 'u1')).toBe(true)
  const window = rawWindow(root, 2); store.register(window)
  expect(() => store.commitLearning(window, { episodes: [], proposals: [] }, staleRevision)).toThrow(/changed/)
  const db = new DatabaseSync(path)
  try { expect(db.prepare('SELECT count(*) AS n FROM knowledge_evidence').get()!.n).toBe(0) } finally { db.close() }
}))

test('deleting an experience never cascades to knowledge with independent source references', () => fixture((store, root) => {
  const fact = seedKnowledge(store, rawWindow(root))[0]!
  const episode = store.page('episodes').episodes[0]!
  store.deleteEpisode(episode.id)
  expect(store.episode(episode.id)).toBeUndefined()
  expect(store.read(fact.id, { project: root, session: 'session' })).toBeDefined()
  expect(store.evidence(fact.id)).toHaveLength(1)
}))

test('old schemas and corrupt databases fail explicitly without migration or reset', () => {
  const root = mkdtempSync(join(tmpdir(), 'pig-learning-old-'))
  try {
    const path = join(root, 'memory.sqlite'); const db = new DatabaseSync(path)
    db.exec('CREATE TABLE memory_candidates (id TEXT PRIMARY KEY, payload TEXT)'); db.close()
    expect(() => new LongTermMemoryStore(path)).toThrow(/explicitly clear/)
    const old = readFileSync(path)
    expect(() => new LongTermMemoryStore(path)).toThrow()
    expect(readFileSync(path)).toEqual(old)
    writeFileSync(path, 'corrupt sqlite')
    expect(() => new LongTermMemoryStore(path)).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('corrupt sqlite')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
