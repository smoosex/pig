import { beforeAll, describe, expect, test } from 'bun:test'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { pastedTextFingerprint } from '../src/shared/pasted-text'
import { buildTurn, type ProcessItem } from '../src/renderer/src/chat/turns'
import { toTurn } from '../src/renderer/src/chat/display-turns'

let displayTurnsFromEntries: typeof import('../src/main/pi/session-display-model')['displayTurnsFromEntries']
let turnMessagesFromEntries: typeof import('../src/main/pi/session-display-model')['turnMessagesFromEntries']
let turnMessagesByIdFromEntries: typeof import('../src/main/pi/session-display-model')['turnMessagesByIdFromEntries']

beforeAll(async () => {
  ({
    displayTurnsFromEntries,
    turnMessagesFromEntries,
    turnMessagesByIdFromEntries
  } = await import('../src/main/pi/session-display-model'))
})

test('loading one turn stops reading entries after its next user boundary', () => {
  const entry = (id: string, role: string) => ({
    type: 'message', id, parentId: null, timestamp: '2026-01-01T00:00:00.000Z',
    message: { role, content: id, timestamp: 1 }
  })
  const later = entry('later-answer', 'assistant')
  Object.defineProperty(later, 'message', { get: () => { throw new Error('Unrelated history was projected') } })
  const entries = [entry('first', 'user'), entry('answer', 'assistant'), entry('second', 'user'), later] as unknown as SessionEntry[]
  expect(turnMessagesFromEntries(entries, 'answer').map((message) => (message as { content: string }).content)).toEqual(['first', 'answer'])
})

test('the turn message index accepts every entry id in a turn', () => {
  const entry = (id: string, role: string) => ({
    type: 'message', id, parentId: null, timestamp: '2026-01-01T00:00:00.000Z',
    message: { role, content: id, timestamp: 1 }
  })
  const entries = [entry('first', 'user'), entry('answer', 'assistant')] as unknown as SessionEntry[]
  const indexed = turnMessagesByIdFromEntries(entries)
  expect(indexed.get('answer')).toBe(indexed.get('first'))
  expect(indexed.get('answer')?.map((message) => (message as { content: string }).content)).toEqual(['first', 'answer'])
})

test('a turn sums usage over its model calls and ends at its last visible entry', () => {
  const entry = (id: string, message: Record<string, unknown>) => ({
    type: 'message', id, parentId: null, timestamp: '2026-01-01T00:00:00.000Z', message: { timestamp: 1, ...message }
  })
  const usage = (input: number, output: number, cacheRead: number, cacheWrite: number) =>
    ({ input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite })
  const entries = [
    entry('ask', { role: 'user', content: '问题' }),
    entry('call', { role: 'assistant', content: [{ type: 'toolCall', id: 'c', name: 'read', arguments: {} }], usage: usage(10, 5, 90, 0) }),
    entry('result', { role: 'toolResult', toolCallId: 'c', content: [{ type: 'text', text: 'ok' }] }),
    entry('reply', { role: 'assistant', content: [{ type: 'text', text: '回答' }], usage: usage(20, 7, 100, 30) }),
    { type: 'label', id: 'label', parentId: 'reply', timestamp: '2026-01-01T00:00:00.000Z', targetId: 'reply', label: 'x' },
    entry('next', { role: 'user', content: '下一个' })
  ] as unknown as SessionEntry[]
  const [first, second] = displayTurnsFromEntries('s', entries)
  expect(first.lastEntryId).toBe('reply')
  expect(first.usage).toEqual({ input: 30, output: 12, cacheRead: 190, cacheWrite: 30, total: 262, calls: 2 })
  expect(second.lastEntryId).toBe('next')
  expect(second.usage).toBeUndefined()
})

