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

describe('visible tabs per workspace scope', () => {
  test('the projects view keeps the open project sessions, file and diff tabs', () => {
    expect(ids(visibleTabsFor(all, 'projects', '/p'))).toEqual(['session-p', 'diff:/p'])
  })

  test('with no project open the strip shows unscoped tool/chat tabs only', () => {
    expect(ids(visibleTabsFor(all, 'projects', null))).toEqual(['chat-c'])
  })
})

describe('what switching from kanban back to projects does to the content pane', () => {
  const known = new Set(['/p', '/p/sub'])

  test('entering kanban leaves the current selection untouched', () => {
    expect(halfSwitch(all, 'kanban', 'session-p', '/p', null, '/p', known)).toEqual({
      kind: 'none'
    })
  })

  test('going back to projects returns to the worktree it was left in when unfocused', () => {
    expect(halfSwitch(all, 'projects', 'chat-c', null, 'chat-c', '/p', known)).toEqual({
      kind: 'project',
      cwd: '/p'
    })
  })

  test('projects view that already holds the focused project tab is left alone', () => {
    expect(halfSwitch(all, 'projects', 'diff:/p', '/p', null, '/p', known)).toEqual({ kind: 'none' })
  })

  test('with no worktree to return to projects asks for nothing', () => {
    expect(halfSwitch(all, 'projects', 'chat-c', null, null, null, known)).toEqual({ kind: 'none' })
  })

  test('a worktree that is gone is not returned to', () => {
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
    const tabs = ['a', 'b', 'c', 'd'].map((id) => tab(id, 'project', '/p'))
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
