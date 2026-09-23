import { FileText } from 'lucide-react'
import type { PastedTextAttachment } from '../../../shared/pasted-text'
import { useT } from '../hooks/useT'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { PastedTextPreview } from './PastedTextPreview'

export function PastedTextChip({
  attachment,
  className
}: {
  attachment: PastedTextAttachment
  className?: string
}) {
  const t = useT()
  return (
    <PastedTextPreview text={attachment.text} byteSize={attachment.byteSize}>
      <Button
        type="button"
        variant="outline"
        size="xs"
        className={cn(
          'gap-1 rounded-xs font-normal mx-1',
          className
        )}
        aria-label={attachment.filename ?? t('composer.pastedText')}
      >
        <FileText />
        <span className="min-w-0 truncate">{attachment.filename ?? t('composer.pastedText')}</span>
      </Button>
    </PastedTextPreview>
  )
}