test('system context before the next prompt does not extend completed work in either projection', () => {
  const entry = (id: string, role: string, timestamp: number, persistedAt = timestamp) => ({
    type: 'message', id, parentId: null, timestamp: new Date(persistedAt).toISOString(),
    message: {
      role, timestamp,
      ...(role === 'toolResult' ? { toolCallId: id, toolName: 'read', isError: false } : {}),
      content: role === 'assistant' || role === 'toolResult' ? [{ type: 'text', text: id }] : id
    }
  })
  for (const withTools of [false, true]) {
    const entries = [
      entry('ask', 'user', 1_000),
      ...(withTools ? [
        entry('call', 'assistant', 1_010, 2_000),
        entry('result', 'toolResult', 3_000),
        entry('call-again', 'assistant', 3_010, 4_000),
        entry('result-again', 'toolResult', 5_000)
      ] : []),
      entry('reply', 'assistant', 5_010, 6_000),
      entry('context', 'system', 20_000_000),
      entry('next', 'user', 20_000_001)
    ] as unknown as SessionEntry[]
    const [display] = displayTurnsFromEntries('s', entries)
    const messages = turnMessagesFromEntries(entries, 'ask') as Parameters<typeof buildTurn>[0]
    const process = buildTurn(messages, false)
    expect(messages.at(-1)?.role).toBe('system')
    expect(display.startedAt).toBe(withTools ? 1_010 : 5_010)
    expect(display.endedAt).toBe(6_000)
    expect(process.startedAt).toBe(display.startedAt)
    expect(process.endedAt).toBe(display.endedAt)
  }
})

test('leading system context does not move the work start before actual execution', () => {
  const entries = [
    { type: 'message', id: 'context', parentId: null, timestamp: new Date(1_000).toISOString(), message: { role: 'system', content: 'context', timestamp: 1_000 } },
    { type: 'message', id: 'reply', parentId: 'context', timestamp: new Date(20_000_000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }], timestamp: 19_999_000 } }
  ] as unknown as SessionEntry[]
  const [display] = displayTurnsFromEntries('s', entries)
  const process = buildTurn(turnMessagesFromEntries(entries, 'context') as Parameters<typeof buildTurn>[0], false)
  expect(display.startedAt).toBe(19_999_000)
  expect(display.endedAt).toBe(20_000_000)
  expect(process.startedAt).toBe(display.startedAt)
  expect(process.endedAt).toBe(display.endedAt)
})

test('a damaged usage record fails the projection instead of counting as zero', () => {
  const entries = [
    { type: 'message', id: 'ask', parentId: null, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: '问题', timestamp: 1 } },
    {
      type: 'message', id: 'reply', parentId: 'ask', timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: '回答' }], timestamp: 1, usage: { input: 1, output: '2', cacheRead: 0, cacheWrite: 0 } }
    }
  ] as unknown as SessionEntry[]
  expect(() => displayTurnsFromEntries('s', entries)).toThrow('Invalid assistant usage: output is 2')
})

test('loading one turn ships no image bytes for the process panel', () => {
  const entries = [
    {
      type: 'message',
      id: 'shot',
      parentId: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image', mimeType: 'image/png', data: 'QUJD' }
        ],
        timestamp: 1
      }
    },
    {
      type: 'message',
      id: 'answer',
      parentId: 'shot',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: '好' }], timestamp: 2 }
    }
  ] as unknown as SessionEntry[]

  const messages = turnMessagesFromEntries(entries, 'shot') as Array<{ content: unknown }>
  expect(messages[0].content).toEqual([{ type: 'text', text: '看图' }])
  expect(messages[1].content).toEqual([{ type: 'text', text: '好' }])
  expect(JSON.stringify(messages)).not.toContain('QUJD')
})

test('stored image notes stay in the entry but not in turns or process previews', () => {
  const hint = '[Image: original 2992x1868, displayed at 2000x1249. Multiply coordinates by 1.50 to map to original image.]'
  const text = `看图\n\n${hint}`
  const entries = [{
    type: 'message', id: 'shot', parentId: null, timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      role: 'user',
      content: [{ type: 'text', text }, { type: 'image', mimeType: 'image/png', data: 'QUJD' }],
      timestamp: 1
    }
  }] as unknown as SessionEntry[]

  expect(displayTurnsFromEntries('session-1', entries)[0].user?.text).toBe('看图')
  expect(turnMessagesFromEntries(entries, 'shot')).toMatchObject([{ content: [{ type: 'text', text: '看图' }] }])
  expect(turnMessagesByIdFromEntries(entries).get('shot')).toMatchObject([{ content: [{ type: 'text', text: '看图' }] }])
  expect((entries[0] as { message: { content: Array<{ text?: string }> } }).message.content[0].text).toBe(text)
})

test('a turn that carries nothing but a compaction has no work of its own', () => {
  const entries = [
    {
      type: 'message',
      id: 'user',
      parentId: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: '问', timestamp: 1 }
    },
    {
      type: 'compaction',
      id: 'k0',
      parentId: 'user',
      timestamp: '2026-01-01T00:00:01.000Z',
      summary: '压缩了',
      tokensBefore: 42
    }
  ] as unknown as SessionEntry[]

  const [turn] = displayTurnsFromEntries('session-1', entries)
  expect(turn.compactions).toEqual([
    { text: '压缩了', tokensBefore: 42, afterAnswer: true, workMsBefore: 0, durationMs: 1_000 }
  ])
  // The landmark is not the disclosure's reason to exist: no work behind it means no work header.
  expect(turn.hasProcess).toBe(false)
  expect(turn.workBlocks).toEqual([false])
})

