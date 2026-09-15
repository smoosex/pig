import { describe, expect, test } from 'bun:test'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { normalizeSessionPrompt } from '../src/main/pi/prompt-input'
import { sessionTreeRows } from '../src/main/pi/session-tree'
import type { SessionSource } from '../src/main/pi/session-source'

describe('prompt input projection', () => {
  test('inline attachments are sent once and excluded from branch naming', () => {
    const prompt = normalizeSessionPrompt({
      text: '前文附件后文',
      textAttachments: [{ id: 'paste', text: '附件', start: 2, end: 4, byteSize: 100 }]
    })
    expect(prompt.modelText).toBe('前文附件后文')
    expect(prompt.metadata?.version).toBe(2)
    expect(prompt.metadata?.attachments[0].byteSize).toBe(6)
    expect(prompt.namingText).toBe('前文后文')
    expect(prompt.displayMetadata?.segments?.map((segment) => segment.type)).toEqual([
      'text', 'attachment', 'text'
    ])
  })

  test('invalid attachment offsets fall back to appended text and ignore malformed inputs', () => {
    const prompt = normalizeSessionPrompt({
      text: '正文',
      textAttachments: [null, { text: '' }, { id: 'paste', text: '附件', start: -1, end: 50 }],
      images: [
        null,
        { mimeType: 'text/plain', data: 'aGVsbG8=' },
        { mimeType: 'image/png', data: 'data:image/png;base64,aGVsbG8=' }
      ]
    })
    expect(prompt.modelText).toBe('正文\n\n附件')
    expect(prompt.metadata?.version).toBe(1)
    expect(prompt.metadata?.attachments).toEqual([{ id: 'paste', start: 4, end: 6, byteSize: 6 }])
    expect(prompt.images).toEqual([{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }])
    expect(prompt.namingText).toBe('正文')
  })

  test('keeps the image types the reader can serve and drops what it cannot', () => {
    const prompt = normalizeSessionPrompt({
      text: '看图',
      images: [
        { mimeType: 'image/svg+xml;charset=utf-8', data: 'QUJD' },
        { mimeType: 'image/png', data: 'data:image/png;base64,' },
        { mimeType: 'application/octet-stream', data: 'QUJD' },
        // A data URL whose payload is not base64 would become a URL that always 404s.
        { mimeType: 'image/png', data: 'data:image/svg+xml,%3Csvg%3E' },
        { mimeType: 'image/png', data: 'QUJDQ' }
      ]
    })
    expect(prompt.images).toEqual([
      { type: 'image', mimeType: 'image/svg+xml;charset=utf-8', data: 'QUJD' }
    ])
  })
})

describe('session tree projection', () => {
  test('collapses bookkeeping ancestry while keeping tool calls and active branch order', () => {
    const entries = [
      { id: 'user', parentId: null, type: 'message', message: { role: 'user', content: '问题' } },
      { id: 'alternate', parentId: 'user', type: 'message', message: { role: 'assistant', content: '另一个答案' } },
      { id: 'meta', parentId: 'user', type: 'custom' },
      {
        id: 'call',
        parentId: 'meta',
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'read-call', name: 'read', arguments: { path: 'src/main.ts' } }]
        }
      },
      { id: 'result', parentId: 'call', type: 'message', message: { role: 'toolResult', toolCallId: 'read-call' } }
    ] as unknown as SessionEntry[]
    const source: SessionSource = {
      sessionId: 'session-1',
      leafId: () => 'result',
      entries: () => entries,
      treeEntries: () => entries,
      branch: () => ['user', 'meta', 'call', 'result'].map((id) => ({ id }) as SessionEntry),
      branchIds: () => ['user', 'meta', 'call', 'result']
    } as SessionSource
    const rows = sessionTreeRows(source)
    // Parsing the branch only to learn which entries are on it would make the tree as expensive as
    // the projection it deliberately avoids; the ids come from the index instead.
    expect(() => sessionTreeRows({
      ...source,
      branch: () => { throw new Error('branch() must not be called to collect ids') }
    })).not.toThrow()
    expect(rows.map((row) => row.id)).toEqual(['user', 'result', 'alternate'])
    expect(rows[1]).toMatchObject({ parentId: 'user', text: '[read: src/main.ts]', onPath: true, current: true })
    expect(rows[2]).toMatchObject({ parentId: 'user', onPath: false, current: false })
  })
})
