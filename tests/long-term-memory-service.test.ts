import { test, expect } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSelf } from './helpers/subprocess'

async function fixture(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'pig-memory-service-'))
  process.env.PIG_DIR = join(root, 'pig')
  try {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent')
    const { collectPersistedMemoryCandidates } = await import('../src/main/features/memory/long-term/service')
    const { MemoryCandidateStore } = await import('../src/main/features/memory/long-term/store')
    const { recallLongTermSources } = await import('../src/main/features/memory/long-term/recall')
    const path = join(process.env.PIG_DIR, 'memory', 'long-term.sqlite')
    const ephemeral = SessionManager.inMemory(root)
    collectPersistedMemoryCandidates({ cwd: root, sessionManager: ephemeral })
    expect(existsSync(path)).toBe(false)

    const sm = SessionManager.create(root, join(root, 'sessions'))
    collectPersistedMemoryCandidates({ cwd: root, sessionManager: sm })
    expect(existsSync(path)).toBe(false)
    const user = sm.appendMessage({ role: 'user', content: 'Use bun', timestamp: Date.now() })
    sm.appendCustomEntry('om.observations.recorded', { coversUpToId: user, observations: [{
      id: 'aaaaaaaaaaaa', content: 'User prefers bun.', relevance: 'high', timestamp: '2026-11-06 12:00',
      sourceEntryIds: [user], tokenCount: 6
    }] })
    sm.appendCustomEntry('om.reflections.recorded', { coversUpToId: user, reflections: [{
      id: 'bbbbbbbbbbbb', content: 'Use bun for this project.', supportingObservationIds: ['aaaaaaaaaaaa'], tokenCount: 8
    }] })
    // Simulate an app exit between the JSONL append and the inbox write.
    expect(existsSync(path)).toBe(false)
    const restored = SessionManager.open(sm.getSessionFile()!)
    collectPersistedMemoryCandidates({ cwd: root, sessionManager: restored })
    collectPersistedMemoryCandidates({ cwd: root, sessionManager: restored })
    let store = new MemoryCandidateStore(path)
    let candidateId: string
    try {
      expect(store.list()).toHaveLength(1)
      const candidate = store.list()[0]!
      candidateId = candidate.id
      expect(candidate.origin.sessionId).toBe(sm.getSessionId())
      expect(candidate.evidence[0]!.sourceEntryIds).toEqual([user])
      const evidence = { candidateId: candidate.id, sessionId: candidate.origin.sessionId,
        reflectionEntryId: candidate.reflectionEntryId, reflectionId: candidate.reflectionId, sourceEntryIds: [user] }
      expect(recallLongTermSources(candidate, evidence).sources[0]!.text).toBe('Use bun')
      expect(recallLongTermSources({ ...candidate, content: 'changed' }, evidence).status).toBe('changed')
      expect(recallLongTermSources({ ...candidate, origin: { ...candidate.origin, sessionFile: join(root, 'missing.jsonl') } }, evidence).status).not.toBe('available')
      store.forget(candidate.id)
    } finally { store.close() }
    collectPersistedMemoryCandidates({ cwd: root, sessionManager: restored })
    store = new MemoryCandidateStore(path)
    try { expect(store.list().some(item => item.id === candidateId)).toBe(false) } finally { store.close() }

    // A newly opened alternative branch cannot collect the abandoned branch's reflection.
    restored.branch(user)
    restored.appendMessage({ role: 'user', content: 'Try another approach', timestamp: Date.now() })
    process.env.PIG_DIR = join(root, 'alternative-pig')
    collectPersistedMemoryCandidates({ cwd: root, sessionManager: restored })
    expect(existsSync(join(process.env.PIG_DIR, 'memory', 'long-term.sqlite'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv.includes('--long-term-service-fixture')) {
  await fixture()
} else {
  test('real SDK replay repairs an interrupted candidate write, preserves forgetting and isolates branch evidence', async () => {
    const result = await runSelf(import.meta.path, ['--long-term-service-fixture'], { timeoutMs: 10_000 })
    expect(result.exitCode, result.stderr || result.stdout).toBe(0)
  })
}
