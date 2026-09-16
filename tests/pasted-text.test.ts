import { describe, expect, test } from 'bun:test'
import {
  composePromptText,
  createInlinePastedTextDisplayMetadata,
  createInlinePastedTextMetadata,
  createPastedTextMetadata,
  formatPastedTextSize,
  isLongPastedText,
  normalizeNewlines,
  pastedTextFingerprint,
  isPastedTextMetadata,
  isInlinePastedTextAttachments,
  pastedTextLineCount,
  stripPastedTextAttachments,
  utf8ByteLength
} from '../src/shared/pasted-text'

describe('pasted text attachments', () => {
  test('uses strict character and line thresholds', () => {
    expect(isLongPastedText('a'.repeat(2000))).toBe(false)
    expect(isLongPastedText('a'.repeat(2001))).toBe(true)
    expect(isLongPastedText('🙂'.repeat(2000))).toBe(false)
    expect(isLongPastedText('🙂'.repeat(2001))).toBe(true)
    expect(pastedTextLineCount(Array.from({ length: 20 }, () => 'x').join('\n'))).toBe(20)
    expect(isLongPastedText(Array.from({ length: 20 }, () => 'x').join('\n'))).toBe(false)
    expect(isLongPastedText(Array.from({ length: 21 }, () => 'x').join('\n'))).toBe(true)
    expect(pastedTextLineCount('a\r\nb\r\nc')).toBe(3)
  })

  test('normalizes clipboard line endings before counting or storing them', () => {
    expect(normalizeNewlines('a\r\nb\rc')).toBe('a\nb\nc')
    expect(normalizeNewlines('a\r\n\r\nb')).toBe('a\n\nb')
    expect(normalizeNewlines('a\n')).toBe('a\n')
    expect(pastedTextLineCount('a\rb\rc')).toBe(3)
    expect(isLongPastedText(Array.from({ length: 21 }, () => 'x').join('\r'))).toBe(true)
  })

  test('keeps body and attachment order in the model input', () => {
    expect(composePromptText('正文', [
      { id: 'one', text: '第一份' },
      { id: 'two', text: '第二份' }
    ])).toBe('正文\n\n第一份\n\n第二份')
    expect(composePromptText('', [{ id: 'one', text: '只有附件' }])).toBe('只有附件')
  })

  test('preserves inline attachment positions and display segments', () => {
    const content = '前文附件后文'
    const attachments = [{ id: 'one', text: '附件', byteSize: 6, start: 2, end: 4 }]
    expect(isInlinePastedTextAttachments(content, attachments)).toBe(true)
    expect(stripPastedTextAttachments(content, attachments)).toBe('前文后文')
    expect(createInlinePastedTextMetadata(content, attachments)).toEqual({
      version: 2,
      contentLength: content.length,
      contentHash: pastedTextFingerprint(content),
      attachments: [{ id: 'one', start: 2, end: 4, byteSize: 6 }]
    })
    expect(createInlinePastedTextDisplayMetadata(content, attachments).segments).toEqual([
      { type: 'text', text: '前文' },
      { type: 'attachment', attachment: { id: 'one', text: '附件', byteSize: 6 } },
      { type: 'text', text: '后文' }
    ])
  })

  test('calculates UTF-8 size and validates persisted metadata', () => {
    const metadata = createPastedTextMetadata('正文', [
      { id: 'one', text: '附件', byteSize: 6 }
    ])
    expect(metadata).toEqual({
      version: 1,
      bodyLength: 2,
      contentLength: 6,
      contentHash: pastedTextFingerprint('正文\n\n附件'),
      attachments: [{ id: 'one', start: 4, end: 6, byteSize: 6 }]
    })
    expect(utf8ByteLength('中文')).toBe(6)
    expect(formatPastedTextSize(2048)).toBe('2 KB')
    expect(isPastedTextMetadata({
      version: 1,
      bodyLength: 2,
      contentLength: 6,
      contentHash: pastedTextFingerprint('正文\n\n附件'),
      attachments: [{ id: 'one', start: 4, end: 6, byteSize: 6 }]
    })).toBe(true)
    expect(isPastedTextMetadata({
      version: 1,
      bodyLength: 2,
      contentLength: 6,
      contentHash: pastedTextFingerprint('正文\n\n附件'),
      attachments: [{ id: '', start: 4, end: 6, byteSize: 6 }]
    })).toBe(false)
  })
})
