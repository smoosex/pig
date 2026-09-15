import { describe, expect, test } from 'bun:test'
import { composePromptText } from '../src/shared/pasted-text'
import type { DisplayTurn } from '../src/shared/api'
import { renderKeyForUser, turnImageSrc, type ProcessItem } from '../src/renderer/src/chat/turns'
import { toTurn } from '../src/renderer/src/chat/display-turns'

const display = (patch: Partial<DisplayTurn> = {}): DisplayTurn => ({
  id: 'turn', startedAt: 1000, endedAt: 2000, hasProcess: true, answer: [], ...patch
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
    const process: ProcessItem[] = []
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
    expect(turnImageSrc({ type: 'image', mimeType: 'image/png' })).toBeUndefined()
  })

  test('keeps assistant-only errors and history metadata intact', () => {
    const turn = toTurn(display({ errorMessage: '模型失败', hasProcess: false }), [])
    expect(turn.user).toBeUndefined()
    expect(turn).toMatchObject({ id: 'turn', startedAt: 1000, endedAt: 2000, errorMessage: '模型失败', hasProcess: false })
    expect(turn.workedMs).toBeUndefined()
  })
})
