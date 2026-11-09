import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { LongTermFact } from '../src/shared/long-term-memory'
import type { Entry } from '../src/main/features/memory/session-ledger/types'
import { parseSelection, recallQuestion } from '../src/main/features/memory/long-term/relevance'

const fact = (id: string): LongTermFact => ({ id, content: 'Pig embeds the pi SDK.', kind: 'decision', scope: 'project',
  scopeKey: '/repo', status: 'active', assertion: 'user-statement', sourceTime: '', createdAt: '' })
const message = (id: string, role: string, content: unknown, stopReason?: string): Entry => ({
  id, type: 'message', message: { role, content, ...(stopReason ? { stopReason } : {}) },
})
const reply = (id: string, text: string): Entry => message(id, 'assistant', [{ type: 'text', text }], 'stop')

test('recall selector accepts only distinct supplied IDs, including no selection, without rewriting facts', () => {
  const facts = [fact('one'), fact('two')]
  assert.deepEqual(parseSelection('{"selectedIds":[]}', facts), [])
  const selected = parseSelection('{"selectedIds":["two","one"]}', facts)
  assert.equal(selected[0], facts[1])
  assert.equal(selected[1], facts[0])
  for (const output of ['not JSON', '{"selectedIds":["other"]}', '{"selectedIds":["one","one"]}',
    '{"selectedIds":["one"],"rewritten":"invented"}', '{"selectedIds":"one"}',
    '{"selectedIds":["one","one","one","one","one","one"]}']) {
    assert.throws(() => parseSelection(output, facts))
  }
})

test('recall question keeps the full question and only two recent successful visible exchanges', () => {
  const entries: Entry[] = [
    message('u0', 'user', 'Old topic'), reply('a0', 'Old answer'),
    message('failed-user', 'user', 'Failed question'), message('failed', 'assistant', [{ type: 'text', text: 'Failed answer' }], 'error'),
    message('u1', 'user', 'How is Pig distributed?'),
    message('tool-call', 'assistant', [{ type: 'text', text: 'Intermediate' }, { type: 'toolCall', name: 'read' }], 'toolUse'),
    message('tool-result', 'toolResult', [{ type: 'text', text: 'Untrusted tool output' }]),
    { id: 'hidden', type: 'custom_message', content: 'Previously injected memory' },
    { id: 'summary', type: 'branch_summary', summary: 'Branch memory' },
    reply('a1', 'An application that embeds an SDK.'),
    message('u2', 'user', [{ type: 'text', text: 'What dependencies?' }, { type: 'image', data: 'image-secret' }]),
    message('a2', 'assistant', [{ type: 'thinking', thinking: 'hidden reasoning' }, { type: 'text', text: 'Discuss installation dependencies.' }], 'stop'),
    message('current', 'user', '是否需要本地有 pi'), reply('later', 'Should not be background'),
  ]
  const question = '完整问题'.repeat(1000)
  const result = recallQuestion(entries, 'current', question)
  assert.equal(result.question, question)
  assert.deepEqual(result.recentExchanges, [
    { user: 'How is Pig distributed?', assistant: 'An application that embeds an SDK.' },
    { user: 'What dependencies?', assistant: 'Discuss installation dependencies.' },
  ])
})

test('recall history excerpts are bounded and interrupted turns cannot borrow a later reply', () => {
  const result = recallQuestion([
    message('u0', 'user', 'Interrupted question'), message('a0', 'assistant', [], 'aborted'), reply('late', 'Unpaired'),
    message('u1', 'user', '长'.repeat(10_000)), reply('a1', '答'.repeat(10_000)), message('current', 'user', 'Now'),
  ], 'current', 'Now')
  assert.equal(result.recentExchanges.length, 1)
  assert.ok(result.recentExchanges[0]!.user.length < 1100)
  assert.ok(result.recentExchanges[0]!.assistant.length < 1100)
  assert.match(result.recentExchanges[0]!.user, /excerpt omitted/)
})
