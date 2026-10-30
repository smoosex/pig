import { describe, expect, test } from 'bun:test'
import { tabMentionLabel, tabMentionMatches, tabMentionText, tabMentions } from '../src/renderer/src/components/composer/tab-mentions'
import { restoredPromptToComposerDocument, serializeComposerDocument } from '../src/renderer/src/components/composer/document'
import type { OpenTab } from '../src/renderer/src/stores/sessions/types'

const tabs: OpenTab[] = [
  { id: 'browser:abc', kind: 'browser', title: 'Docs', cwd: '', loadState: 'ready' },
  { id: 'terminal:def', kind: 'terminal', title: 'Shell', cwd: '', loadState: 'ready' },
  { id: 'session-123', kind: 'project', title: 'Work', cwd: '/project', loadState: 'ready' },
  { id: 'chat-456', kind: 'chat', title: 'Chat', cwd: '', loadState: 'ready' },
  { id: 'file:x', kind: 'file', title: 'File', cwd: '', loadState: 'ready' }
]

const matching = (query: string) => tabMentions(tabs).filter((item) => tabMentionMatches(item, query)).map((item) => item.id)

describe('open tab mentions', () => {
  test('filters by title, kind and id, excluding non-session tabs', () => {
    expect(tabMentions(tabs).map((item) => item.id)).toEqual(['session-123', 'chat-456', 'browser:abc', 'terminal:def'])
    expect(matching('浏览器')).toEqual(['browser:abc'])
    expect(matching('Terminal')).toEqual(['terminal:def'])
    expect(matching('DOCS')).toEqual(['browser:abc'])
    expect(matching('session')).toEqual(['session-123', 'chat-456'])
    expect(matching('def')).toEqual(['terminal:def'])
  })

  test('atomic draft serializes stable identities and excludes the current session', () => {
    const item = tabMentions(tabs, 'session-123').find((entry) => entry.kind === 'terminal')!
    expect(tabMentions(tabs, 'session-123').some((entry) => entry.id === 'session-123')).toBe(false)
    expect(tabMentionLabel(item)).toBe('Shell: def')
    expect(tabMentionLabel({ kind: 'browser', id: 'browser:0123456789ab', title: '浏览器' })).toBe('浏览器: 01234567')
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'tabMention', attrs: item }, { type: 'text', text: ' hello' }] }] }
    expect(serializeComposerDocument(doc).text).toBe('@[terminal:terminal:def] hello')
    expect(JSON.parse(JSON.stringify(doc)).content[0].content[0].attrs).toEqual(item)
  })

  test('stable textual references survive draft restoration and title changes', () => {
    const items = tabMentions(tabs)
    const text = items.map(tabMentionText).join(' ')
    expect(text).toBe('@[session:session-123] @[session:chat-456] @[browser:browser:abc] @[terminal:terminal:def]')
    expect(serializeComposerDocument(restoredPromptToComposerDocument(text)).text).toBe(text)
    expect(tabMentionText({ ...items.find((item) => item.kind === 'browser')!, title: 'Renamed' })).toBe('@[browser:browser:abc]')
  })
})
