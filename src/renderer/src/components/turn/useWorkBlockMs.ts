import { useEffect, useState } from 'react'
import { liveLastBlockMs, settledLastBlockMs, workBlockMs } from '../../chat/compactions'
import type { CompactionItem, Turn } from '../../chat/turns'
import { useSessionsStore, selectActiveSessionId } from '../../stores/sessions'

/**
 * Work time at the end of every block of the turn's work, in block order. A turn without a
 * compaction has a single block; each compaction closes one at the work time it began, and the live
 * clock stops while the summary is written, so the block after it carries on from the same value.
 */
export function useWorkBlockMs(turn: Turn, landmarks: CompactionItem[], explicitSessionId?: string): number[] {
  const sessionId = useSessionsStore((state) => explicitSessionId ?? selectActiveSessionId(state))
  const streamStartedAt = useSessionsStore((s) =>
    turn.streaming && sessionId ? (s.runtime[sessionId]?.streamStartedAt ?? null) : null
  )
  const streamElapsedMs = useSessionsStore((s) =>
    !turn.streaming && turn.workedMs == null && turn.id?.startsWith('live:') && sessionId
      ? (s.runtime[sessionId]?.streamElapsedMs ?? null)
      : null
  )
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!turn.streaming) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 200)
    return () => window.clearInterval(id)
  }, [turn.streaming, streamStartedAt])

  if (turn.streaming) {
    // A running turn knows its compactions from Pi itself, not from the projection.
    const marks = landmarks.flatMap((item) => (item.live ? [item.live] : []))
    return workBlockMs(landmarks, liveLastBlockMs(marks, now, streamStartedAt))
  }
  const total = turn.workedMs
    ?? (turn.id?.startsWith('live:') ? streamElapsedMs : null)
    ?? Math.max(1000, turn.endedAt - turn.startedAt)
  return workBlockMs(landmarks, settledLastBlockMs(total, landmarks))
}
