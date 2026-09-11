import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { createThinkingTracker } from '../src/renderer/src/chat/thinking-tracker'
import type { PiSessionEvent } from '../src/renderer/src/pi/types'

function event(type: string, trailingText = false): PiSessionEvent {
  return {
    type: 'message_update',
    assistantMessageEvent: { type, contentIndex: 0 },
    message: {
      role: 'assistant', timestamp: 100,
      content: [
        { type: 'thinking', thinking: 'thinking' },
        ...(trailingText ? [{ type: 'text' as const, text: 'answer' }] : [])
      ]
    } as PiSessionEvent['message']
  }
}

test('thinking duration is recorded once while later text snapshots repeat the completed block', () => {
  let clock = 0
  const durations: number[] = []
  const tracker = createThinkingTracker((_id, _timestamp, _index, duration) => durations.push(duration), () => clock)
  tracker.record('a', event('thinking_start'))
  clock = 2_500
  tracker.record('a', event('thinking_end'))
  clock = 9_000
  tracker.record('a', event('text_delta', true))
  tracker.record('a', event('text_delta', true))
  tracker.finishMessage('a', 100, clock)
  assert.deepEqual(durations, [2_500])
})

test('closing one session discards its spans without completing another session with the same timestamp', () => {
  let clock = 0
  const durations: Array<[string, number]> = []
  const tracker = createThinkingTracker((id, _timestamp, _index, duration) => durations.push([id, duration]), () => clock)
  tracker.record('a', event('thinking_start'))
  tracker.record('b', event('thinking_start'))
  tracker.forgetSession('a')
  clock = 4_000
  tracker.finishSession('a', clock)
  tracker.finishSession('b', clock)
  assert.deepEqual(durations, [['b', 4_000]])
  tracker.clear()
})
