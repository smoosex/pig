import { thinkingTimingKey } from './turns'
import { assistantStreamEvent, isPiMessage, type PiSessionEvent } from '../pi/types'

interface ThinkingSpan {
  sessionId: string
  messageTimestamp: number
  contentIndex: number
  startedAt: number
}

/** Tracks thinking spans using a monotonic clock, independently of React renders. */
export function createThinkingTracker(
  onDuration: (sessionId: string, timestamp: number, index: number, duration: number) => void,
  now: () => number = () => performance.now()
) {
  const starts = new Map<string, ThinkingSpan>()
  const completed = new Map<string, Set<string>>()
  const timingKey = (sessionId: string, messageTimestamp: number, contentIndex: number) =>
    `${sessionId}:${thinkingTimingKey(messageTimestamp, contentIndex)}`

  const finish = (
    entry: ThinkingSpan,
    endedAt: number
  ) => {
    const keys = completed.get(entry.sessionId) ?? new Set<string>()
    keys.add(thinkingTimingKey(entry.messageTimestamp, entry.contentIndex))
    completed.set(entry.sessionId, keys)
    onDuration(
      entry.sessionId,
      entry.messageTimestamp,
      entry.contentIndex,
      endedAt - entry.startedAt
    )
  }

  const finishMessage = (sessionId: string, messageTimestamp: number, endedAt: number) => {
    for (const [key, entry] of starts) {
      if (entry.sessionId !== sessionId || entry.messageTimestamp !== messageTimestamp) continue
      starts.delete(key)
      finish(entry, endedAt)
    }
  }

  const finishSession = (sessionId: string, endedAt: number) => {
    for (const [key, entry] of starts) {
      if (entry.sessionId !== sessionId) continue
      starts.delete(key)
      finish(entry, endedAt)
    }
    completed.delete(sessionId)
  }

  const recordThinkingEvent = (sessionId: string, event: PiSessionEvent) => {
    if (event.type !== 'message_update' || !isPiMessage(event.message)) return
    if (event.message.role !== 'assistant' || !Array.isArray(event.message.content)) return
    const streamEvent = assistantStreamEvent(event)
    const timestampNow = now()
    const timestamp = event.message.timestamp
    const content = event.message.content

    content.forEach((block, contentIndex) => {
      if (block.type !== 'thinking') return
      if (completed.get(sessionId)?.has(thinkingTimingKey(timestamp, contentIndex))) return
      const key = timingKey(sessionId, timestamp, contentIndex)
      const live =
        streamEvent != null &&
        streamEvent.contentIndex === contentIndex &&
        (streamEvent.type === 'thinking_start' || streamEvent.type === 'thinking_delta')
      if (!starts.has(key) && (live || Boolean(block.thinking))) {
        starts.set(key, {
          sessionId,
          messageTimestamp: timestamp,
          contentIndex,
          startedAt: timestampNow
        })
      }
      const closed = streamEvent?.type === 'thinking_end' && streamEvent.contentIndex === contentIndex
      const followed = content.slice(contentIndex + 1).some((item) => item.type !== 'thinking')
      if (!closed && !followed) return
      const entry = starts.get(key)
      if (!entry) return
      starts.delete(key)
      finish(entry, timestampNow)
    })
  }

  const forgetSession = (sessionId: string) => {
    for (const [key, entry] of starts) {
      if (entry.sessionId === sessionId) starts.delete(key)
    }
    completed.delete(sessionId)
  }

  return {
    record: recordThinkingEvent,
    finishMessage,
    finishSession,
    forgetSession,
    clear: () => {
      starts.clear()
      completed.clear()
    }
  }
}
