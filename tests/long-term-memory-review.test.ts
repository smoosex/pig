import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MemoryCandidateStore } from '../src/main/features/memory/long-term/store'
import { admissionInput, parseReviews, type AdmissionInput } from '../src/main/features/memory/long-term/reviewer'
import { validateLongTermSettings } from '../src/main/features/memory/long-term/settings'
import type { MemoryCandidate } from '../src/main/features/memory/long-term/candidates'
import type { Entry } from '../src/main/features/memory/session-ledger/types'

const access = { project: '/repo/.git', session: 'session-1' }
const time = '2026-11-06T00:00:00.000Z'
function candidate(index: number): MemoryCandidate {
  return { id: String(index).padStart(64, '0'), origin: { sessionId: access.session, sessionFile: '/session.jsonl', cwd: '/repo' },
    content: '用户决定项目使用中文检索', recordedAt: time, reflectionId: 'bbbbbbbbbbbb', reflectionEntryId: `reflection-${index}`, reflectionRecordIndex: 0,
    evidence: [{ observationId: 'aaaaaaaaaaaa', observationEntryId: 'observation', observationRecordIndex: 0, sourceEntryIds: ['user-1', 'tool-1'] }] }
}
function input(index: number): AdmissionInput {
  return { candidate: candidate(index), sources: [
    { id: 'user-1', role: 'user', timestamp: time, text: '我们决定这个项目使用中文检索。' },
    { id: 'tool-1', role: 'toolResult', timestamp: time, text: 'tests passed', isError: false },
    { id: 'assistant-1', role: 'assistant', timestamp: time, text: '已经完成全部功能。' },
  ] }
}
function proposal(index: number, changes: Record<string, unknown> = {}) {
  return { candidateId: candidate(index).id, action: 'add', content: '项目使用中文检索', kind: 'decision', scope: 'project',
    assertion: 'user-statement', sourceEntryIds: ['user-1'], ...changes }
}
function parse(index: number, changes: Record<string, unknown> = {}) {
  return parseReviews(JSON.stringify({ reviews: [proposal(index, changes)] }), [input(index)], [], access)
}
function storeTest(action: (store: MemoryCandidateStore, path: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'pig-long-term-review-'))
  const path = join(root, 'memory.sqlite')
  const store = new MemoryCandidateStore(path)
  try { action(store, path) } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
}

test('admission requires role-appropriate direct evidence and cannot promote branch outcomes globally', () => {
  assert.equal(parse(1)[0]!.fact!.scopeKey, access.project)
  for (const patch of [
    { sourceEntryIds: ['missing'] }, { sourceEntryIds: [] }, { sourceEntryIds: ['assistant-1'] },
    { scope: 'global' }, { scope: 'global', kind: 'outcome' }, { kind: 'outcome' },
    { assertion: 'tool-verified', sourceEntryIds: ['tool-1'] }, { targetId: 'invented' },
    { content: 'secret=' + 's'.repeat(30) }, { content: 'line\nbreak' }, { extra: true }, { assertion: 'assistant-inference' },
  ]) assert.throws(() => parse(1, patch))
  assert.equal(parse(1, { assertion: 'tool-verified', sourceEntryIds: ['tool-1'], scope: 'session', kind: 'outcome' })[0]!.fact!.scope, 'session')
  const failed = input(1); failed.sources[1]!.isError = true
  assert.throws(() => parseReviews(JSON.stringify({ reviews: [proposal(1, { assertion: 'tool-verified', sourceEntryIds: ['tool-1'], scope: 'session' })] }), [failed], [], access))
  for (const text of ['not JSON', '[]', JSON.stringify({ reviews: [proposal(1), proposal(1)] }), JSON.stringify({ reviews: [proposal(2)] })]) {
    assert.throws(() => parseReviews(text, [input(1)], [], access))
  }
})

