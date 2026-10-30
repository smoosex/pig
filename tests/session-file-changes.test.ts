import { expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai'
import { summarizeSessionFileChanges } from '../src/main/pi/session-file-changes'

const cwd = resolve('/workspace')
function entry(id: string, message: Extract<SessionEntry, { type: 'message' }>['message']): SessionEntry {
  return { type: 'message', id, parentId: null, timestamp: '2026-01-01T00:00:00Z', message }
}
const user = (id: string) => entry(id, { role: 'user', content: 'change files', timestamp: 0 })
function call(id: string, name = 'edit', args: Record<string, string> = { path: 'a.ts' }): SessionEntry {
  const message: AssistantMessage = {
    role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }],
    api: 'openai-responses', provider: 'openai', model: 'test', stopReason: 'toolUse', timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
  }
  return entry(`call-${id}`, message)
}
function result(id: string, extra: Partial<ToolResultMessage> = {}): SessionEntry {
  return entry(`result-${id}`, { role: 'toolResult', toolCallId: id, toolName: 'edit',
    isError: false, content: [], timestamp: 0, ...extra })
}
const patch = '--- a.ts\n+++ a.ts\n@@ -1,2 +1,3 @@\n---old\n+++new\n+second\n context\n\\ No newline at end of file\n+outside hunk'

test('counts only hunk lines, prefers patch, and accumulates operations rather than net changes', () => {
  const entries = [user('t1'), call('1'), result('1', { details: { patch, diff: '+1 wrong' } }),
    user('t2'), call('2', 'edit', { path: './sub/../a.ts' }),
    result('2', { details: { patch: '@@ -1,2 +1 @@\n-old\n-other\n+new' } }), user('empty')]
  const before = JSON.stringify(entries)
  const summary = summarizeSessionFileChanges(entries, cwd)
  expect(summary.files).toHaveLength(1)
  expect(summary.files[0]).toMatchObject({ path: resolve(cwd, 'a.ts'), added: 3, removed: 3, unknownOperations: 0 })
  expect(summary.files[0]?.operations.map((op) => op.id)).toEqual(['1', '2'])
  expect(summary.turns.t1?.[0]?.added).toBe(2)
  expect(summary.turns.t2?.[0]?.removed).toBe(2)
  expect(summary.turns.empty).toEqual([])
  expect(JSON.stringify(entries)).toBe(before)
})

test('requires matching successful results; pairs by id and assigns to the calling turn', () => {
  const entries = [user('first'), call('a'), call('failed'), call('missing'), call('wrong'),
    user('next'), result('a', { details: { diff: '- 12 old\n+ 12 new\n+ 13 more\n  14 context\n    ...' } }),
    result('a'), result('failed', { isError: true }), result('orphan'),
    result('wrong', { toolName: 'write' })]
  const summary = summarizeSessionFileChanges(entries, cwd)
  expect(summary.files[0]).toMatchObject({ added: 2, removed: 1, unknownOperations: 0 })
  expect(summary.files[0]?.operations).toHaveLength(1)
  expect(summary.turns.first).toHaveLength(1)
  expect(summary.turns.next).toEqual([])
})

test('write counts its whole content as added; missing or malformed edit diffs are unknown', () => {
  const summary = summarizeSessionFileChanges([user('t'), call('w', 'write', { path: '@a.ts', content: 'one\ntwo\n' }),
    result('w', { toolName: 'write' }), call('e'), result('e'), call('bad'),
    result('bad', { details: { patch: '@@ -1 +1 @@\n-old', diff: '+1 not a fallback' } })], cwd)
  expect(summary.files[0]).toMatchObject({ added: 2, removed: 0, unknownOperations: 2 })
  expect(summary.files[0]?.operations[0]?.patch).toContain('@@ -0,0 +1,2 @@\n+one\n+two\n')
  const bare = summarizeSessionFileChanges([user('t'), call('w', 'write', { path: 'b.ts', content: 'x' }), result('w', { toolName: 'write' })], cwd)
  expect(bare.files[0]).toMatchObject({ added: 1, removed: 0, unknownOperations: 0 })
})

test('nested successful calls are unknown even if the parent fails; missing arguments are not guessed', () => {
  const summary = summarizeSessionFileChanges([user('t'), call('parent', 'codemode', {}), result('parent', {
    toolName: 'codemode', isError: true, nestedCalls: { complete: false, calls: [
      { id: 'n1', name: 'write', status: 'ok', arguments: { path: 'a.ts' } },
      { id: 'n2', name: 'edit', status: 'ok', arguments: { path: './a.ts' } },
      { id: 'n3', name: 'edit', status: 'error', arguments: { path: 'a.ts' } },
      { id: 'n4', name: 'edit', status: 'unfinished', arguments: { path: 'a.ts' } },
      { id: 'n5', name: 'write', status: 'ok', argumentsBytes: 100 },
      { id: 'n6', name: 'read', status: 'ok', arguments: { path: 'b.ts' } },
      { id: 'n7', name: 'edit', status: 'ok', arguments: {} }
    ] }
  })], cwd)
  expect(summary.files).toHaveLength(1)
  expect(summary.files[0]?.unknownOperations).toBe(2)
  expect(summary.files[0]?.operations.map((op) => op.id)).toEqual(['n1', 'n2'])
})

test('normalizes tilde, at prefix, absolute paths and unicode spaces without filesystem reads', () => {
  const summary = summarizeSessionFileChanges([
    call('home', 'write', { path: '@~/missing/../file.ts' }), result('home', { toolName: 'write' }),
    call('absolute', 'write', { path: resolve(homedir(), 'file.ts') }), result('absolute', { toolName: 'write' }),
    call('spaces', 'edit', { path: 'a\u00a0b.ts' }), result('spaces')
  ], cwd)
  expect(summary.files.map((file) => file.path)).toEqual([resolve(homedir(), 'file.ts'), resolve(cwd, 'a b.ts')])
  expect(summary.files[0]?.unknownOperations).toBe(2)
  // Edits before any user message belong to the leading group the conversation shows.
  expect(Object.keys(summary.turns)).toEqual(['call-home'])
  expect(summary.turns['call-home']).toHaveLength(2)
})

test('a `!cmd` opens its own turn, as the conversation groups it', () => {
  const bash = entry('bash', { role: 'bashExecution', command: 'ls', output: '', exitCode: 0, cancelled: false,
    truncated: false, timestamp: 0 })
  const summary = summarizeSessionFileChanges([user('t'), call('1'), result('1', { details: { patch } }),
    bash, call('2'), result('2', { details: { patch } })], cwd)
  expect(summary.turns.t?.[0]?.operations.map((op) => op.id)).toEqual(['1'])
  expect(summary.turns.bash?.[0]?.operations.map((op) => op.id)).toEqual(['2'])
})

test('handles multiple hunks, zero counts, and raw operations before compaction', () => {
  const entries: SessionEntry[] = [user('t'), call('e'), result('e', { details: {
    patch: '--- a\n+++ a\n@@ -0,0 +1,2 @@\n+a\n+b\n@@ -9 +11,0 @@\n-c'
  } }), { type: 'compaction', id: 'compact', parentId: null, timestamp: '',
    summary: 'summary', firstKeptEntryId: 'compact', tokensBefore: 100 }]
  expect(summarizeSessionFileChanges(entries, cwd).files[0]).toMatchObject({ added: 2, removed: 1, unknownOperations: 0 })
  expect(summarizeSessionFileChanges([], cwd)).toEqual({ files: [], turns: {} })
})
