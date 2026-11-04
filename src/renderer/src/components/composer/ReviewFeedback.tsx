/** Session-scoped review failures and model fallback stay visible until dismissed or retried. */
import { TriangleAlert, X } from 'lucide-react'
import { useT } from '../../hooks/useT'
import { useSystemUIStore } from '../../stores/system-ui'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '../ui/alert'
import { Button } from '../ui/button'

export function ReviewFeedback({ sessionId }: { sessionId: string | null }) {
  const t = useT()
  const feedback = useSystemUIStore((state) => sessionId ? state.reviewFeedback[sessionId] : undefined)
  if (!sessionId || !feedback) return null
  return (
    <Alert
      data-review-feedback
      variant={feedback.level === 'error' ? 'destructive' : 'default'}
      role={feedback.level === 'error' ? 'alert' : 'status'}
      className="mb-2 rounded-xl"
    >
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>{t(feedback.level === 'error' ? 'reviewUI.failed' : 'reviewUI.modelFallback')}</AlertTitle>
      <AlertDescription className="max-h-40 overflow-y-auto whitespace-pre-wrap wrap-anywhere [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {feedback.message}
        {feedback.detail ? (
          <details className="mt-1">
            <summary className="cursor-pointer">{t('reviewUI.details')}</summary>
            <p>{feedback.detail}</p>
          </details>
        ) : null}
      </AlertDescription>
      <AlertAction>
        <Button
          type="button" variant="ghost" size="icon-xs" aria-label={t('reviewUI.dismiss')}
          onClick={() => useSystemUIStore.getState().setReviewFeedback(sessionId, null)}
        >
          <X />
        </Button>
      </AlertAction>
    </Alert>
  )
}
