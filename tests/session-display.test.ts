import { beforeAll, describe, expect, test } from 'bun:test'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { pastedTextFingerprint } from '../src/shared/pasted-text'

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