test('review branch summaries travel with the projection without inventing work', () => {
  for (const withAnswer of [false, true]) {
    const entries = [
      {
        type: 'message', id: 'user', parentId: null, timestamp: new Date(1_000).toISOString(),
        message: { role: 'user', content: 'question', timestamp: 1_000 }
      },
      ...(withAnswer ? [{
        type: 'message', id: 'answer', parentId: 'user', timestamp: new Date(2_000).toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }], timestamp: 2_000 }
      }] : []),
      {
        type: 'branch_summary', id: 'handoff', parentId: withAnswer ? 'answer' : 'user',
        timestamp: new Date(3_000).toISOString(), summary: '## Review findings\n\nFix the return race.', fromId: 'review'
      }
    ] as unknown as SessionEntry[]
    const [display] = displayTurnsFromEntries('session', entries)
    const loaded = buildTurn(turnMessagesFromEntries(entries, display.id) as Parameters<typeof buildTurn>[0], false)
    expect(display.branchSummaries).toEqual([{ text: '## Review findings\n\nFix the return race.', afterAnswer: true, compactionsBefore: 0 }])
    expect(loaded.branchSummaries).toEqual(display.branchSummaries)
    expect(display.hasProcess).toBe(false)
    expect(display.workBlocks).toEqual([false])
    expect(loaded.process).toEqual([])
    expect(loaded.hasProcess).toBe(false)
    expect(display.answer).toEqual(withAnswer ? [{ type: 'text', text: 'final answer' }] : [])
  }
})

test('historical process loading keeps text before a branch summary out of the final answer', () => {
  for (const content of [[{ type: 'text' as const, text: 'answer B' }], []]) {
    const entries = [
      {
        type: 'message', id: 'user', parentId: null, timestamp: new Date(1_000).toISOString(),
        message: { role: 'user', content: 'question', timestamp: 1_000 }
      },
      {
        type: 'message', id: 'before', parentId: 'user', timestamp: new Date(2_000).toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: 'reply A' }], timestamp: 2_000 }
      },
      {
        type: 'branch_summary', id: 'handoff', parentId: 'before', timestamp: new Date(3_000).toISOString(),
        summary: 'review handoff', fromId: 'review'
      },
      {
        type: 'message', id: 'after', parentId: 'handoff', timestamp: new Date(4_000).toISOString(),
        message: { role: 'assistant', content, timestamp: 4_000 }
      }
    ] as unknown as SessionEntry[]
    const [display] = displayTurnsFromEntries('session', entries)
    const loaded = buildTurn(turnMessagesFromEntries(entries, display.id) as Parameters<typeof buildTurn>[0], false)
    expect(loaded.process).toEqual([{ kind: 'text', text: 'reply A' }])
    expect(loaded.answer).toEqual(content)
    expect(display.workBlocks).toEqual([true])
    const historical = toTurn(display, loaded.process)
    expect(historical.process).toEqual([{ kind: 'text', text: 'reply A' }])
    expect(historical.answer).toEqual(content)
  }
})

