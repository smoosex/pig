import { useEffect, useState } from 'react'
import type { Turn } from '../../chat/turns'
import { useSessionsStore } from '../../stores/sessions'

export function useWorkedMs(turn: Turn): number {
  const streamStartedAt = useSessionsStore((s) =>
    turn.streaming && s.activeSessionId ? (s.runtime[s.activeSessionId]?.streamStartedAt ?? null) : null
  )
  const streamElapsedMs = useSessionsStore((s) =>
    !turn.streaming && turn.workedMs == null && turn.id?.startsWith('live:') && s.activeSessionId
      ? (s.runtime[s.activeSessionId]?.streamElapsedMs ?? null)
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
