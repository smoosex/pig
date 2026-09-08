import { describe, expect, test } from 'bun:test'
import { reconcileFollowUpRows, type FollowUpRow } from '../src/renderer/src/chat/follow-ups'

function queue() {
  let nextId = 0
  return (previous: FollowUpRow[], messages: string[], removedId?: string) =>
    reconcileFollowUpRows(previous, messages, () => String(++nextId), removedId)
}

describe('follow-up queue row identity', () => {
  test('appends new messages below existing rows without replaying their entrances', () => {
    const reconcile = queue()
    const first = reconcile([], ['第一条', '第二条'])
    const next = reconcile(first, ['第一条', '第二条', '第三条', '第四条'])
    expect(next.map((row) => row.text)).toEqual(['第一条', '第二条', '第三条', '第四条'])
    expect(next[0]).toBe(first[0])
    expect(next[1]).toBe(first[1])
    expect(new Set(next.map((row) => row.id)).size).toBe(4)
  })

  test('keeps surviving rows stable when the first queued message is delivered', () => {
    const reconcile = queue()
    const first = reconcile([], ['第一条', '第二条', '第三条'])
    const next = reconcile(first, ['第二条', '第三条'])
    expect(next).toEqual([first[1], first[2]])
    expect(next[0]).toBe(first[1])
    expect(next[1]).toBe(first[2])
  })

  test('does not merge equal messages and removes the oldest duplicate on delivery', () => {
    const reconcile = queue()
    const first = reconcile([], ['重复', '重复'])
    const appended = reconcile(first, ['重复', '重复', '重复'])
    expect(appended[0]).toBe(first[0])
    expect(appended[1]).toBe(first[1])
    expect(reconcile(appended, ['重复', '重复'])).toEqual([appended[1], appended[2]])
  })

  test('removes only the selected duplicate when editing, steering, or closing', () => {
    const reconcile = queue()
    const first = reconcile([], ['重复', '重复', '最后一条'])
    expect(reconcile(first, ['重复', '最后一条'], first[1].id)).toEqual([first[0], first[2]])
  })

  test('keeps an unchanged snapshot until the selected removal is actually received', () => {
    const reconcile = queue()
    const first = reconcile([], ['again', 'again', 'again'])
    const waiting = reconcile(first, ['again', 'again', 'again'], first[1].id)
    expect(waiting).toBe(first)
    const updated = reconcile(waiting, ['again', 'again'], first[1].id)
    expect(updated[0]).toBe(first[0])
    expect(updated[1]).toBe(first[2])
  })

  test('ignores no-op snapshots and gives a later new message a fresh identity', () => {
    const reconcile = queue()
    const first = reconcile([], ['第一条'])
    expect(reconcile(first, ['第一条'])).toBe(first)
    const empty = reconcile(first, [])
    expect(empty).toEqual([])
    expect(reconcile(empty, ['第一条'])[0].id).not.toBe(first[0].id)
  })
})
