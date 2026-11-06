import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectMemoryCandidates, type CandidateOrigin } from '../src/main/features/memory/long-term/candidates'
import { MemoryCandidateStore } from '../src/main/features/memory/long-term/store'
import { OM_OBSERVATIONS_RECORDED, OM_REFLECTIONS_RECORDED, type Entry } from '../src/main/features/memory/session-ledger/types'

const origin: CandidateOrigin = { sessionId: 'session-a', sessionFile: '/sessions/a.jsonl', cwd: '/project/worktree-a' }
function branch(): Entry[] {
  return [
    { type: 'message', id: 'user', message: { role: 'user', content: 'Prefer bun for this project' } },
    {
      type: 'custom', id: 'observed', customType: OM_OBSERVATIONS_RECORDED,
      data: { coversUpToId: 'user', observations: [{
        id: 'aaaaaaaaaaaa', content: 'User prefers bun for this project.', relevance: 'critical',
        timestamp: '2026-11-06 12:00', sourceEntryIds: ['user'], tokenCount: 10
      }] }
    },
    {
      type: 'custom', id: 'reflected', timestamp: '2026-11-06T04:00:00.000Z', customType: OM_REFLECTIONS_RECORDED,
      data: { coversUpToId: 'user', reflections: [{
        id: 'bbbbbbbbbbbb', content: 'Use bun for this project.', supportingObservationIds: ['aaaaaaaaaaaa'], tokenCount: 8
      }] }
    }
  ]
}

function withStore(run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'pig-long-term-'))
  try { run(join(dir, 'private', 'long-term.sqlite')) } finally { rmSync(dir, { recursive: true, force: true }) }
}

describe('long-term memory candidate inbox', () => {
  test('preserves exact provenance without copying raw message bodies or granting global scope', () => {
    const { candidates } = collectMemoryCandidates(origin, branch())
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.origin).toEqual(origin)
    expect(candidates[0]!.evidence).toEqual([{
      observationId: 'aaaaaaaaaaaa', observationEntryId: 'observed', observationRecordIndex: 0, sourceEntryIds: ['user']
    }])
    expect(JSON.stringify(candidates)).not.toContain('Prefer bun for this project')
    expect(candidates[0]!.recordedAt).toBe('2026-11-06T04:00:00.000Z')
    expect(candidates[0]).not.toHaveProperty('scope')
  })

  test('rejects missing, ambiguous, forward and injected-only evidence', () => {
    const entries = branch()
    for (const invalid of [
      entries.slice(1),
      [entries[0]!, entries[1]!, entries[1]!, entries[2]!],
      [entries[0]!, entries[2]!, entries[1]!],
      [entries[1]!, entries[0]!, entries[2]!],
      [{ ...entries[0]!, type: 'custom_message' }, ...entries.slice(1)],
      ...['memory_search', 'memory_read', 'memory_recall', 'recall', 'session_read'].map(toolName => [
        { ...entries[0]!, message: { role: 'toolResult', toolName, content: 'recalled fact' } }, ...entries.slice(1)
      ])
    ]) {
      const result = collectMemoryCandidates(origin, invalid)
      expect(result.candidates).toHaveLength(0)
      expect(result.incomplete).toBe(1)
    }
  })

  test('does not collide across sessions or ledger entries with the same reflection hash', () => {
    const a = collectMemoryCandidates(origin, branch()).candidates[0]!
    const b = collectMemoryCandidates({ ...origin, sessionId: 'session-b' }, branch()).candidates[0]!
    const entries = branch()
    entries[2] = { ...entries[2]!, id: 'other-ledger-entry' }
    const c = collectMemoryCandidates(origin, entries).candidates[0]!
    expect(new Set([a.id, b.id, c.id]).size).toBe(3)
  })

  test('filters common credential-shaped contents without storing a partial/redacted claim', () => {
    const entries = branch()
    const data = entries[2]!.data as { reflections: { content: string }[] }
    data.reflections[0]!.content = `api_key=${'x'.repeat(30)}`
    const result = collectMemoryCandidates(origin, entries)
    expect(result.candidates).toHaveLength(0)
    expect(result.sensitive).toBe(1)
  })

  test('replay is idempotent after restart; concurrent connections cannot duplicate a source', () => withStore(path => {
    const candidates = collectMemoryCandidates(origin, branch()).candidates
    let store = new MemoryCandidateStore(path)
    expect(store.enqueue(candidates)).toBe(1)
    const other = new MemoryCandidateStore(path)
    try { expect(other.enqueue(candidates)).toBe(0) } finally { other.close() }
    store.close()
    store = new MemoryCandidateStore(path)
    try {
      expect(store.enqueue(candidates)).toBe(0)
      expect(store.list()).toEqual(candidates)
      expect(statSync(path).mode & 0o777).toBe(0o600)
    } finally { store.close() }
  }))

  test('changed source rolls back the entire batch instead of overwriting earlier provenance', () => withStore(path => {
    const candidate = collectMemoryCandidates(origin, branch()).candidates[0]!
    const store = new MemoryCandidateStore(path)
    try {
      store.enqueue([candidate])
      expect(() => store.enqueue([
        { ...candidate, id: 'another-id' }, { ...candidate, content: 'Changed claim' }
      ])).toThrow('source changed')
      expect(store.list()).toEqual([candidate])
    } finally { store.close() }
  }))

  test('forget removes the derived record and prevents automatic replay from restoring it', () => withStore(path => {
    const candidate = collectMemoryCandidates(origin, branch()).candidates[0]!
    let store = new MemoryCandidateStore(path)
    store.enqueue([candidate])
    store.forget(candidate.id)
    store.close()
    store = new MemoryCandidateStore(path)
    try {
      expect(store.enqueue([candidate])).toBe(0)
      expect(store.list()).toEqual([])
    } finally { store.close() }
  }))

  test('a corrupt database is reported and never replaced with empty memory', () => withStore(path => {
    const store = new MemoryCandidateStore(path)
    store.close()
    writeFileSync(path, 'broken database')
    expect(() => new MemoryCandidateStore(path)).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('broken database')
  }))
})
