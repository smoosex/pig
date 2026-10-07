/**
 * A dragged half-strip and a closed tab both have to survive one flat array holding two halves: the
 * tabs between two visible ones can belong to the other half, so neither the order it writes back nor
 * the neighbour it falls to may be read off raw array positions.
 */
import { describe, expect, test } from 'bun:test'
import {
  applyVisibleOrder,
  neighbourAmong,
  neighbourTab,
  persistableIds,
  sameScopeTabs
} from '../src/renderer/src/stores/sessions/tab-order'
import type { OpenTab } from '../src/renderer/src/stores/sessions/types'

const FILE_TAB = 'file:/p\u0000src/y.ts'

const tab = (id: string, kind: OpenTab['kind'], cwd: string): OpenTab => ({
  id,
  cwd,
  kind,
  title: id,
  loadState: 'ready'
})

const sessionA = tab('session-a', 'project', '/p')
const chatX = tab('chat-x', 'chat', '/chats/x')
const sessionB = tab('session-b', 'project', '/p')
const fileY = tab(FILE_TAB, 'file', '/p')
const sessionZ = tab('session-z', 'project', '/other')
const diff = tab('diff:/p', 'diff', '/p')
const chatW = tab('chat-w', 'chat', '/chats/w')

// Interleaved on purpose: a chat sits between two of the worktree's sessions, another worktree's tab
// sits among them, so no contiguous slice of this array is any half's sequence.
const all = [sessionA, chatX, sessionB, fileY, sessionZ, diff, chatW]
const ids = (tabs: OpenTab[]) => tabs.map((item) => item.id)

describe('a dragged half written back into the flat list', () => {
  test('the visible tabs take the slots they already held', () => {
    expect(ids(sameScopeTabs(all, sessionA))).toEqual(['session-a', 'session-b', FILE_TAB, 'diff:/p'])
    // The reader drags 全部变更 to the front of the strip.
    const next = applyVisibleOrder(all, ['diff:/p', 'session-a', 'session-b', FILE_TAB])
    expect(ids(sameScopeTabs(next, sessionA))).toEqual(['diff:/p', 'session-a', 'session-b', FILE_TAB])
  })

  test('the other half keeps the positions it has always had', () => {
    const next = applyVisibleOrder(all, ['diff:/p', 'session-a', 'session-b', FILE_TAB])
    // chat-x was index 1 and session-z index 4; neither belongs to the sequence that was dragged.
    expect(next[1]).toBe(chatX)
    expect(next[4]).toBe(sessionZ)
    expect(next).toHaveLength(all.length)
  })

  test('reordering one worktree leaves another worktree and the chats alone', () => {
    const next = applyVisibleOrder(all, ['diff:/p', 'session-a', 'session-b', FILE_TAB])
    expect(ids(sameScopeTabs(next, sessionZ))).toEqual(['session-z'])
    expect(ids(sameScopeTabs(next, chatX))).toEqual(['chat-x', 'chat-w'])
  })

  test('an id that went away mid-drag is dropped rather than resurrected', () => {
    const next = applyVisibleOrder(all, ['session-a', 'gone', 'session-b', 'diff:/p', FILE_TAB])
    expect(next).toHaveLength(all.length)
    expect(next.some((item) => item.id === 'gone')).toBe(false)
    expect(ids(sameScopeTabs(next, sessionA))).toEqual(['session-a', 'session-b', 'diff:/p', FILE_TAB])
  })

  test('an order that changes nothing hands back the same array', () => {
    expect(applyVisibleOrder(all, ids(sameScopeTabs(all, sessionA)))).toBe(all)
  })

  test('a file tab is never part of what is written to disk', () => {
    expect(persistableIds(sameScopeTabs(all, sessionA))).toEqual(['session-a', 'session-b', 'diff:/p'])
  })

  test('a dragged file tab still changes place now', () => {
    const next = applyVisibleOrder(all, [FILE_TAB, 'session-a', 'session-b', 'diff:/p'])
    expect(ids(sameScopeTabs(next, sessionA))[0]).toBe(FILE_TAB)
    expect(persistableIds(sameScopeTabs(next, sessionA))).toEqual(['session-a', 'session-b', 'diff:/p'])
  })
})

describe('where the strip goes when a tab closes', () => {
  test('the neighbour to the right on screen, not the one the array puts next', () => {
    // session-b's array successor belongs to another worktree; its on-screen successor is the file tab.
    expect(neighbourTab(all, sessionB)?.id).toBe(FILE_TAB)
  })

  test('the neighbour to the left when nothing is to the right', () => {
    expect(neighbourTab(all, diff)?.id).toBe(FILE_TAB)
  })

  test('nothing when the closed tab was the only one of its half', () => {
    const onlyChat = [tab('chat-only', 'chat', '/chats/only'), sessionA]
    expect(neighbourTab(onlyChat, onlyChat[0])).toBe(null)
  })

  test('never a tab of the other half', () => {
    // Closing a worktree tab may not land the pane on a chat, which would drop the worktree with it.
    expect(neighbourTab(all, sessionA)?.id).toBe('session-b')
    expect(neighbourTab(all, chatX)?.id).toBe('chat-w')
  })

  test('another worktree tab is not a neighbour either', () => {
    expect(neighbourTab([sessionZ, sessionA, chatX], sessionA)).toBe(null)
  })

  test('filtered candidates keep their position relative to the closed tab', () => {
    const sessionC = tab('session-c', 'project', '/p')
    const sessionD = tab('session-d', 'project', '/p')
    const sessionsOnly = (item: OpenTab) => item.kind === 'project'
    expect(neighbourAmong([sessionA, diff, fileY, sessionB], sessionB, sessionsOnly)).toBe(sessionA)
    expect(neighbourAmong([sessionA, diff, sessionB, sessionC, sessionD], sessionB, sessionsOnly)).toBe(sessionC)
    expect(neighbourAmong([sessionA, sessionB, diff, fileY, sessionC], sessionB, sessionsOnly)).toBe(sessionC)
    expect(neighbourAmong([sessionA, diff, sessionB], sessionB, () => false)).toBe(null)
  })

  test('a tab that is not open has no neighbour', () => {
    expect(neighbourTab(all, tab('not-open', 'project', '/p'))).toBe(null)
  })
})
