/**
 * The tab strip follows the sidebar switcher rather than the workspace: switching to the chats half
 * must swap the strip's contents, and switching back must restore the project's tabs unchanged.
 */
import { describe, expect, test } from 'bun:test'
import { halfSwitch, stripSlots, visibleTabsFor } from '../src/renderer/src/components/tab-strip'
import type { OpenTab } from '../src/renderer/src/stores/sessions/types'

const tab = (id: string, kind: OpenTab['kind'], cwd: string): OpenTab => ({
  id,
  cwd,
  kind,
  title: id,
  loadState: 'ready'
})

const projectSession = tab('session-p', 'project', '/p')
const otherWorktreeSession = tab('session-w', 'project', '/p/sub')
const chat = tab('chat-c', 'chat', '/chats/c')
const diff = tab('diff:/p', 'diff', '/p')
const all = [projectSession, otherWorktreeSession, chat, diff]

const ids = (tabs: OpenTab[]) => tabs.map((item) => item.id)

describe('visible tabs per sidebar half', () => {
  test('the projects half keeps the open project sessions, file and diff tabs', () => {
    expect(ids(visibleTabsFor(all, 'projects', '/p'))).toEqual(['session-p', 'diff:/p'])
  })

  test('the chats half drops the workspace tabs', () => {
    expect(ids(visibleTabsFor(all, 'chats', '/p'))).toEqual(['chat-c'])
  })

  test('with no project open the projects half falls back to chats', () => {
    expect(ids(visibleTabsFor(all, 'projects', null))).toEqual(['chat-c'])
  })

  test('switching halves is a pure projection, so back and forth restores the same tabs', () => {
    const before = ids(visibleTabsFor(all, 'projects', '/p'))
    ids(visibleTabsFor(all, 'chats', '/p'))
    expect(ids(visibleTabsFor(all, 'projects', '/p'))).toEqual(before)
  })
})

describe('what the switcher does to the content pane', () => {
  const known = new Set(['/p', '/p/sub'])

  test('entering the chats half focuses the chat it was left on', () => {
    expect(halfSwitch(all, 'chats', 'session-p', '/p', 'chat-c', '/p', known)).toEqual({
      kind: 'chat',
      tabId: 'chat-c'
    })
  })

  test('entering the chats half falls back to the newest chat when the remembered one is closed', () => {
    const newer = tab('chat-d', 'chat', '/chats/d')
    expect(halfSwitch([...all, newer], 'chats', 'session-p', '/p', 'chat-gone', '/p', known)).toEqual({
      kind: 'chat',
      tabId: 'chat-d'
    })
  })

  test('entering the chats half with nothing open asks for its home', () => {
    expect(halfSwitch([projectSession], 'chats', 'session-p', '/p', null, '/p', known)).toEqual({
      kind: 'chatHome'
    })
  })

  test('going back to the projects half returns to the worktree it was left in', () => {
    expect(halfSwitch(all, 'projects', 'chat-c', null, 'chat-c', '/p', known)).toEqual({
      kind: 'project',
      cwd: '/p'
    })
  })

  test('a half that already holds the focused tab is left alone', () => {
    expect(halfSwitch(all, 'chats', 'chat-c', null, 'chat-c', '/p', known)).toEqual({ kind: 'none' })
    expect(halfSwitch(all, 'projects', 'diff:/p', '/p', null, '/p', known)).toEqual({ kind: 'none' })
  })

  test('with no worktree to return to the projects half asks for nothing', () => {
    expect(halfSwitch(all, 'projects', 'chat-c', null, null, null, known)).toEqual({ kind: 'none' })
  })

  test('a worktree that is gone is not returned to', () => {
    // Unpinning drops the worktree's tabs with it, so only the chats are left to ask about.
    const chats = [chat, tab('chat-d', 'chat', '/chats/d')]
    expect(halfSwitch(chats, 'projects', 'chat-c', null, 'chat-c', '/p', new Set(['/other']))).toEqual({
      kind: 'none'
    })
  })

  test('a worktree with a tab of its own is still returned to', () => {
    expect(halfSwitch(all, 'projects', 'chat-c', null, 'chat-c', '/p', new Set())).toEqual({
      kind: 'project',
      cwd: '/p'
    })
  })

  test('a worktree the project list lost falls back to the newest tab that has one', () => {
    expect(halfSwitch(all, 'projects', 'chat-c', '/gone', null, '/gone', new Set(['/p']))).toEqual({
      kind: 'project',
      cwd: '/p'
    })
  })
})

describe('strip slots, which Cmd+1…9 count', () => {
  test('a split group takes one slot at its first visible member, selecting its focused pane', () => {
    const tabs = ['a', 'b', 'c', 'd'].map((id) => tab(id, 'chat', `/chats/${id}`))
    const group = {
      root: {
        id: 's', direction: 'horizontal' as const, sizes: [50, 50],
        children: [{ id: 'p-b', tabId: 'b' }, { id: 'p-d', tabId: 'd' }]
      },
      activePaneId: 'p-d'
    }
    expect(stripSlots(tabs, [group]).map((slot) => slot.tabId)).toEqual(['a', 'd', 'c'])
  })
})
