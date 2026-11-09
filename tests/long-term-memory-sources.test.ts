import { test, expect } from 'bun:test'
import { sourceWindow, learningSource, windowStillValid, type SourceEntry } from '../src/main/features/memory/long-term/sources'
import { parseLearning } from '../src/main/features/memory/long-term/learning'
import { rawWindow, learningOutput } from './helpers/long-term-memory'

const origin = { sessionId: 'session', sessionFile: '/session.jsonl', cwd: '/repo', project: '/repo' }
const time = '2026-11-09T00:00:00.000Z'
const message = (id: string, role: string, text: string, parentId: string | null = null): SourceEntry => ({ id, parentId, type: 'message', timestamp: time,
  message: { role, content: [{ type: 'text', text }], timestamp: Date.parse(time) } })

test('raw learning excludes OM, hidden injections, thinking and recalled tool results', () => {
  const user = message('u', 'user', '以后默认用 Bun')
  const hidden: SourceEntry = { id: 'h', parentId: 'u', type: 'custom_message', content: 'Injected memory' }
  const reflection: SourceEntry = { id: 'r', parentId: 'h', type: 'custom', customType: 'om.reflections.recorded', data: { reflections: ['not a source'] } }
  const recalled = { ...message('m', 'toolResult', 'derived memory', 'r'), message: { role: 'toolResult', content: 'derived memory', toolName: 'memory_read', timestamp: Date.parse(time) } }
  const assistant = { ...message('a', 'assistant', '完成', 'm'), message: { role: 'assistant', timestamp: Date.parse(time), content: [{ type: 'thinking', thinking: 'PRIVATE' }, { type: 'text', text: '完成' }] } }
  const entries = [user, hidden, reflection, recalled, assistant]
  const getEntry = (id: string) => entries.find(entry => entry.id === id)
  const window = sourceWindow({ getLeafId: () => 'a', getEntry } as Parameters<typeof sourceWindow>[0], origin, () => false)!
  expect(window.sources.map(source => source.ref.entryId)).toEqual(['u', 'a'])
  expect(JSON.stringify(window.sources)).not.toMatch(/PRIVATE|Injected memory|derived memory|not a source/)
  expect(window.entryIds).toHaveLength(5)
})

test('windows are bounded, earliest-first and stop at a shared processed ancestor', () => {
  const entries = Array.from({ length: 60 }, (_, index) => message(String(index), 'user', '中'.repeat(3000), index ? String(index - 1) : null))
  const manager = { getLeafId: () => '59', getEntry: (id: string) => entries.find(entry => entry.id === id) } as Parameters<typeof sourceWindow>[0]
  const first = sourceWindow(manager, origin, () => false)!
  expect(first.entryIds[0]).toBe('0')
  expect(Buffer.byteLength(JSON.stringify(first.sources))).toBeLessThan(18_000)
  const second = sourceWindow(manager, origin, id => first.entryIds.includes(id))!
  expect(second.entryIds[0]).toBe(String(first.entryIds.length))
  expect(sourceWindow(manager, origin, () => true)).toBeUndefined()
})

test('source validation allows metadata append but rejects fork and altered evidence', () => {
  const entries = [message('u', 'user', '开发习惯'), { id: 'meta', parentId: 'u', type: 'session_info' } as SourceEntry]
  const manager = { getLeafId: () => 'u', getEntry: (id: string) => entries.find(entry => entry.id === id) } as Parameters<typeof sourceWindow>[0]
  const window = sourceWindow(manager, origin, () => false)!
  manager.getLeafId = () => 'meta'
  expect(windowStillValid(window, manager)).toBe(true)
  manager.getLeafId = () => null
  expect(windowStillValid(window, manager)).toBe(false)
  manager.getLeafId = () => 'meta'
  entries[0] = message('u', 'user', 'changed')
  expect(windowStillValid(window, manager)).toBe(false)
})

test('sensitive evidence is omitted and cannot support learning', () => {
  const entry = message('u', 'user', 'api_key=abcdefghijklmno')
  const source = learningSource(entry, origin, entry.id, () => undefined)!
  expect(source.text).toMatch(/omitted/)
  expect(source.text).not.toContain('abcdefghijklmno')
  const window = { ...rawWindow('/repo'), sources: [source] }
  expect(() => parseLearning(JSON.stringify(learningOutput(window)), window, [])).toThrow(/omitted/)
})

test('learning permits no-op and reference-only episodes, rejects assistant-only and invented evidence', () => {
  const window = rawWindow('/repo')
  expect(parseLearning('{"episodes":[]}', window, [])).toEqual({ episodes: [], proposals: [] })
  const output = learningOutput(window)
  output.episodes[0]!.proposals = []
  expect(parseLearning(JSON.stringify(output), window, []).episodes).toHaveLength(1)
  const invalid = learningOutput(window)
  invalid.episodes[0]!.proposals[0]!.sourceEntryIds = ['unknown']
  expect(() => parseLearning(JSON.stringify(invalid), window, [])).toThrow(/source/)
  expect(() => parseLearning('{"episodes":[],"extra":true}', window, [])).toThrow()
})

test('project learning accepts directory identities, rejects implementation paths and long technical recaps', () => {
  const window = rawWindow('/repo')
  const output = learningOutput(window, ['Atlas 是 Rust 日志查看 CLI；用户仅做过一次审查。'], 'project')
  expect(parseLearning(JSON.stringify(output), window, []).proposals[0]!.kind).toBe('project')
  for (const content of ['入口在 src/main/features/memory/long-term/extension.ts', '存储实现见 store.ts', '项目身份'.repeat(100)]) {
    output.episodes[0]!.proposals[0]!.content = content
    expect(() => parseLearning(JSON.stringify(output), window, [])).toThrow(/profile/)
  }
})

test('inferred preferences need multiple direct user signals; successful tools do not prove user preference', () => {
  const window = rawWindow('/repo')
  const output = learningOutput(window, ['默认 Bun'], 'preference')
  const proposal = output.episodes[0]!.proposals[0]!
  Object.assign(proposal, { assertion: 'inferred-preference' })
  expect(() => parseLearning(JSON.stringify(output), window, [])).toThrow(/signals/)
  Object.assign(proposal, { assertion: 'tool-verified', sourceEntryIds: ['t1'] })
  expect(() => parseLearning(JSON.stringify(output), window, [])).toThrow(/preference/)
})
