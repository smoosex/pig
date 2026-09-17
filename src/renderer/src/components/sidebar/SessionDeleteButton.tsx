import { DeleteButton } from '../ui/delete-button'

export function SessionDeleteButton({
  ariaLabel,
  onConfirm,
  disabled = false,
  surfaceClassName,
  recessClassName,
  circleHoverClassName
}: {
  ariaLabel: string
  onConfirm: () => void
  disabled?: boolean
  surfaceClassName?: string
  recessClassName?: string
  circleHoverClassName?: string
}) {
  return (
    <DeleteButton
      label={ariaLabel}
      disabled={disabled}
      onConfirm={onConfirm}
      surfaceClassName={surfaceClassName}
      recessClassName={recessClassName}
      circleHoverClassName={circleHoverClassName}
      className="pointer-events-auto shrink-0 opacity-0 transition-opacity group-hover/session:opacity-100 group-hover/chat:opacity-100 has-[:focus-visible]:opacity-100 data-[state=open]:opacity-100"
    />
  )
}
