/**
 * A failure the session is recovering from, shown above the composer rather than in the transcript.
 * The retried request either becomes the answer — leaving nothing to remember — or leaves its failure
 * as the turn's own outcome, so this notice may never turn into history. It owns nothing but the
 * countdown: which retries are pending is Pi's to say, and it says so through session events.
 */
import { useEffect, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import type { Translate } from '../../../../shared/i18n'
import { useT } from '../../hooks/useT'
import { useSessionsStore } from '../../stores/sessions'
import type { RetryNotice as Notice } from '../../stores/sessions/types'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'

/** Seconds left before the next attempt starts; `0` while that attempt is already running. */
function useRemainingSeconds(endsAt: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  const waiting = endsAt != null && endsAt > now
  useEffect(() => {
    setNow(Date.now())
  }, [endsAt])
  useEffect(() => {
    if (!waiting || endsAt == null) return
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [waiting, endsAt])
  return endsAt == null || endsAt <= now ? 0 : Math.ceil((endsAt - now) / 1000)
}

function titleFor(notice: Notice, seconds: number, t: Translate): string {
  const params = { seconds, attempt: notice.attempt, total: notice.maxAttempts }
  if (notice.kind === 'request') {
    return t(seconds > 0 ? 'retry.requestWaiting' : 'retry.requestRetrying', params)
  }
  // A scheduled summary retry knows its budget but not yet its subject: compaction reports itself
  // when its attempt starts, and a branch summary is the other thing a summary retry can be.
  if (notice.source === 'compaction') return t('retry.compactionRetrying', params)
  if (notice.source === 'branchSummary') return t('retry.branchSummaryRetrying', params)
  return t(seconds > 0 ? 'retry.summaryWaiting' : 'retry.summaryRetrying', params)
}

export function RetryNotice({ sessionId }: { sessionId: string | null }) {
  const t = useT()
  const notice = useSessionsStore((state) =>
    sessionId ? (state.runtime[sessionId]?.retryNotice ?? null) : null
  )
  const seconds = useRemainingSeconds(notice?.endsAt ?? null)
  if (!notice) return null
  return (
    <Alert
      variant="destructive"
      className="mb-2 gap-x-2 rounded-xl border-destructive/30 bg-destructive/5 px-3 py-2"
    >
      <TriangleAlert className="size-3.5" aria-hidden="true" />
      <AlertTitle className="text-xs font-normal">{titleFor(notice, seconds, t)}</AlertTitle>
      <AlertDescription className="truncate text-xs text-muted-foreground" title={notice.errorMessage}>
        {notice.errorMessage}
      </AlertDescription>
    </Alert>
  )
}
