import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { isNotificationSessionVisible, setVisibleNotificationSessions } from '../src/main/completion-visibility'
import { visibleNotificationSessions } from '../src/renderer/src/chat/notification-visibility'

const tabs = [
  { id: 'chat', kind: 'chat', loadState: 'ready' },
  { id: 'project', kind: 'project', loadState: 'ready' },
  { id: 'browser', kind: 'browser', loadState: 'ready' },
  { id: 'cold', kind: 'project', loadState: 'cold' }
] as const
const visible = (
  active: string | null,
  panes: string[] = [],
  settings = false,
  bot?: { open: boolean; sessionId: string | null }
) => visibleNotificationSessions([...tabs], active, panes, settings, bot)

test('notification visibility follows the displayed single tab, split panes, and Bot surface', () => {
  expect(visible('chat')).toEqual(['chat'])
  expect(visible('project')).toEqual(['project'])
  expect(visible('chat', ['chat', 'project', 'browser'])).toEqual(['chat', 'project'])
  expect(visible('project', ['chat', 'browser'])).toEqual(['project'])
  expect(visible('chat', ['chat', 'project'], true)).toEqual([])
  expect(visible('browser')).toEqual([])
  expect(visible('cold')).toEqual([])
  expect(visible(null)).toEqual([])

  expect(visible('project', [], false, { open: false, sessionId: 'bot-1' })).toEqual(['project', 'bot-1'])
  expect(visible(null, [], false, { open: false, sessionId: 'bot-1' })).toEqual(['bot-1'])
  expect(visible('project', ['chat', 'project'], false, { open: true, sessionId: 'bot-1' })).toEqual(['bot-1'])
  expect(visible('project', [], false, { open: true, sessionId: null })).toEqual([])
  expect(visible('project', [], true, { open: true, sessionId: 'bot-1' })).toEqual([])
  expect(visible('project', [], true, { open: false, sessionId: 'bot-1' })).toEqual([])
})

test('notification visibility is window-local and cleared on document loss', () => {
  const contents = new EventEmitter()
  const win = { webContents: contents, isFocused: () => true } as unknown as BrowserWindow
  const other = { webContents: new EventEmitter(), isFocused: () => true } as unknown as BrowserWindow
  setVisibleNotificationSessions(win, ['chat', 'project'])
  expect(isNotificationSessionVisible(win, 'chat')).toBe(true)
  expect(isNotificationSessionVisible(other, 'chat')).toBe(false)
  contents.emit('did-start-navigation', {}, 'https://example.com', false, false)
  contents.emit('did-start-navigation', {}, 'file:///index.html#hash', true, true)
  expect(isNotificationSessionVisible(win, 'project')).toBe(true)
  contents.emit('did-start-navigation', {}, 'file:///index.html', false, true)
  expect(isNotificationSessionVisible(win, 'chat')).toBe(false)
  setVisibleNotificationSessions(win, ['project'])
  expect(contents.listenerCount('did-start-navigation')).toBe(1)
  expect(isNotificationSessionVisible(win, 'project')).toBe(true)
  contents.emit('render-process-gone')
  expect(isNotificationSessionVisible(win, 'project')).toBe(false)
})
