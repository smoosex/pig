import { expect, test } from 'bun:test'
import { stripImageHintsFromContent } from '../src/shared/image-hints'

const dimension = '[Image: original 2992x1868, displayed at 2000x1249. Multiply coordinates by 1.50 to map to original image.]'
const converted = '[Image converted from image/heic to image/png.]'
const omitted = '[Image omitted: could not be resized below the inline image size limit.]'

test('removes only SDK display notes from a user message with images', () => {
  const text = `看图\n\n${converted}\n${dimension}\n${omitted}\n${dimension}`
  const content = [{ type: 'text', text }, { type: 'image', mimeType: 'image/png', data: 'QUJD' }]
  const visible = stripImageHintsFromContent(content)
  expect(visible).toEqual([{ type: 'text', text: `看图\n\n${omitted}` }, content[1]])
  expect(content[0].text).toBe(text)
  expect(stripImageHintsFromContent([{ type: 'text', text: `\n\n${dimension}` }, content[1]])[0].text).toBe('')
})

test('keeps non-image messages, failure notices and notes outside the trailing hint block', () => {
  const quoted = [{ type: 'text', text: `引用\n\n${dimension}` }]
  expect(stripImageHintsFromContent(quoted)).toBe(quoted)
  const failed = [{ type: 'text', text: `看图\n\n${omitted}` }]
  expect(stripImageHintsFromContent(failed)).toBe(failed)
  const followed = [{ type: 'text', text: `看图\n\n${dimension}\n这是正文` }, { type: 'image' }]
  expect(stripImageHintsFromContent(followed)).toBe(followed)
})
