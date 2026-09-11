import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { VirtualItem } from '@tanstack/react-virtual'
import { captureAnchor, pruneMeasurements } from '../src/renderer/src/chat/scroll-state'

const item = (key: string, start: number, size: number): VirtualItem => ({
  key, index: Number(key.slice(1)), start, end: start + size, size, lane: 0
})

test('scroll snapshots keep the visible row and remove stale branch measurements', () => {
  const items = [item('t0', 0, 80), item('t1', 80, 120), item('t2', 200, 90)]
  assert.deepEqual(captureAnchor(items, 92), { key: 't1', offset: 12 })
  assert.equal(captureAnchor(items, 400), null)
  assert.deepEqual(pruneMeasurements(items, new Set(['t2', 't0'])).map((row) => row.key), ['t0', 't2'])
})

test('an anchor at a row boundary chooses the next visible row', () => {
  const items = [item('t0', 0, 80), item('t1', 80, 120)]
  assert.deepEqual(captureAnchor(items, 80), { key: 't1', offset: 0 })
  assert.deepEqual(captureAnchor(items, 68), { key: 't1', offset: -12 })
  assert.equal(captureAnchor([], 0), null)
})
