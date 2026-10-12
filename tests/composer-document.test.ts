import { describe, expect, test } from 'bun:test'
import { composerUserMessage, restoredPromptToComposerDocument, serializeComposerDocument, textToComposerDocument } from '../src/renderer/src/components/composer/document'
import { builtinCommandKey, compactInstructions, filterSlashCommands, slashQuery } from '../src/renderer/src/components/composer/commands'
import type { SlashCommand } from '../src/shared/api'

describe('composer document protocol', () => {
  test('preserves blank lines and literal backslash sequences in edited queue text', () => {
    const text = '第一段\n\n第二段 \\n 不换行\n'
    expect(serializeComposerDocument(textToComposerDocument(text))).toEqual({ text, attachments: [] })
  })

  test('round-trips clipboard line endings as LF', () => {
    expect(serializeComposerDocument(textToComposerDocument('a\r\nb\rc')).text).toBe('a\nb\nc')
    expect(serializeComposerDocument(textToComposerDocument('a\r\n\r\nb\n')).text).toBe('a\n\nb\n')
  })

  test('serializes hard breaks as newlines before assigning pasted-text offsets', () => {
    const document = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '开头🐷' }, { type: 'hardBreak' }, { type: 'text', text: '下一行' }] },
        { type: 'paragraph', content: [
          { type: 'pastedText', attrs: { id: 'paste-1', text: 'A\nB', filename: 'pasted.txt' } },
          { type: 'text', text: '末尾' }
        ] }
      ]
    }
    const serialized = serializeComposerDocument(document)
    expect(serialized.text).toBe('开头🐷\n下一行\nA\nB末尾')
    const attachment = serialized.attachments[0]
    expect(attachment).toEqual({ id: 'paste-1', text: 'A\nB', byteSize: 3, start: 9, end: 12, filename: 'pasted.txt' })
    expect(serialized.text.slice(attachment.start, attachment.end)).toBe(attachment.text)
    const message = composerUserMessage(serialized.text, [], serialized.attachments)
    expect(message.pastedText?.body).toBe(serialized.text)
    expect(message.pastedText?.segments?.map((segment) => segment.type)).toEqual(['text', 'attachment', 'text'])
    expect(message.pastedText?.attachments[0].text).toBe('A\nB')
  })

  test('restores forked pasted text as an attachment without changing the prompt', () => {
    const text = '问题\n\n完整粘贴内容'
    const document = restoredPromptToComposerDocument(text, [{
      id: 'paste-1',
      text: '完整粘贴内容',
      byteSize: 18,
      start: 4,
      end: text.length
    }])
    expect(serializeComposerDocument(document)).toEqual({
      text,
      attachments: [{
        id: 'paste-1',
        text: '完整粘贴内容',
        byteSize: 18,
        start: 4,
        end: text.length
      }]
    })
  })

  test('restores prompts without attachments as ordinary text', () => {
    expect(restoredPromptToComposerDocument('a\r\nb')).toEqual(textToComposerDocument('a\nb'))
    expect(restoredPromptToComposerDocument('')).toEqual(textToComposerDocument(''))
  })

  test('sorts restored attachment ranges and fills their byte sizes', () => {
    const document = restoredPromptToComposerDocument('A--B', [
      { id: 'second', text: 'B', start: 3, end: 4 },
      { id: 'first', text: 'A', start: 0, end: 1 }
    ])
    expect(serializeComposerDocument(document)).toEqual({
      text: 'A--B',
      attachments: [
        { id: 'first', text: 'A', byteSize: 1, start: 0, end: 1 },
        { id: 'second', text: 'B', byteSize: 1, start: 3, end: 4 }
      ]
    })
    expect(() => restoredPromptToComposerDocument('AAAA', [
      { id: 'first', text: 'AA', start: 0, end: 2 },
      { id: 'second', text: 'AA', start: 1, end: 3 }
    ])).toThrow(Error)
  })

  test('rejects restored attachment metadata that does not match the prompt', () => {
    expect(() => restoredPromptToComposerDocument('原始内容', [{
      id: 'paste-1', text: '错误内容', start: 0, end: 4
    }])).toThrow(Error)
  })

  test('keeps image-only prompts valid without inventing an empty text block', () => {
    const message = composerUserMessage('', [{ mimeType: 'image/png', data: 'base64' }], [])
    expect(message.content).toEqual([{ type: 'image', mimeType: 'image/png', data: 'base64' }])
    expect(message.pastedText).toBeUndefined()
  })
})

describe('composer commands', () => {
  test('parses only the native compact command and its optional instructions', () => {
    expect(compactInstructions('/compact')).toBe('')
    expect(compactInstructions('/compact ')).toBe('')
    expect(compactInstructions('/compact  Keep decisions\n and paths  ')).toBe('Keep decisions\n and paths')
    for (const text of ['hello /compact', '/compact-other', '/compaction', '/compact\tinstructions']) {
      expect(compactInstructions(text)).toBeNull()
    }
    expect(builtinCommandKey('compact')).toBe('commands.compact')
    expect(builtinCommandKey('other')).toBeNull()
  })

  test('only treats a single initial command token as a suggestion query', () => {
    expect(slashQuery('/')).toBe('')
    expect(slashQuery('/ex')).toBe('ex')
    for (const text of ['hello /ex', '/ex\n', '/export file.html', '/ex\t']) expect(slashQuery(text)).toBeNull()
  })

  test('sorts within command source groups without mutating the catalog', () => {
    const commands = [
      { name: 'export', source: 'skill' },
      { name: 'next', source: 'builtin' },
      { name: 'export', source: 'builtin' },
      { name: 'clear', source: 'builtin' }
    ] as SlashCommand[]
    expect(filterSlashCommands(commands, 'ex')).toEqual([commands[2], commands[1], commands[0]])
    expect(commands[0].source).toBe('skill')
  })
})
