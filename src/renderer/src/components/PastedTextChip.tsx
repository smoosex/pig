import { FileText } from 'lucide-react'
import type { PastedTextAttachment } from '../../../shared/pasted-text'
import { useT } from '../hooks/useT'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { PastedTextPreview } from './PastedTextPreview'
import { INLINE_CHIP_CLASS } from './inline-chip'

export function PastedTextChip({
  attachment,
  className
}: {
  attachment: PastedTextAttachment
  className?: string
}) {
  const t = useT()
  return (
    <PastedTextPreview text={attachment.text} byteSize={attachment.byteSize} title={attachment.filename}>
      <Button
        type="button"
        variant="secondary"
        size="xs"
        className={cn(INLINE_CHIP_CLASS, className)}
        aria-label={attachment.filename ?? t('composer.pastedText')}
      >
        <FileText className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{attachment.filename ?? t('composer.pastedText')}</span>
      </Button>
    </PastedTextPreview>
  )
}
