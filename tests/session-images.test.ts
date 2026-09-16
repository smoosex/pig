import { expect, test } from 'bun:test'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import {
  base64Body,
  imageMimeType,
  isImagePayload,
  parseSessionImageUrl,
  sessionImageUrl
} from '../src/shared/session-images'
import { sessionImageFromEntry, sessionImageResponse } from '../src/main/pi/session-images'

test('image URLs round-trip through the scheme parser', () => {
  const url = sessionImageUrl('session-1', 'entry-9', 2)
  expect(url).toBe('pig-image://session/session-1/entry-9/2')
  expect(parseSessionImageUrl(url)).toEqual({ sessionId: 'session-1', entryId: 'entry-9', index: 2 })
})

test('image URLs with an id that needs escaping still parse', () => {
  const url = sessionImageUrl('a/b', 'c d', 0)
  expect(parseSessionImageUrl(url)).toEqual({ sessionId: 'a/b', entryId: 'c d', index: 0 })
})

test('the parser rejects URLs that do not address one image block', () => {
  const rejected = [
    'https://session/session-1/entry-9/0',
    'pig-image://elsewhere/session-1/entry-9/0',
    'pig-image://session/session-1/entry-9',
    'pig-image://session/session-1/entry-9/two',
    'pig-image://session/session-1/entry-9/0/extra',
    'pig-image://session/%E0%A4/0/0',
    'pig-image://session/session-1/%ZZ/0',
    'not a url'
  ]
  for (const url of rejected) expect(parseSessionImageUrl(url)).toBeNull()
})

test('an image block is decoded from its entry content', () => {
  const entry = {
    type: 'message',
    id: 'user',
    parentId: null,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'image', mimeType: 'image/png', data: Buffer.from('bytes').toString('base64') }
      ],
      timestamp: 1
    }
  } as unknown as SessionEntry

  const image = sessionImageFromEntry(entry, 1)
  expect(image?.mimeType).toBe('image/png')
  expect(image?.data.toString()).toBe('bytes')
})

test('only complete and decodable image blocks resolve', () => {
  const image = (data: unknown, mimeType: unknown = 'image/png') => ({ type: 'image', mimeType, data })
  const entry = (content: unknown[], type = 'message') => ({
    type,
    id: 'e',
    parentId: null,
    timestamp: '2026-01-01T00:00:00.000Z',
    ...(type === 'custom_message' ? { content } : { message: { role: 'user', content, timestamp: 1 } })
  }) as unknown as SessionEntry

  expect(sessionImageFromEntry(entry([{ type: 'text', text: 'hi' }]), 0)).toBeNull()
  // A block the projection would turn into a URL must not resolve; both sides use isImageBlock.
  expect(sessionImageFromEntry(entry([image('')]), 0)).toBeNull()
  expect(sessionImageFromEntry(entry([image('QUJD', '')]), 0)).toBeNull()
  // Only image subtypes may reach a content-type header.
  expect(sessionImageFromEntry(entry([image('QUJD', 'text/html')]), 0)).toBeNull()
  expect(sessionImageFromEntry(entry([image('QUJD', 'image/png\r\nx-injected: 1')]), 0)).toBeNull()
  expect(sessionImageFromEntry(entry([{ type: 'image', data: 'QUJD' }]), 0)).toBeNull()
  // '####' decodes to nothing and 'QUJD=QUJD' is malformed, while an unpadded 'QUJ' is two bytes.
  expect(sessionImageFromEntry(entry([image('####')]), 0)).toBeNull()
  expect(sessionImageFromEntry(entry([image('QUJD=QUJD')]), 0)).toBeNull()
  expect(sessionImageFromEntry(entry([image('Q')]), 0)).toBeNull()
  expect(sessionImageFromEntry(entry([image('%3Csvg%3E')]), 0)).toBeNull()
  const unpadded = sessionImageFromEntry(entry([image('QUJ')]), 0)
  expect(unpadded?.data.toString()).toBe('AB')
  // Parameters are dropped so the served type is one the header can carry.
  const parameterized = sessionImageFromEntry(entry([image('QUJD', 'image/svg+xml;charset=utf-8')]), 0)
  expect(parameterized?.mimeType).toBe('image/svg+xml')
  expect(sessionImageFromEntry(entry([image('QUJD')]), 3)).toBeNull()
  expect(sessionImageFromEntry(undefined, 0)).toBeNull()
  expect(sessionImageFromEntry(entry([image('QUJD')], 'label'), 0)).toBeNull()

  const custom = sessionImageFromEntry(entry([image('QUJD', 'image/jpeg')], 'custom_message'), 0)
  expect(custom?.mimeType).toBe('image/jpeg')
  expect(custom?.data.toString()).toBe('ABC')
})

