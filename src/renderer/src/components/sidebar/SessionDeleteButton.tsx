import { HoldToConfirmButton } from '../spectrumui/hold-to-confirm'
import { cn } from '../../lib/utils'
import { sidebarButtonSurface } from './sidebar-surface'
import { useT } from '../../hooks/useT'

export function SessionDeleteButton({
  ariaLabel,
  onConfirm,
  disabled = false
}: {
  ariaLabel: string
  onConfirm: () => void
  disabled?: boolean
}) {
  const t = useT()
  return (
    <HoldToConfirmButton
      label={ariaLabel}
      confirmedLabel={t('sessions.deleted')}
      size="sm"
      iconOnly
      disabled={disabled}
      onConfirm={onConfirm}
      className={cn(
        'pointer-events-auto size-6 shrink-0 gap-0 border-0 p-0 opacity-0 transition-opacity group-hover/session:opacity-100 focus-visible:opacity-100',
        sidebarButtonSurface
      )}
    />
  )
}