test('admission sources exclude thinking, injected memory, credentials and unsupported message types', () => {
  const entries = [
    { id: 'user-1', type: 'message', timestamp: time, message: { role: 'user', content: 'original' } },
    { id: 'tool-1', type: 'message', timestamp: time, message: { role: 'toolResult', content: [{ type: 'thinking', thinking: 'never expose' }, { type: 'text', text: 'visible' }] } },
    { id: 'user-1', type: 'custom_message', content: 'injected facts' },
  ] as unknown as Entry[]
  const packed = admissionInput(candidate(1), entries)
  assert.deepEqual(packed.sources.map(source => source.text), ['original', 'visible'])
  entries[0]!.message = { role: 'user', content: 'password=' + 'x'.repeat(20) }
  assert.equal(admissionInput(candidate(1), entries).sources.length, 1)
  entries[1]!.message = { role: 'toolResult', toolName: 'memory_read', content: 'a previously remembered claim' }
  assert.equal(admissionInput(candidate(1), entries).sources.length, 0, 'memory tool output cannot become independent evidence')
})

test('SQLite admission is replay-safe, Chinese-searchable and scope-isolated across sessions', () => storeTest(store => {
  store.enqueue([candidate(1), candidate(2)])
  store.review(parse(1), store.revision())
  assert.equal(store.search('中文检索', { ...access, session: 'another-session' })[0]!.id, candidate(1).id)
  assert.deepEqual(store.search('中文检索', { project: '/other', session: 'other' }), [])
  assert.equal(store.pending(access.session, new Set([candidate(1).id, candidate(2).id])).length, 1)
  assert.deepEqual(store.page('candidates').candidates.map(item => item.id), [candidate(2).id])
  assert.throws(() => store.deleteCandidate(candidate(1).id), /Only pending/)
  assert.ok(store.read(candidate(1).id, access), 'a stale candidate delete cannot remove an admitted fact')
  assert.deepEqual(store.evidence(candidate(1).id)[0]!.sourceEntryIds, ['user-1'])
  store.review(parse(2), store.revision())
  assert.equal(store.page('memories').memories.length, 1, 'exact duplicate adds evidence, not a competing fact')
  assert.equal(store.evidence(candidate(1).id).length, 2)
  assert.throws(() => store.review(parse(1), store.revision()), /changed during review/)
}))

test('superseding keeps history but only the correction is automatically retrieved; conflicts retain both sides', () => storeTest(store => {
  store.enqueue([candidate(1), candidate(2), candidate(3)])
  store.review(parse(1), store.revision())
  const original = store.read(candidate(1).id, access)!
  const newer = input(2); newer.sources[0]!.timestamp = '2026-11-07T00:00:00.000Z'
  const change = proposal(2, { action: 'supersede', targetId: original.id, content: '项目不再使用中文检索' })
  assert.throws(() => parseReviews(JSON.stringify({ reviews: [change] }), [input(2)], [original], access), /newer/)
  const reviews = parseReviews(JSON.stringify({ reviews: [change] }), [newer], [original], access)
  store.review(reviews, store.revision())
  assert.equal(store.read(original.id, access)!.status, 'superseded')
  assert.deepEqual(store.search('中文检索', access).map(item => item.id), [candidate(2).id])
  const correction = store.read(candidate(2).id, access)!
  store.review(parseReviews(JSON.stringify({ reviews: [proposal(3, { action: 'dispute', targetId: correction.id, content: '中文检索是否保留尚有冲突' })] }), [input(3)], [correction], access), store.revision())
  assert.equal(store.search('中文检索', access).length, 2)
  assert.ok(store.search('中文检索', access).every(item => item.status === 'disputed'))
}))

test('forget deletes derived indexes and linked candidates, prevents replay, and rejects late model commits', () => storeTest(store => {
  store.enqueue([candidate(1), candidate(2), candidate(3)])
  store.review(parse(1), store.revision()); store.review(parse(2), store.revision())
  const before = store.revision()
  store.forgetFact(candidate(1).id)
  assert.deepEqual(store.search('中文检索', access), [])
  assert.deepEqual(store.evidence(candidate(1).id), [])
  assert.equal(store.enqueue([candidate(1), candidate(2)]), 0)
  assert.throws(() => store.review(parse(3), before), /changed during review/)
  assert.deepEqual(store.pending(access.session, new Set([candidate(3).id])).map(item => item.id), [candidate(3).id])
}))

