import { describe, expect, test } from 'bun:test'
import type { SessionManager } from '@earendil-works/pi-coding-agent'
import { normalizeSessionPrompt } from '../src/main/pi/prompt-input'
import { sessionTreeRows } from '../src/main/pi/session-tree'

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
})

describe('session tree projection', () => {
  test('collapses bookkeeping ancestry while keeping tool calls and active branch order', () => {
    const tree = [{
      entry: { id: 'user', type: 'message', message: { role: 'user', content: '问题' } },
      children: [
        {
          entry: { id: 'alternate', type: 'message', message: { role: 'assistant', content: '另一个答案' } },
          children: []
        },
        {
          entry: { id: 'meta', type: 'custom' },
          children: [{
            entry: {
              id: 'call',
              type: 'message',
              message: {
                role: 'assistant',
                content: [{ type: 'toolCall', id: 'read-call', name: 'read', arguments: { path: 'src/main.ts' } }]
              }
            },
            children: [{
              entry: { id: 'result', type: 'message', message: { role: 'toolResult', toolCallId: 'read-call' } },
              children: []
            }]
          }]
        }
      ]
    }]
    const before = JSON.stringify(tree)
    const manager = {
      getTree: () => tree,
      getLeafId: () => 'result',
      getBranch: () => ['user', 'meta', 'call', 'result'].map((id) => ({ id }))
    } as unknown as SessionManager
    const rows = sessionTreeRows(manager)
    expect(rows.map((row) => row.id)).toEqual(['user', 'result', 'alternate'])
    expect(rows[1]).toMatchObject({ parentId: 'user', text: '[read: src/main.ts]', onPath: true, current: true })
    expect(rows[2]).toMatchObject({ parentId: 'user', onPath: false, current: false })
    expect(JSON.stringify(tree)).toBe(before)
  })
})
