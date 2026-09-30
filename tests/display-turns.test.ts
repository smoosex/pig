import { describe, expect, test } from 'bun:test'
import { composePromptText } from '../src/shared/pasted-text'
import type { DisplayTurn } from '../src/shared/api'
import { renderKeyForUser, turnImageSrc, groupTurns, type ProcessItem } from '../src/renderer/src/chat/turns'
import type { PigImageContent } from '../src/renderer/src/pi/types'
import { toTurn } from '../src/renderer/src/chat/display-turns'

const display = (patch: Partial<DisplayTurn> = {}): DisplayTurn => ({
  id: 'turn', startedAt: 1000, endedAt: 2000, hasProcess: true, answer: [], compactions: [], ...patch
})

describe('display turn projection', () => {
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
    expect(turn.process[1]).toEqual({ kind: 'compaction', text: 'compacted', tokensBefore: 100, afterAnswer: true })
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
    expect(turn.process).toEqual([{ kind: 'compaction', text: 'compacted', tokensBefore: 100, afterAnswer: true }])
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
      { text: '中间压缩', tokensBefore: 523_400, afterAnswer: false },
      { text: '尾压缩', tokensBefore: 7, afterAnswer: true }
    ]
    const unread = toTurn(display({ compactions: landmarks, hasProcess: true }), [])
    expect(unread.process).toEqual([])
    expect(unread.compactions).toEqual(landmarks.map((landmark) => ({ kind: 'compaction', ...landmark })))
    // Once the disclosure is read, Pi's own stream is the one with the landmarks in position.
    const read: ProcessItem[] = [{ kind: 'text', text: '工作' }]
    expect(toTurn(display({ compactions: landmarks }), read).process).toBe(read)
  })
})