test('skip atomically deletes rejected content, preserves progress and cannot replay after restart', () => storeTest((store, path) => {
  store.enqueue([candidate(1), candidate(2)])
  const broken = parse(2)[0]!; broken.action = 'merge'; broken.targetId = 'unknown'
  assert.throws(() => store.review([...parse(1), broken], store.revision()))
  assert.equal(store.page('memories').memories.length, 0)
  assert.ok(store.page('candidates').candidates.every(item => item.status === 'pending'))
  const skip = { candidate: candidate(1), action: 'skip' as const, sourceEntryIds: [] }
  const before = store.revision()
  assert.throws(() => store.review([skip, broken], before))
  assert.ok(store.candidate(candidate(1).id), 'a later failure rolls back the earlier deletion')
  assert.equal(store.collectionEntryProcessed(access.session, candidate(1).reflectionEntryId), false)
  assert.equal(store.revision(), before)
  store.review([skip], before)
  assert.equal(store.candidate(candidate(1).id), undefined)
  assert.deepEqual(store.page('candidates').candidates.map(item => item.id), [candidate(2).id])
  assert.equal(store.page('memories').memories.length, 0)
  assert.equal(store.revision(), before + 1)
  const reopened = new MemoryCandidateStore(path)
  try {
    assert.equal(reopened.enqueue([candidate(1)]), 0)
    assert.ok(reopened.candidate(candidate(2).id), 'other pending candidates are untouched')
    assert.equal(reopened.collectionEntryProcessed(access.session, candidate(1).reflectionEntryId), true)
  } finally { reopened.close() }
  const db = new DatabaseSync(path)
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM candidate_reviews').get()!.n, 0)
    assert.equal(db.prepare('SELECT count(*) AS n FROM forgotten_candidates').get()!.n, 0)
  } finally { db.close() }
}))

test('candidate deletion preserves other pending records and never deletes admitted memory', () => storeTest((store, path) => {
  store.enqueue([candidate(1), candidate(2), candidate(3)])
  store.review(parse(1), store.revision())
  const before = store.revision()
  store.deleteCandidate(candidate(2).id)
  assert.equal(store.revision(), before + 1)
  assert.equal(store.candidate(candidate(2).id), undefined)
  assert.equal(store.enqueue([candidate(2)]), 0)
  assert.deepEqual(store.page('candidates').candidates.map(item => item.id), [candidate(3).id])
  assert.equal(store.search('中文检索', access)[0]!.id, candidate(1).id)
  assert.equal(store.evidence(candidate(1).id).length, 1)
  assert.throws(() => store.review(parse(3), before), /changed during review/)
  store.deleteCandidate(candidate(2).id)
  assert.equal(store.revision(), before + 1, 'already-deleted candidates are a no-op')
  const db = new DatabaseSync(path)
  try { assert.equal(db.prepare('SELECT count(*) AS n FROM forgotten_candidates').get()!.n, 0) }
  finally { db.close() }
}))

test('long-term model settings are strict and never accept coerced values or hidden endpoints', () => {
  validateLongTermSettings({ enabled: false })
  validateLongTermSettings({ enabled: true, model: { provider: 'test', id: 'model', thinking: 'off' } })
  for (const value of [{ enabled: 'true' }, { enabled: true, model: { provider: 'test' } },
    { enabled: true, model: { provider: 'test', id: 'model', thinking: 'bogus' } },
    { enabled: true, model: { provider: 'test', id: 'model', baseUrl: 'https://custom.invalid' } }, { enabled: true, extra: true }]) {
    assert.throws(() => validateLongTermSettings(value))
  }
})
