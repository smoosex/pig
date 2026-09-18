import { useEffect, useState } from 'react'
import type { Turn } from '../../chat/turns'
import { useSessionsStore, selectActiveSessionId } from '../../stores/sessions'

/** Live turns work out their elapsed time from the session that is actually streaming. */
export function useWorkedMs(turn: Turn): number {
  const sessionId = useSessionsStore(selectActiveSessionId)
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
    if (!turn.streaming || streamStartedAt == null) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 200)
    return () => window.clearInterval(id)
  }, [turn.streaming, streamStartedAt])

  if (turn.streaming) return streamStartedAt != null ? Math.max(0, now - streamStartedAt) : 0
  if (turn.workedMs != null) return turn.workedMs
  if (turn.id?.startsWith('live:') && streamElapsedMs != null) return streamElapsedMs
  return Math.max(1000, turn.endedAt - turn.startedAt)
}
