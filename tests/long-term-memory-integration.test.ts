import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LongTermMemoryStore } from '../src/main/features/memory/long-term/store'
import { parseLearning } from '../src/main/features/memory/long-term/learning'
import { parseIntegration } from '../src/main/features/memory/long-term/integration'
import { rawWindow, learningOutput, seedKnowledge } from './helpers/long-term-memory'

test('a newer explicit resolution retires both sides of a conflict instead of recalling the loser forever', () => {
  const root = mkdtempSync(join(tmpdir(), 'pig-conflict-resolution-'))
  const store = new LongTermMemoryStore(join(root, 'memory.sqlite'))
  try {
    const access = { project: root, session: 'session', cwd: root }
    const old = seedKnowledge(store, rawWindow(root), ['项目检查点采用 A'])[0]!
    const update = (index: number, action: 'dispute' | 'supersede', targetId: string, content: string) => {
      const window = rawWindow(root, index); store.register(window)
      store.commitLearning(window, parseLearning(JSON.stringify(learningOutput(window, [content])), window, []), store.sourceRevision())
      const input = store.pending('session', new Set([window.anchorId]))[0]!
      const existing = store.related(input.proposals[0]!, access)
      const changes = parseIntegration(JSON.stringify({ changes: [{ proposalId: input.proposals[0]!.id, action, targetId, content, applicability: '该项目的检查点方案' }] }), input, existing, access)
      store.integrate(input, changes, store.revision())
      return input.proposals[0]!.id
    }
    const alternative = update(2, 'dispute', old.id, '项目检查点采用 B')
    expect(store.search('检查点', access).every(item => item.status === 'disputed')).toBe(true)
    const resolved = update(3, 'supersede', alternative, '用户明确最终采用 B 作为检查点')
    expect(store.search('检查点', access).map(item => item.id)).toEqual([resolved])
    expect(store.read(old.id, access)!.status).toBe('superseded')
    expect(store.read(alternative, access)!.status).toBe('superseded')
    store.forgetFact(resolved)
    expect(store.page('knowledge').memories).toEqual([])
    expect(store.page('episodes').episodes).toEqual([])
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})
