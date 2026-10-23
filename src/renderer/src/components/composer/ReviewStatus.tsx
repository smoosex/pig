/** Composer toolbar badge for review mode; clicking it returns to the conversation the review branched from. */
import { useState } from 'react'
import { ScanEye } from 'lucide-react'
import { toast } from 'sonner'
import { useT } from '../../hooks/useT'
import { api } from '../../ipc/api'
import { useSessionsStore } from '../../stores/sessions'
import { useSystemUIStore } from '../../stores/system-ui'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { cn } from '../../lib/utils'

export function ReviewStatus({ sessionId }: { sessionId: string | null }) {
  const t = useT()
  const active = useSystemUIStore((state) => !!sessionId && !!state.reviewSessions[sessionId])
  const returning = useSystemUIStore((state) => !!sessionId && !!state.returningReviewSessions[sessionId])
  const running = useSessionsStore((state) => !!sessionId && !!state.runtime[sessionId]?.isStreaming)
  const [pending, setPending] = useState(false)
  const ending = returning || pending

  if (!sessionId || (!active && !ending)) return null

  // Pi refuses tree navigation while a response streams, so a running review cannot return yet.
  const phase = ending ? 'returning' : running ? 'running' : 'done'
  const label = t(phase === 'returning' ? 'reviewUI.returning' : phase === 'running' ? 'reviewUI.running' : 'reviewUI.done')

  const endReview = async () => {
    if (phase !== 'done' || useSystemUIStore.getState().returningReviewSessions[sessionId]) return
    setPending(true)
    try {
      await api.prompt(sessionId, '/end-review')
    } catch (error) {
      // Report IPC rejection (including a duplicate return) here; only the host can release its lock.
      toast.error(t('reviewUI.endFailed'), {
        description: error instanceof Error ? error.message : String(error)
      })
    } finally {
      setPending(false)
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* aria-disabled instead of disabled: a disabled button gets no pointer events, which would hide the tooltip. */}
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          data-review-status
          data-review-phase={phase}
          aria-disabled={phase !== 'done'}
          aria-label={label}
          className="relative rounded-full aria-disabled:cursor-default"
          onClick={() => void endReview()}
        >
          <span
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute -inset-px rounded-full border border-primary',
              phase !== 'done' && 'animate-spin border-t-transparent motion-reduce:animate-none',
              phase === 'returning' && '[animation-direction:reverse]'
            )}
          />
          <ScanEye aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8}>{label}</TooltipContent>
    </Tooltip>
  )
}
