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
  const [ending, setEnding] = useState(false)

  if (!sessionId || !active) return null

  const endReview = async () => {
    setEnding(true)
    try {
      await api.prompt(sessionId, '/end-review')
    } catch (error) {
      toast.error(t('reviewUI.endFailed'), {
        description: error instanceof Error ? error.message : String(error)
      })
    } finally {
      setEnding(false)
    }
  }

  return (
    <div data-review-status className="ml-auto flex shrink-0 items-center gap-1">
      <Badge variant="secondary" role="status">
        <ScanEye aria-hidden="true" />
        <span className="hidden @min-md/composer-column:inline">{t('reviewUI.active')}</span>
        <span className="@min-md/composer-column:hidden">{t('reviewUI.activeCompact')}</span>
      </Badge>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={ending}
        aria-label={t('reviewUI.endReview')}
        title={t('reviewUI.endReview')}
        onClick={() => void endReview()}
      >
        {ending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <ArrowLeft aria-hidden="true" />}
        <span className="hidden @min-md/composer-column:inline">{t('reviewUI.endReview')}</span>
      </Button>
    </div>
  )
}