test('the protocol answers an image request with the decoded bytes', async () => {
  const entry = {
    type: 'message',
    id: 'entry-9',
    parentId: null,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      role: 'user',
      content: [
        { type: 'image', mimeType: 'image/jpeg', data: Buffer.from('first').toString('base64') },
        { type: 'image', mimeType: 'image/png', data: Buffer.from('bytes').toString('base64') }
      ],
      timestamp: 1
    }
  } as unknown as SessionEntry
  const asks: Array<[string, string]> = []
  const lookup = async (sessionId: string, entryId: string) => {
    asks.push([sessionId, entryId])
    return entryId === 'entry-9' ? entry : undefined
  }

  const response = await sessionImageResponse(sessionImageUrl('s1', 'entry-9', 1), lookup)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('image/png')
  expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
  // The exact bytes of the requested block, not just "some response".
  expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('bytes')
  expect(asks).toEqual([['s1', 'entry-9']])

  const other = await sessionImageResponse(sessionImageUrl('s1', 'entry-9', 0), lookup)
  expect(other.headers.get('content-type')).toBe('image/jpeg')
  expect(Buffer.from(await other.arrayBuffer()).toString()).toBe('first')
})

test('the protocol answers 404 when the session or the entry is gone', async () => {
  const missing = async () => undefined
  const cases = [
    [sessionImageUrl('s1', 'entry-9', 0), async () => undefined],
    [sessionImageUrl('s1', 'entry-9', 0), missing],
    [sessionImageUrl('s1', 'entry-9', 7), missing],
    ['pig-image://session/%E0%A4/0/0', missing],
    ['pig-image://elsewhere/s1/entry-9/0', missing],
    ['not a url', missing]
  ] as const

  for (const [url, lookup] of cases) {
    const response = await sessionImageResponse(url, lookup)
    expect(response.status).toBe(404)
    expect(await response.text()).toBe('')
  }
})

test('a file this reader cannot vouch for is a missing image, not a failed request', async () => {
  const unsupported = async () => {
    const { UnsupportedSessionFile } = await import('../src/main/pi/session-jsonl')
    throw new UnsupportedSessionFile('session.jsonl')
  }
  const response = await sessionImageResponse(sessionImageUrl('s1', 'entry-9', 0), unsupported)
  expect(response.status).toBe(404)
  expect(await response.text()).toBe('')
})

test('an unexpected lookup failure is not swallowed into a 404', async () => {
  const broken = async () => {
    throw new Error('Session index is corrupt')
  }
  await expect(sessionImageResponse(sessionImageUrl('s1', 'e1', 0), broken)).rejects.toThrow(
    'Session index is corrupt'
  )
})

test('the image criterion is one rule for writing and reading', () => {
  expect(imageMimeType('image/PNG')).toBe('image/png')
  expect(imageMimeType('image/svg+xml;charset=utf-8')).toBe('image/svg+xml')
  expect(imageMimeType(' image/webp ')).toBe('image/webp')
  expect(imageMimeType('text/html')).toBeNull()
  expect(imageMimeType('image/png;x: y')).toBe('image/png')
  expect(imageMimeType('')).toBeNull()
  expect(imageMimeType('image/')).toBeNull()
  expect(imageMimeType('image/png\r\nx-injected: 1')).toBeNull()

  expect(isImagePayload({ mimeType: 'image/svg+xml;charset=utf-8', data: 'QUJD' })).toBe(true)
  expect(isImagePayload({ mimeType: 'image/png', data: ' iVBORw0KGgo ' })).toBe(true)
  expect(isImagePayload({ mimeType: 'application/octet-stream', data: 'QUJD' })).toBe(false)
  expect(isImagePayload({ mimeType: 'image/png', data: '' })).toBe(false)
  // A body of length 4n + 1 cannot decode to whole bytes, so it is refused before it is persisted.
  expect(isImagePayload({ mimeType: 'image/png', data: 'QUJDQ' })).toBe(false)
  // Anything else that is not image base64 is refused too, so no written image can 404 on read.
  expect(isImagePayload({ mimeType: 'image/png', data: '%3Csvg%3E' })).toBe(false)
  expect(isImagePayload({ mimeType: 'image/png', data: 'data:image/png;base64,' })).toBe(false)
  expect(isImagePayload(null)).toBe(false)

  // Alphanumeric text is indistinguishable from unpadded base64; the reader serves what it decodes.
  expect(isImagePayload({ mimeType: 'image/png', data: 'not base64 at all' })).toBe(true)
  expect(base64Body('not base64 at all')).toBe('notbase64atall')
  expect(base64Body('QUJ')).toBe('QUJ')
  expect(base64Body('QUJD=')).toBe('QUJD')
  expect(base64Body('####')).toBeNull()
})
