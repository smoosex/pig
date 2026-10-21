/**
 * Compactions reported beside the composer rather than inside the conversation: a summary written
 * between runs belongs to no turn, and one that failed never becomes a landmark at all. The row
 * counts up while Pi works, offers to stop it, and keeps a failure on screen until it is dismissed
 * or the next prompt takes the session over.
 */
import { useEffect, useState } from 'react'
import { LoaderCircle, TriangleAlert, X } from 'lucide-react'
import {
  compactionReasonKey,
  showsInTranscript,
  type LiveCompaction
} from '../../chat/compactions'
import { formatElapsed } from '../../chat/turns'
import { api } from '../../ipc/api'
import { useT } from '../../hooks/useT'
import { useSessionsStore } from '../../stores/sessions'
import { Button } from '../ui/button'

const emptyMarks: LiveCompaction[] = []

function useElapsedMs(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt == null) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 200)
    return () => window.clearInterval(id)
  }, [startedAt])
  return startedAt == null ? 0 : Math.max(0, now - startedAt)
}

function CompactionRow({ sessionId, mark }: { sessionId: string; mark: LiveCompaction }) {
  const t = useT()
  const elapsedMs = useElapsedMs(mark.status === 'running' ? mark.startedAt : null)
  const [cancelling, setCancelling] = useState(false)
  const running = mark.status === 'running'
  return (
    <div className="relative mb-2 flex min-w-0 items-center gap-2 rounded-xl bg-glass-composer-background/60 px-3 py-2 text-xs text-glass-prompt-foreground ring-1 ring-glass-card-border shadow-glass-card transition-[background-color,box-shadow] duration-200 ease-in-out after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:shadow-glass-card-edge motion-reduce:transition-none solid:bg-card solid:text-card-foreground solid:ring-border solid:shadow-none solid:after:shadow-none">
      {running ? (
        <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
      ) : (
        <TriangleAlert className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
      )}
      <span className="shrink-0">{running ? t(compactionReasonKey(mark.reason)) : t('chat.compactFailed')}</span>
      {running ? <span className="shrink-0 text-muted-foreground">{formatElapsed(elapsedMs, t)}</span> : null}
      {mark.errorMessage ? (
        <span className="min-w-0 flex-1 truncate text-destructive" title={mark.errorMessage}>
          {mark.errorMessage}
        </span>
      ) : (
        <span className="min-w-0 flex-1" />
      )}
      {running ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={cancelling}
          className="h-6 shrink-0 px-1.5 text-xs font-normal"
          onClick={() => {
            setCancelling(true)
            void api.abortCompaction(sessionId).catch((error) => {
              setCancelling(false)
              console.error('Failed to cancel compaction:', error)
            })
          }}
        >
          {t('common.cancel')}
        </Button>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          aria-label={t('common.dismiss', { title: t('chat.compactFailed') })}
          onClick={() => useSessionsStore.getState().dropCompaction(sessionId, mark.id)}
        >
          <X className="size-3.5" />
        </Button>
      )}
    </div>
  )
}

export function CompactionStatus({ sessionId }: { sessionId: string | null }) {
  const marks = useSessionsStore((state) =>
    sessionId ? (state.runtime[sessionId]?.liveCompactions ?? emptyMarks) : emptyMarks
  )
  // The transcript keeps a running summary while it still holds the run; everything else is ours.
  const inTranscript = useSessionsStore((state) =>
    sessionId ? (state.runtime[sessionId]?.liveMessages.length ?? 0) > 0 : false
  )
  if (!sessionId) return null
  const reported = marks.filter((mark) => !showsInTranscript(mark, inTranscript))
  if (reported.length === 0) return null
  return (
    <>
      {reported.map((mark) => (
        <CompactionRow key={mark.id} sessionId={sessionId} mark={mark} />
      ))}
    </>
  )
}
