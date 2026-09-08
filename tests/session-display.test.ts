import { beforeAll, describe, expect, test } from 'bun:test'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { pastedTextFingerprint } from '../src/shared/pasted-text'

let displayTurnsFromEntries: typeof import('../src/main/pi/session-display-model')['displayTurnsFromEntries']

beforeAll(async () => {
  ({ displayTurnsFromEntries } = await import('../src/main/pi/session-display-model'))
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

    const [turn] = displayTurnsFromEntries(entries)
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

    const [turn] = displayTurnsFromEntries(entries)
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

    const [turn] = displayTurnsFromEntries(entries)
    expect(turn.user?.text).toBe('a'.repeat(2001))
    expect(turn.user?.textAttachments).toEqual([])
  })
})
