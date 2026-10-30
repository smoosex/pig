/** Inline completion picks the first typed page the input prefixes and keeps that page's real URL. */
import { expect, test } from 'bun:test'
import type { BrowserHistoryEntry } from '../src/shared/browser'
import { inlineCompletion } from '../src/renderer/src/components/browser/inline-completion'

const entry = (url: string, typedCount = 1): BrowserHistoryEntry => ({ url, title: '', visitCount: 1, typedCount, lastVisitAt: 0 })

test('completes typed pages by prefix, ignoring scheme and www., and keeps what was typed', () => {
  const entries = [entry('https://agent.test/', 0), entry('https://www.github.com/'), entry('http://localhost:3000/app?x=1')]
  expect(inlineCompletion('git', entries)).toMatchObject({ text: 'github.com', url: 'https://www.github.com/' })
  expect(inlineCompletion('WWW.Git', entries)?.text).toBe('WWW.Github.com')
  expect(inlineCompletion('loc', entries)).toMatchObject({ text: 'localhost:3000/app?x=1', url: 'http://localhost:3000/app?x=1' })
  expect(inlineCompletion('agent', entries)).toBeNull()
  expect(inlineCompletion('github.com', entries)).toBeNull()
  expect(inlineCompletion('http://git', entries)).toBeNull()
  expect(inlineCompletion('https://git', entries)?.text).toBe('https://github.com')
  expect(inlineCompletion('git hub', entries)).toBeNull()
  expect(inlineCompletion('www.', entries)).toBeNull()
})
