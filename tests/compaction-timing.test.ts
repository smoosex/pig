/**
 * The rule a turn's work clock follows around a summary: it stops while Pi writes, and the block
 * after it carries on from the total the clock had reached. These are the pure helpers behind both
 * the transcript's work blocks and the notice beside the composer.
 */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  liveLastBlockMs,
  settledLastBlockMs,
  workBlockMs,
  type LiveCompaction
} from '../src/renderer/src/chat/compactions'

const running = (workMsBefore: number, patch: Partial<LiveCompaction> = {}): LiveCompaction => ({
  id: 'k', reason: 'manual', startedAt: 0, workMsBefore, endedAt: null, status: 'running', ...patch
})

test('a turn with no summary is one block of work', () => {
  assert.deepEqual(workBlockMs([], 3_000), [3_000])
  assert.deepEqual(workBlockMs([], 0), [0])
})

test('each landmark ends the block before it and the last block ends at the turn', () => {
  const landmarks = [{ workMsBefore: 2_000, durationMs: 1_000 }, { workMsBefore: 5_000, durationMs: 500 }]
  assert.deepEqual(workBlockMs(landmarks, 7_000), [2_000, 5_000, 7_000])
})

test('a running summary freezes the work clock where it stood', () => {
  assert.equal(liveLastBlockMs([running(2_000)], 9_000, 0), 2_000)
  assert.equal(liveLastBlockMs([], 4_000, 1_000), 3_000)
  assert.equal(liveLastBlockMs([], 4_000, null), 0)
})

test('a written summary lets the clock run again from the same total', () => {
  const written = running(2_000, { endedAt: 3_000, status: 'done' })
  assert.equal(liveLastBlockMs([written], 5_000, 0), 4_000, 'the two seconds of summarizing are not work')
  assert.equal(liveLastBlockMs([written], 3_000, 0), 2_000, 'and nothing is counted before it finished')
})

test('a settled turn counts its total without the summaries inside it', () => {
  const landmarks = [{ workMsBefore: 2_000, durationMs: 1_000 }, { workMsBefore: 5_000, durationMs: 500 }]
  assert.equal(settledLastBlockMs(7_500, landmarks), 6_000)
  assert.equal(settledLastBlockMs(7_500, []), 7_500)
  // Estimates from entry write times can disagree with the elapsed time the turn reported.
  assert.equal(settledLastBlockMs(1_000, landmarks), 0)
  assert.deepEqual(workBlockMs([{ workMsBefore: -5, durationMs: 0 }], -1), [0, 0])
})
