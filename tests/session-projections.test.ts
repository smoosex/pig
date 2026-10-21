import { describe, expect, test } from 'bun:test'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { normalizeSessionPrompt } from '../src/main/pi/prompt-input'
import { sessionTreeRows, sessionTreeViews } from '../src/main/pi/session-tree'
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

  test('trailing custom records anchor and highlight the preceding non-custom entry', () => {
    const entries = [
      { id: 'u1', parentId: null, type: 'message', message: { role: 'user', content: '问题' } },
      { id: 'answer', parentId: 'u1', type: 'message', message: { role: 'assistant', content: '答案' } },
      { id: 'custom1', parentId: 'answer', type: 'custom' },
      { id: 'custom2', parentId: 'custom1', type: 'custom' },
      { id: 'alternate', parentId: 'u1', type: 'message', message: { role: 'assistant', content: '另一个分支' } }
    ] as unknown as SessionEntry[]
    const source = {
      leafId: () => 'custom2',
      treeEntries: () => entries,
      branchIds: () => ['u1', 'answer', 'custom1', 'custom2']
    } as SessionSource
    for (const view of ['default', 'no-tools', 'all'] as const) {
      const rows = sessionTreeRows(source, view)
      expect(rows.filter((row) => row.current).map((row) => row.id)).toEqual(['answer'])
      expect(rows.find((row) => row.id === 'answer')).toMatchObject({ onPath: true })
    }
    const all = sessionTreeRows(source, 'all')
    expect(all.find((row) => row.id === 'custom1')).toMatchObject({ current: false, onPath: true })
    expect(all.find((row) => row.id === 'custom2')).toMatchObject({ current: false, onPath: true })
    expect(source.leafId()).toBe('custom2')
    expect(sessionTreeRows({ ...source, leafId: () => 'answer' }).filter((row) => row.current)
      .map((row) => row.id)).toEqual(['answer'])
  })

  test('tree views mirror pi Ctrl+O: no-tools, user-only, labeled-only, all', () => {
    const entries = [
      { id: 'u1', parentId: null, type: 'message', message: { role: 'user', content: '问题' } },
      { id: 'a1', parentId: 'u1', type: 'message', message: { role: 'assistant', content: '我来看看' } },
      {
        id: 'call',
        parentId: 'a1',
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.ts' } }]
        }
      },
      { id: 'r1', parentId: 'call', type: 'message', message: { role: 'toolResult', toolCallId: 'c1' } },
      { id: 'b1', parentId: 'r1', type: 'message', message: { role: 'bashExecution', command: 'ls' } },
      { id: 'use', parentId: 'b1', type: 'usage' },
      { id: 'ce', parentId: 'use', type: 'context_edit', targetId: 'u1', replacement: null },
      { id: 'empty', parentId: 'ce', type: 'message', message: { role: 'assistant', content: [] } },
      { id: 'info', parentId: 'empty', type: 'session_info', name: '名字' },
      { id: 'lbl', parentId: 'info', type: 'label', targetId: 'u1', label: '起点' },
      { id: 'lbl2', parentId: 'lbl', type: 'label', targetId: 'a1', label: '草稿' },
      { id: 'lbl3', parentId: 'lbl2', type: 'label', targetId: 'a1', label: '' },
      {
        id: 'u2', parentId: 'lbl3', type: 'message',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '继续\n\n[Image: original 2992x1868, displayed at 2000x1249. Multiply coordinates by 1.50 to map to original image.]' },
            { type: 'image', mimeType: 'image/png', data: 'QUJD' }
          ]
        }
      }
    ] as unknown as SessionEntry[]
    const source = {
      sessionId: 'session-1',
      leafId: () => 'u2',
      entries: () => entries,
      treeEntries: () => entries,
      branch: () => entries,
      branchIds: () => entries.map((entry) => entry.id)
    } as SessionSource
    const ids = (view?: Parameters<typeof sessionTreeRows>[1]) =>
      sessionTreeRows(source, view).map((row) => row.id)
    expect(ids()).toEqual(['u1', 'a1', 'r1', 'b1', 'u2'])
    expect(ids('no-tools')).toEqual(['u1', 'a1', 'b1', 'u2'])
    expect(ids('user-only')).toEqual(['u1', 'u2'])
    expect(ids('labeled-only')).toEqual(['u1'])
    expect(ids('all')).toEqual(['u1', 'a1', 'r1', 'b1', 'ce', 'info', 'lbl', 'lbl2', 'lbl3', 'u2'])
    const tool = sessionTreeRows(source).find((row) => row.id === 'r1')
    expect(tool).toMatchObject({ text: '[read: a.ts]' })
    const leaf = sessionTreeRows(source, 'user-only').find((row) => row.id === 'u2')
    expect(leaf).toMatchObject({ current: true, onPath: true, text: 'user: 继续' })
    expect(sessionTreeRows(source).find((row) => row.id === 'u1')).toMatchObject({ label: '起点' })
    expect(sessionTreeRows(source).find((row) => row.id === 'a1')?.label).toBeUndefined()
    expect(sessionTreeRows(source).find((row) => row.id === 'u2')?.label).toBeUndefined()
    const all = sessionTreeRows(source, 'all')
    expect(all.find((row) => row.id === 'lbl')).toMatchObject({ text: '[label: 起点]' })
    expect(all.find((row) => row.id === 'lbl3')).toMatchObject({ text: '[label: ]' })
    expect(all.find((row) => row.id === 'info')).toMatchObject({ text: '[title: 名字]' })
    expect(all.find((row) => row.id === 'ce')).toMatchObject({ text: '[context omit: u1]' })
  })

  test('one walk serves all five views', () => {
    let walks = 0
    const entries = [
      { id: 'u1', parentId: null, type: 'message', message: { role: 'user', content: '问题' } },
      { id: 'a1', parentId: 'u1', type: 'message', message: { role: 'assistant', content: '答案' } },
      { id: 'lbl', parentId: 'a1', type: 'label', targetId: 'u1', label: '起点' },
      { id: 'u2', parentId: 'lbl', type: 'message', message: { role: 'user', content: '继续' } }
    ] as unknown as SessionEntry[]
    const source = {
      sessionId: 'session-1',
      leafId: () => 'u2',
      entries: () => entries,
      treeEntries: () => {
        walks += 1
        return entries
      },
      branch: () => entries,
      branchIds: () => entries.map((entry) => entry.id)
    } as SessionSource
    const views = sessionTreeViews(source)
    expect(Object.keys(views).sort()).toEqual(['all', 'default', 'labeled-only', 'no-tools', 'user-only'])
    expect(walks).toEqual(1)
    expect(views.default.map((row) => row.id)).toEqual(['u1', 'a1', 'u2'])
    expect(views['user-only'].map((row) => row.id)).toEqual(['u1', 'u2'])
    expect(views['labeled-only'].map((row) => row.id)).toEqual(['u1'])
    expect(views.all.map((row) => row.id)).toEqual(['u1', 'a1', 'lbl', 'u2'])
  })
})
