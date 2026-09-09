import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { VirtualItem } from '@tanstack/react-virtual'
import {
  captureAnchor,
  pruneMeasurements,
  restoredScrollOffset,
  TURN_ALIGN,
  turnScrollOffset
} from '../src/renderer/src/chat/scroll-state'

const item = (key: string, start: number, size: number): VirtualItem => ({
  key,
  index: Number(key.slice(1)),
  start,
  end: start + size,
  size,
  lane: 0
})

test('turnScrollOffset pins the user bubble with a 12px gap or above the composer', () => {
  const viewport = { scrollTop: 400, scrollHeight: 1000, clientHeight: 200 }
  assert.equal(
    turnScrollOffset(viewport, { top: 0, bottom: 200 }, { top: 40, bottom: 80 }),
    400 + 40 - TURN_ALIGN
  )
  assert.equal(
    turnScrollOffset(
      { scrollTop: 700, scrollHeight: 1000, clientHeight: 200 },
      { top: 0, bottom: 200 },
      { top: 160, bottom: 190 }
    ),
    702
  )
})

test('restoredScrollOffset keeps the captured relative offset and clamps to the viewport', () => {
  assert.equal(
    restoredScrollOffset(
      { scrollTop: 50, scrollHeight: 400, clientHeight: 100 },
      { top: 0, bottom: 100 },
      { top: 20, bottom: 80 },
      18
    ),
    88
  )
  assert.equal(
    restoredScrollOffset(
      { scrollTop: 0, scrollHeight: 120, clientHeight: 100 },
      { top: 0, bottom: 100 },
      { top: 0, bottom: 40 },
      80
    ),
    20
  )
})

test('captureAnchor and pruneMeasurements keep the visible row and drop stale keys', () => {
  const items = [item('t0', 0, 80), item('t1', 80, 120), item('t2', 200, 90)]
  assert.deepEqual(captureAnchor(items, 92), { key: 't1', offset: 12 })
  assert.equal(captureAnchor(items, 400), null)
  assert.deepEqual(
    pruneMeasurements(items, new Set(['t2', 't0'])).map((row) => row.key),
    ['t0', 't2']
  )
})
