import { describe, expect, test } from 'bun:test'
import { composePromptText } from '../src/shared/pasted-text'
import type { DisplayTurn } from '../src/shared/api'
import { renderKeyForUser, turnImageSrc, groupTurns, type ProcessItem } from '../src/renderer/src/chat/turns'
import type { AssistantMessage, PigImageContent, PiMessage } from '../src/renderer/src/pi/types'
import { toTurn } from '../src/renderer/src/chat/display-turns'

const display = (patch: Partial<DisplayTurn> = {}): DisplayTurn => ({
  id: 'turn', startedAt: 1000, endedAt: 2000, hasProcess: true, answer: [], compactions: [], workBlocks: [patch.hasProcess ?? true], ...patch
})

describe('display turn projection', () => {
  test('merges adjacent thinking pieces without mutating messages or crossing visible boundaries', () => {
    const user: PiMessage = { role: 'user', content: 'question', timestamp: 1 }
    const first = {
      role: 'assistant', timestamp: 2,
      content: [{ type: 'thinking', thinking: 'first' }, { type: 'thinking', thinking: 'second' }]
    } as AssistantMessage
    const next = {
      ...first, timestamp: 3, content: [{ type: 'thinking', thinking: 'third' }]
    } as AssistantMessage
    const before = structuredClone([first, next])
    const durations = { '2:0': 15_000, '2:1': 13_000, '3:0': 2_000 }
    const [turn] = groupTurns([user, first, next], false, durations)
    expect(turn.process).toEqual([{
      kind: 'thinking', text: 'first\n\nsecond\n\nthird', durationMs: 30_000, live: false
    }])
    expect([first, next]).toEqual(before)
    const boundaries: PiMessage[] = [
      { ...next, content: [{ type: 'text', text: 'intervening text' }] },
      { role: 'toolResult', timestamp: 3, toolCallId: 'read', toolName: 'read', isError: false, content: [] },
      { role: 'compactionSummary', timestamp: 3, summary: 'context', tokensBefore: 42 }
    ]
    for (const boundary of boundaries) {
      const [separated] = groupTurns([user, first, boundary, { ...next, timestamp: 4 }], false, durations)
      expect(separated.process.filter((item) => item.kind === 'thinking')).toHaveLength(2)
    }
  })

  test('keeps thinking before and after a matched tool result in separate rows', () => {
    const user: PiMessage = { role: 'user', content: 'question', timestamp: 1 }
    const request = {
      role: 'assistant', timestamp: 2,
      content: [
        { type: 'toolCall', id: 'read', name: 'read', arguments: { path: 'file.ts' } },
        { type: 'thinking', thinking: 'before tool result' }
      ]
    } as AssistantMessage
    const result: PiMessage = {
      role: 'toolResult', timestamp: 3, toolCallId: 'read', toolName: 'read', isError: false,
      content: [{ type: 'text', text: 'file contents' }]
    }
    const next = {
      ...request, timestamp: 4, content: [{ type: 'thinking', thinking: 'after tool result' }]
    } as AssistantMessage
    const messages = [user, request, result, next]
    const before = structuredClone(messages)
    for (const streaming of [false, true]) {
      const [turn] = groupTurns(messages, streaming, { '2:1': 15_000, '4:0': 13_000 })
      expect(turn.process).toEqual([
        { kind: 'tools', tools: [{ id: 'read', name: 'read', args: { path: 'file.ts' }, result }] },
        { kind: 'thinking', text: 'before tool result', durationMs: 15_000, live: false },
        { kind: 'thinking', text: 'after tool result', durationMs: 13_000, live: false }
      ])
      expect(messages).toEqual(before)
    }
  })

  test('sums raw measured thinking durations without replacing zero-length spans with persistence timing', () => {
    const message: AssistantMessage & { persistedAt: number } = {
      role: 'assistant', timestamp: 2, persistedAt: 2_002,
      api: 'openai-completions', provider: 'synthetic', model: 'synthetic', stopReason: 'stop',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      content: [{ type: 'thinking', thinking: 'first' }, { type: 'thinking', thinking: 'second' }]
    }
    for (const durationMs of [100, 0]) {
      const [turn] = groupTurns([message], false, { '2:0': durationMs, '2:1': durationMs })
      expect(turn.process).toEqual([{
        kind: 'thinking', text: 'first\n\nsecond', durationMs: durationMs * 2, live: false
      }])
    }
  })

  test('preserves live render keys across text normalization and image projection', () => {
    const image = { type: 'image' as const, mimeType: 'image/png', data: 'AA==' }
    // Persisted turns carry the URL; the key only has to count the image either way.
    const persistedImage = { mimeType: 'image/png', url: 'pig-image://session/s/turn/1' }
    for (const content of [
      'hello',
      [{ type: 'text' as const, text: 'hello' }],
      [{ type: 'text' as const, text: 'he' }, { type: 'text' as const, text: 'llo' }],
      [{ type: 'text' as const, text: 'hello' }, image],
      [{ type: 'text' as const, text: '' }, image]
    ]) {
      const text = typeof content === 'string'
        ? content
        : content.filter((block) => block.type === 'text').map((block) => block.text).join('')
      const images = typeof content === 'string'
        ? []
        : content.filter((block) => block.type === 'image').map(() => persistedImage)
      const persisted = toTurn(display({
        userTimestamp: 42,
        user: { text, images, textAttachments: [] }
      }), [])
      expect(persisted.renderKey).toBe(renderKeyForUser({ timestamp: 42, content }))
    }
  })

  test('preserves pasted-text segments, cached process identity, and elapsed time', () => {
    const attachment = { id: 'paste', text: '附件', byteSize: 6 }
    const input = display({ user: {
      text: '正文附件', images: [], textAttachments: [attachment],
      textSegments: [{ type: 'text', text: '正文' }, { type: 'attachment', attachment }]
    } })
    const process: ProcessItem[] = [{ kind: 'text', text: '工作' }]
    const turn = toTurn(input, process, 1500)
    expect(turn.user?.content).toBe('正文附件')
    expect(turn.user?.timestamp).toBe(1000)
    expect(turn.user?.pastedText?.segments).toBe(input.user?.textSegments)
    expect(turn.user?.pastedText?.attachments).toBe(input.user?.textAttachments)
    expect(turn.process).toBe(process)
    expect(turn.workedMs).toBe(1500)
    expect(turn.streaming).toBe(false)
  })

  test('preserves the legacy v1 pasted-text render key from the composed prompt', () => {
    const attachment = { id: 'paste', text: '附件', byteSize: 6 }
    const composed = composePromptText('正文', [attachment])
    const turn = toTurn(display({
      userTimestamp: 42,
      user: { text: '正文', images: [], textAttachments: [attachment] }
    }), [])
    expect(turn.renderKey).toBe(renderKeyForUser({ timestamp: 42, content: composed }))
  })

  test('maps image-only user prompts and mixed answer blocks without empty text', () => {
    const image = { mimeType: 'image/png', url: 'pig-image://session/s/turn/1' }
    const text = { type: 'text' as const, text: '答案' }
    const turn = toTurn(display({
      user: { text: '', images: [image], textAttachments: [] },
      answer: [text, { type: 'image', ...image }]
    }), [])
    expect(turn.user?.content).toEqual([{ type: 'image', ...image }])
    expect(turn.answer).toEqual([text, { type: 'image', image: { type: 'image', ...image } }])
    expect(turn.answer[0]).toBe(text)
  })

  test('renders persisted images through their URL and unsaved ones from their bytes', () => {
    expect(turnImageSrc({ type: 'image', mimeType: 'image/png', url: 'pig-image://session/s/turn/1' }))
      .toBe('pig-image://session/s/turn/1')
    expect(turnImageSrc({ type: 'image', mimeType: 'image/png', data: 'AA==' }))
      .toBe('data:image/png;base64,AA==')
    expect(turnImageSrc({ type: 'image', mimeType: 'image/png' } as PigImageContent)).toBeUndefined()
  })

  test('keeps a command turn when a compaction summary follows the command', () => {
    const command = {
      role: 'bashExecution', command: 'pwd', output: 'files', exitCode: 0, cancelled: false, timestamp: 10
    } as const
    const summary = {
      role: 'compactionSummary', summary: 'compacted', tokensBefore: 100, timestamp: 11
    } as const
    const [turn] = groupTurns([command, summary] as never, false)
    expect(turn.bash).toEqual({ command: 'pwd', exitCode: 0, cancelled: false })
    expect(turn.process.map((item) => item.kind)).toEqual(['bash', 'compaction'])
    // No assistant in the chunk, so the marker belongs below whatever the command rendered.
    expect(turn.process[1]).toEqual({
      kind: 'compaction', text: 'compacted', tokensBefore: 100, afterAnswer: true, workMsBefore: 0, durationMs: 1
    })
  })

  test('splits a compaction onto the side of the answer it followed', () => {
    const user = { role: 'user', content: 'go', timestamp: 9 } as const
    const assistant = {
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      timestamp: 10
    } as const
    const summary = { role: 'compactionSummary', summary: 'compacted', tokensBefore: 100, timestamp: 11 } as const
    const [turn] = groupTurns([user, assistant, summary] as never, false)
    expect(turn.answer).toEqual([{ type: 'text', text: 'done' }])
    expect(turn.process).toEqual([
      { kind: 'compaction', text: 'compacted', tokensBefore: 100, afterAnswer: true, workMsBefore: 1, durationMs: 1 }
    ])
    const [midTurn] = groupTurns([user, assistant, summary, { ...assistant, timestamp: 12 }] as never, false)
    expect(midTurn.process.find((item) => item.kind === 'compaction')).toMatchObject({ afterAnswer: false })
  })

  test('keeps a compaction inside the work when an overflow error was retried after it', () => {
    const user = { role: 'user', content: 'go', timestamp: 9 } as const
    const overflow = {
      role: 'assistant',
      content: [{ type: 'text', text: 'context length exceeded' }],
      errorMessage: 'context length exceeded',
      timestamp: 10
    } as const
    const summary = { role: 'compactionSummary', summary: 'compacted', tokensBefore: 300_000, timestamp: 11 } as const
    const retry = { role: 'assistant', content: [{ type: 'text', text: 'retried answer' }], timestamp: 12 } as const
    const [turn] = groupTurns([user, overflow, summary, retry] as never, false)
    expect(turn.answer).toEqual([{ type: 'text', text: 'retried answer' }])
    // The failed attempt stays in raw history, but the retry that followed is the turn's outcome.
    expect(turn.errorMessage).toBeUndefined()
    expect(turn.process.find((item) => item.kind === 'compaction')).toMatchObject({ afterAnswer: false })
  })

  test('keeps live compaction boundaries in their original turn when a follow-up starts', () => {
    const messages: Parameters<typeof groupTurns>[0] = [
      { role: 'user', content: 'first request', timestamp: 1 },
      { role: 'custom', customType: 'status', content: 'before compaction', display: true, timestamp: 2 },
      { role: 'user', content: 'follow-up request', timestamp: 4 },
      { role: 'custom', customType: 'status', content: 'after compaction', display: true, timestamp: 5 }
    ]
    const turns = groupTurns(messages, true, {}, {}, [{
      id: 'k1', reason: 'threshold', startedAt: 2, endedAt: 3, afterMessageCount: 2,
      workMsBefore: 1, status: 'done', summary: 'preserved context', tokensBefore: 42
    }])
    expect(turns[0].process.map((item) => item.kind)).toEqual(['custom', 'compaction'])
    expect(turns[1].process.map((item) => item.kind)).toEqual(['custom'])
  })

  test('keeps the last failed attempt as the outcome when no retry recovered the turn', () => {
    const user = { role: 'user', content: 'go', timestamp: 9 } as const
    const first = { role: 'assistant', content: [], errorMessage: 'overloaded', timestamp: 10 } as const
    const last = { role: 'assistant', content: [], errorMessage: 'still overloaded', timestamp: 11 } as const
    const [turn] = groupTurns([user, first, last] as never, false)
    expect(turn.errorMessage).toBe('still overloaded')
  })

  test('keeps assistant-only errors and history metadata intact', () => {
    const turn = toTurn(display({ errorMessage: '模型失败', hasProcess: false }), [])
    expect(turn.user).toBeUndefined()
    expect(turn).toMatchObject({ id: 'turn', startedAt: 1000, endedAt: 2000, errorMessage: '模型失败', hasProcess: false })
    expect(turn.workedMs).toBeUndefined()
  })

  test('carries a persisted compaction until the process is read', () => {
    const landmarks = [
      { text: '中间压缩', tokensBefore: 523_400, afterAnswer: false, workMsBefore: 2_000, durationMs: 500 },
      { text: '尾压缩', tokensBefore: 7, afterAnswer: true, workMsBefore: 3_000, durationMs: 250 }
    ]
    const projected = display({ compactions: landmarks, hasProcess: true, workBlocks: [true, true] })
    const unread = toTurn(projected, [])
    expect(unread.process).toEqual([])
    expect(unread.workBlocks).toBe(projected.workBlocks)
    expect(unread.compactions).toEqual(landmarks.map((landmark) => ({ kind: 'compaction', ...landmark })))
    // Once the disclosure is read, Pi's own stream is the one with the landmarks in position.
    const read: ProcessItem[] = [{ kind: 'text', text: '工作' }]
    expect(toTurn(projected, read).process).toBe(read)
    expect(toTurn(projected, read).workBlocks).toBe(projected.workBlocks)
  })
})
