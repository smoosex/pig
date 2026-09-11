import { DeleteButton } from '../ui/delete-button'

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
    <DeleteButton
      label={ariaLabel}
      disabled={disabled}
      onConfirm={onConfirm}
      className="shrink-0 opacity-0 transition-opacity group-hover/session:opacity-100 group-hover/chat:opacity-100 focus-within:opacity-100 data-[state=open]:opacity-100"
    />
  )
}
