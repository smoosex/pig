import { HoldToConfirmButton } from '../spectrumui/hold-to-confirm'

export function SessionDeleteButton({
  ariaLabel,
  onConfirm,
  disabled = false
}: {
  ariaLabel: string
  onConfirm: () => void
  disabled?: boolean
}) {
  return (
    <HoldToConfirmButton
      label={ariaLabel}
      confirmedLabel="已删除"
      size="sm"
      iconOnly
      disabled={disabled}
      onConfirm={onConfirm}
      className="pointer-events-auto size-6 shrink-0 gap-0 border-0 bg-transparent p-0 opacity-0 transition-opacity hover:bg-accent group-hover/session:opacity-100 group-hover/chat:opacity-100 focus-visible:opacity-100"
    />
  )
}
