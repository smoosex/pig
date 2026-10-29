import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import { splitMarkdown } from '../src/renderer/src/lib/markdown-chunks'

test('long Markdown splits on blank lines and never inside fenced code', () => {
  const fence = ['```ts', 'const a = 1', '', 'const b = 2', '```'].join('\n')
  const text = ['para one', '', fence, '', 'para two', '', '~~~', '', '~~~', '', 'tail'].join('\n')
  const chunks = splitMarkdown(text, 1)
  assert.equal(chunks.join('\n\n'), text)
  for (const chunk of chunks) {
    const fences = chunk.split('\n').filter((line) => /^(```|~~~)/.test(line)).length
    assert.equal(fences % 2, 0, `unbalanced fence in ${JSON.stringify(chunk)}`)
  }
  assert.deepEqual(chunks, ['para one', fence, 'para two', '~~~\n\n~~~', 'tail'])
  assert.deepEqual(splitMarkdown(text, text.length), [text])
})

test('long lists retain indented continuations, nested items and list numbering', () => {
  const list = [
    `1. ${'long item '.repeat(2_000)}`,
    '',
    '    continuation paragraph',
    '',
    '    - nested item',
    '',
    '2. second item',
    '   lazy continuation'
  ].join('\n')
  const text = `${list}\n\nafter list`
  const chunks = splitMarkdown(text, 16_000)
  assert.deepEqual(chunks, [list, 'after list'])
  const render = (value: string) => renderToStaticMarkup(createElement(Markdown, null, value))
  assert.equal(chunks.map(render).join('\n'), render(text))
  assert.ok(render(chunks[0]).includes('<p>continuation paragraph</p>'))
  assert.ok(!render(chunks[0]).includes('<pre>'))
})

test('quote containers stay together across quoted blank lines', () => {
  const quote = '> first\n>\n> second\n> continuation'
  assert.deepEqual(splitMarkdown(`${quote}\n\nafter`, 1), [quote, 'after'])
})

test('a piece with no blank line ends at a line break that cannot continue the block', () => {
  const lines = ['aaaa', 'bbbb', '  cont', '| t |', 'cccc', '----', 'dddd', 'eeee']
  const chunks = splitMarkdown(lines.join('\n'), 2)
  assert.equal(chunks.join('\n'), lines.join('\n'))
  assert.deepEqual(chunks, ['aaaa', 'bbbb\n  cont\n| t |', 'cccc\n----', 'dddd', 'eeee'])
})
