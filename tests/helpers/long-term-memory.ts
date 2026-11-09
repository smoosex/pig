import type { LongTermFact } from '../../src/shared/long-term-memory'
import { parseLearning } from '../../src/main/features/memory/long-term/learning'
import { parseIntegration } from '../../src/main/features/memory/long-term/integration'
import { LongTermMemoryStore, type MemoryAccess } from '../../src/main/features/memory/long-term/store'
import { sourceWindow, type LearningWindow, type SourceEntry } from '../../src/main/features/memory/long-term/sources'

export function rawWindow(root: string, index = 1): LearningWindow {
  const time = new Date(Date.UTC(2026, 10, index)).toISOString()
  const entries: SourceEntry[] = [
    { type: 'message', id: `u${index}`, parentId: null, timestamp: time, message: { role: 'user', content: '项目决定使用中文检索；以后开发默认使用 Bun。', timestamp: Date.parse(time) } },
    { type: 'message', id: `t${index}`, parentId: `u${index}`, timestamp: time, message: { role: 'toolResult', content: [{ type: 'text', text: 'Test verified: mock exports fixed; typecheck passed.' }], toolName: 'bash', isError: false, timestamp: Date.parse(time) } },
  ]
  return sourceWindow({ getLeafId: () => entries.at(-1)!.id, getEntry: id => entries.find(entry => entry.id === id) } as Parameters<typeof sourceWindow>[0],
    { sessionId: 'session', sessionFile: `${root}/session.jsonl`, cwd: root, project: root }, () => false)!
}
export function learningOutput(window: LearningWindow, contents = ['项目使用中文检索'], kind: LongTermFact['kind'] = 'knowledge') {
  return { episodes: [{ title: '实现中文检索', content: '用户决定项目使用中文检索，完成了相关验证；仅记录有证据的任务结果。', outcome: 'success',
    sourceEntryIds: window.sources.map(source => source.ref.entryId), proposals: contents.map(content => ({
      content, kind, assertion: 'user-statement', applicability: '仅适用于该项目中相同的开发任务。',
      sourceEntryIds: [window.sources.find(source => source.ref.role === 'user')!.ref.entryId],
    })) }] }
}
export function seedKnowledge(store: LongTermMemoryStore, window: LearningWindow, contents = ['项目使用中文检索'], kind: LongTermFact['kind'] = 'knowledge'): LongTermFact[] {
  store.register(window)
  const learned = parseLearning(JSON.stringify(learningOutput(window, contents, kind)), window, [])
  store.commitLearning(window, learned, store.sourceRevision())
  const access: MemoryAccess = { project: window.origin.project, session: window.origin.sessionId, cwd: window.origin.cwd }
  const input = store.pending(access.session, new Set([window.anchorId]))[0]!
  const output = { changes: input.proposals.map(proposal => ({ proposalId: proposal.id, action: 'add', content: proposal.content, applicability: proposal.applicability })) }
  store.integrate(input, parseIntegration(JSON.stringify(output), input, [], access), store.revision())
  return store.page(kind).memories
}