describe('work layout before process loading', () => {
  const message = (id: string, time: number, content: unknown, role = 'assistant', errorMessage?: string) => ({
    type: 'message', id, parentId: null, timestamp: new Date(time).toISOString(),
    message: { role, content, timestamp: time, errorMessage }
  }) as unknown as SessionEntry
  const compaction = (id: string, time: number) => ({
    type: 'compaction', id, parentId: null, timestamp: new Date(time).toISOString(),
    summary: id, tokensBefore: 42
  }) as unknown as SessionEntry
  const user = message('user', 1_000, 'question', 'user')
  const before = message('before', 2_000, [{ type: 'thinking', thinking: 'before' }])
  const after = message('after', 5_000, [{ type: 'thinking', thinking: 'after' }])
  const answer = message('answer', 6_000, [{ type: 'text', text: 'final answer' }])

  test('projects both work blocks and preserves empty intervals between compactions', () => {
    for (const [entries, expected] of [
      [[user, before, compaction('k1', 3_000), after, answer], [true, true]],
      [[user, before, compaction('k1', 3_000), compaction('k2', 4_000), after, answer, compaction('tail', 7_000)], [true, false, true]]
    ] as Array<[SessionEntry[], boolean[]]>) {
      const [turn] = displayTurnsFromEntries('session', entries)
      expect(turn.workBlocks).toEqual(expected)
      expect(turn.answer).toEqual([{ type: 'text', text: 'final answer' }])
    }
  })

  test('does not invent work before compaction or after it when only a final answer follows', () => {
    for (const [entries, expected] of [
      [[user, before, compaction('k1', 3_000), answer], [true, false]],
      [[user, compaction('k1', 3_000), after, answer], [false, true]],
      [[user, compaction('k1', 3_000), answer], [false, false]]
    ] as Array<[SessionEntry[], boolean[]]>) {
      expect(displayTurnsFromEntries('session', entries)[0].workBlocks).toEqual(expected)
    }
  })

  test('matches loaded text aggregation when a partial-text error is retried after compaction', () => {
    const partial = [{ type: 'text', text: 'partial reply  ' }]
    for (const [content, expectedBlocks, expectedProcess] of [
      [[{ type: 'text', text: 'final answer' }], [true, false], ['thinking', 'compaction']],
      [[{ type: 'thinking', thinking: 'retry work' }, { type: 'text', text: 'final answer' }], [true, true], ['thinking', 'compaction', 'text', 'thinking']]
    ] as Array<[unknown[], boolean[], ProcessItem['kind'][]]>) {
      const entries = [user, before, compaction('k1', 3_000), message('failed', 4_000, partial, 'assistant', 'overloaded'), message('answer', 6_000, content)]
      const [display] = displayTurnsFromEntries('session', entries)
      const loaded = buildTurn(turnMessagesFromEntries(entries, display.id) as Parameters<typeof buildTurn>[0], false)
      expect(display.workBlocks).toEqual(expectedBlocks)
      expect(loaded.process.map((item) => item.kind)).toEqual(expectedProcess)
      expect(display.answer).toEqual([{ type: 'text', text: 'final answer' }])
      expect(display.errorMessage).toBeUndefined()
      expect(entries[3]).toMatchObject({ message: { content: partial, errorMessage: 'overloaded' } })
    }
  })
})

test('a retried failure is no longer the outcome once an answer followed it', () => {
  const entries = [
    {
      type: 'message',
      id: 'user',
      parentId: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: '问', timestamp: 1 }
    },
    {
      type: 'message',
      id: 'failed',
      parentId: 'user',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'assistant', content: [], errorMessage: 'overloaded', timestamp: 2 }
    },
    {
      type: 'message',
      id: 'retried',
      parentId: 'failed',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: '回答' }], timestamp: 3 }
    }
  ] as unknown as SessionEntry[]

  const [turn] = displayTurnsFromEntries('session-1', entries)
  expect(turn.answer).toEqual([{ type: 'text', text: '回答' }])
  expect(turn.errorMessage).toBeUndefined()
})

