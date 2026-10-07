import type { MouseEvent } from 'react'
import { X } from 'lucide-react'
import { cn } from '../lib/utils'
import { CloseSpin } from './RunningSpinners'
import { Button } from './ui/button'

/**
 * The X that replaces a tab or row's running indicator when it is revealed.
 *
 * The caller owns the reveal: the item's root carries `close-reveal` so hovering
 * it starts the ring, and the fixed-width slot carries `group/close-slot` so
 * keyboard focus on this button hides the indicator behind it. Clicks never
 * reach the root's own select handler.
 */
export function CloseButton({
  streaming,
  ariaLabel,
  className,
  disabled = false,
  onClose
}: {
  streaming: boolean
  ariaLabel: string
  className?: string
  disabled?: boolean
  onClose: () => void
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={ariaLabel}
      disabled={disabled}
      className={cn('absolute opacity-0', className)}
      onClick={(event: MouseEvent) => {
        event.stopPropagation()
        onClose()
      }}
    >
      <span className="relative inline-flex size-3.5 items-center justify-center">
        {streaming ? <CloseSpin /> : null}
        <X className="size-2.5" />
      </span>
    </Button>
  )
}
