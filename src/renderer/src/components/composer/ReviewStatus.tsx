import { useState } from 'react'
import { ArrowLeft, LoaderCircle, ScanEye } from 'lucide-react'
import { toast } from 'sonner'
import { useT } from '../../hooks/useT'
import { api } from '../../ipc/api'
import { useSystemUIStore } from '../../stores/system-ui'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'

export function ReviewStatus({ sessionId }: { sessionId: string | null }) {
  const t = useT()
  const active = useSystemUIStore((state) => !!sessionId && !!state.reviewSessions[sessionId])
  const returning = useSystemUIStore((state) => !!sessionId && !!state.returningReviewSessions[sessionId])
  const [pending, setPending] = useState(false)
  const ending = returning || pending

  if (!sessionId || (!active && !ending)) return null

  const endReview = async () => {
    if (pending || useSystemUIStore.getState().returningReviewSessions[sessionId]) return
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
    <div data-review-status className="ml-auto flex shrink-0 items-center [[data-subagent-status]+&]:ml-0">
      {/* Review is a mode, not a note: the whole row carries the primary fill, a lit top edge and a
          tinted drop shadow so it reads as raised above the rest of the status line. The action sits
          inside the pill, so its focus ring is inset — an outer ring would be clipped by the badge. */}
      <Badge className="h-6 gap-1.5 py-0.5 pr-1 pl-2.5 shadow-md shadow-primary/40 inset-shadow-[0_1px_0_0_color-mix(in_srgb,var(--primary)_75%,white)] dark:shadow-primary/25">
        <span role="status" className="flex items-center gap-1.5">
          <ScanEye aria-hidden="true" className="size-3" />
          <span className="hidden @min-md/composer-column:inline">{t(ending ? 'reviewUI.returning' : 'reviewUI.active')}</span>
          <span className="@min-md/composer-column:hidden">{t(ending ? 'reviewUI.returning' : 'reviewUI.activeCompact')}</span>
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={ending}
          className="h-5 rounded-full px-1.5 text-primary-foreground hover:bg-primary-foreground/12 hover:text-primary-foreground focus-visible:border-primary-foreground/40 focus-visible:ring-primary-foreground/60 focus-visible:ring-inset dark:hover:bg-primary-foreground/12 dark:hover:text-primary-foreground"
          aria-label={t('reviewUI.endReview')}
          title={t('reviewUI.endReview')}
          onClick={() => void endReview()}
        >
          {ending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <ArrowLeft aria-hidden="true" />}
          <span className="hidden @min-md/composer-column:inline">{t('reviewUI.endReview')}</span>
        </Button>
      </Badge>
    </div>
  )
}