describe('session display pasted text metadata', () => {
  test('restores attachment cards from the custom entry before a user message', () => {
    const entries = [
      {
        type: 'custom',
        id: 'meta',
        parentId: null,
        timestamp: '2026-01-01T00:00:00.000Z',
        customType: 'pig.pasted-text',
        data: {
          version: 1,
          bodyLength: 2,
          contentLength: 7,
          contentHash: pastedTextFingerprint('正文\n\n长文本'),
          attachments: [{ id: 'pasted-1', start: 4, end: 7, byteSize: 9 }]
        }
      },
      {
        type: 'message',
        id: 'user',
        parentId: 'meta',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '正文\n\n长文本' }],
          timestamp: 1
        }
      },
      {
        type: 'message',
        id: 'assistant',
        parentId: 'user',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '回答' }],
          timestamp: 2
        }
      }
    ] as unknown as SessionEntry[]

    const [turn] = displayTurnsFromEntries('session-1', entries)
    expect(turn.user?.text).toBe('正文')
    expect(turn.user?.textAttachments).toEqual([
      { id: 'pasted-1', text: '长文本', byteSize: 9 }
    ])
    expect(turn.answer).toEqual([{ type: 'text', text: '回答' }])
  })

  test('restores inline attachment segments from version 2 metadata', () => {
    const content = '前文附件后文'
    const entries = [
      {
        type: 'custom',
        id: 'meta-v2',
        parentId: null,
        timestamp: '2026-01-01T00:00:00.000Z',
        customType: 'pig.pasted-text',
        data: {
          version: 2,
          contentLength: content.length,
          contentHash: pastedTextFingerprint(content),
          attachments: [{ id: 'pasted-2', start: 2, end: 4, byteSize: 6, filename: 'pasted_text.txt' }]
        }
      },
      {
        type: 'message',
        id: 'user-v2',
        parentId: 'meta-v2',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'user', content, timestamp: 1 }
      }
    ] as unknown as SessionEntry[]

    const [turn] = displayTurnsFromEntries('session-1', entries)
    expect(turn.user?.textSegments).toEqual([
      { type: 'text', text: '前文' },
      {
        type: 'attachment',
        attachment: { id: 'pasted-2', text: '附件', byteSize: 6, filename: 'pasted_text.txt' }
      },
      { type: 'text', text: '后文' }
    ])
  })

  test('keeps inline pasted-text attachments when an image hint is appended by the SDK', () => {
    const content = '前文附件后文'
    const hint = '[Image: original 2992x1868, displayed at 2000x1249. Multiply coordinates by 1.50 to map to original image.]'
    const entries = [
      {
        type: 'custom', id: 'meta', parentId: null, timestamp: '2026-01-01T00:00:00.000Z',
        customType: 'pig.pasted-text',
        data: {
          version: 2,
          contentLength: content.length,
          contentHash: pastedTextFingerprint(content),
          attachments: [{ id: 'paste', start: 2, end: 4, byteSize: 6 }]
        }
      },
      {
        type: 'message', id: 'user', parentId: 'meta', timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: `${content}\n\n${hint}` }, { type: 'image', mimeType: 'image/png', data: 'QUJD' }],
          timestamp: 1
        }
      }
    ] as unknown as SessionEntry[]

    const [turn] = displayTurnsFromEntries('session-1', entries)
    expect(turn.user?.text).toBe(content)
    expect(turn.user?.textSegments).toEqual([
      { type: 'text', text: '前文' },
      { type: 'attachment', attachment: { id: 'paste', text: '附件', byteSize: 6 } },
      { type: 'text', text: '后文' }
    ])
  })

  test('does not infer attachments for old long messages', () => {
    const entries = [{
      type: 'message',
      id: 'old-user',
      parentId: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: {
        role: 'user',
        content: 'a'.repeat(2001),
        timestamp: 1
      }
    }] as unknown as SessionEntry[]

    const [turn] = displayTurnsFromEntries('session-1', entries)
    expect(turn.user?.text).toBe('a'.repeat(2001))
    expect(turn.user?.textAttachments).toEqual([])
  })

  test('projects image blocks as URLs instead of inline bytes', () => {
    const entries = [
      {
        type: 'message',
        id: 'user-with-shot',
        parentId: null,
        timestamp: '2026-01-01T00:00:00.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '看图' },
            { type: 'image', mimeType: 'image/png', data: 'QUJD' },
            { type: 'image', mimeType: 'image/svg+xml;charset=utf-8', data: 'REVG' }
          ],
          timestamp: 1
        }
      },
      {
        type: 'message',
        id: 'answer-with-chart',
        parentId: 'user-with-shot',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'image', mimeType: 'image/jpeg', data: 'REVG' }],
          timestamp: 2
        }
      }
    ] as unknown as SessionEntry[]

    const [turn] = displayTurnsFromEntries('session-1', entries)
    expect(turn.user?.images).toEqual([
      { mimeType: 'image/png', url: 'pig-image://session/session-1/user-with-shot/1' },
      // The served type is the parameter-free base type; the display has to report the same one.
      { mimeType: 'image/svg+xml', url: 'pig-image://session/session-1/user-with-shot/2' }
    ])
    expect(turn.answer).toEqual([
      { type: 'image', mimeType: 'image/jpeg', url: 'pig-image://session/session-1/answer-with-chart/0' }
    ])
    // The payload contract: no base64 reaches the renderer with the turn.
    expect(JSON.stringify(turn)).not.toContain('QUJD')
    expect(JSON.stringify(turn)).not.toContain('REVG')
  })

  test('projects no image URL for a block the reader would reject', () => {
    const entries = [
      {
        type: 'message',
        id: 'blank-image',
        parentId: null,
        timestamp: '2026-01-01T00:00:00.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '看图' },
            { type: 'image', mimeType: 'image/png', data: '' },
            { type: 'image', mimeType: '', data: 'QUJD' }
          ],
          timestamp: 1
        }
      }
    ] as unknown as SessionEntry[]

    const [turn] = displayTurnsFromEntries('session-1', entries)
    expect(turn.user?.images).toEqual([])
  })
})
