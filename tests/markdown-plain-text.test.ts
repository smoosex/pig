import { expect, test } from 'bun:test'
import { markdownToPlainText } from '../src/renderer/src/lib/markdown-plain-text'

test('plain-text copying removes Markdown formatting without joining paragraphs', () => {
  expect(markdownToPlainText('# 标题\n\n**加粗**、*斜体*、~~删除~~和[链接](https://example.com)\n\n> 引用'))
    .toBe('标题\n\n加粗、斜体、删除和链接\n\n引用')
})

test('plain-text copying retains code, math and escaped literal characters', () => {
  expect(markdownToPlainText('`a_b * c` 和 $x_1$\n\n```ts\nconst value = "**原文**"\n```\n\n\\*不应删除\\*'))
    .toBe('a_b * c 和 x_1\n\nconst value = "**原文**"\n\n*不应删除*')
})

test('plain-text copying keeps list items and table cells separate', () => {
  expect(markdownToPlainText('- 第一项\n- 第二项\n\n| 名称 | 值 |\n| --- | --- |\n| 项目 | 42 |'))
    .toBe('第一项\n第二项\n\n名称\t值\n项目\t42')
})
