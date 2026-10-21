/** The sidebar's running / unread indicators and close action share one fixed-width slot. */
import { cn } from '../../lib/utils'
import { SessionRunningOrb } from '../RunningSpinners'
import { CloseButton } from '../CloseButton'
import { sidebarButtonSurface } from './sidebar-surface'
import { useT } from '../../hooks/useT'

/** Gives way to the row's hover action, like the running orb. */
export function SessionUnreadDot() {
  const t = useT()
  return (
    <span
      role="img"
      aria-label={t('sessions.unread')}
      className="pointer-events-none absolute size-1.5 rounded-full bg-primary transition-opacity group-hover/session:opacity-0 group-focus-within/close-slot:opacity-0"
    />
  )
}

export function SessionCloseButton({
  streaming,
  unread = false,
  ariaLabel,
  onClose,
  disabled = false
}: {
  streaming: boolean
  unread?: boolean
  ariaLabel: string
  onClose: () => void
  disabled?: boolean
}) {
  return (
    <span className="group/close-slot relative flex size-6 shrink-0 items-center justify-center">
      {streaming ? (
        <SessionRunningOrb className="transition-opacity group-hover/session:opacity-0 group-focus-within/close-slot:opacity-0" />
      ) : unread ? (
        <SessionUnreadDot />
      ) : null}
      <CloseButton
        streaming={streaming}
        ariaLabel={ariaLabel}
        disabled={disabled}
        onClose={onClose}
        className={cn(
          sidebarButtonSurface,
          'pointer-events-none text-muted-foreground transition-opacity group-hover/session:pointer-events-auto group-hover/session:opacity-100 group-focus-within/close-slot:pointer-events-auto group-focus-within/close-slot:opacity-100'
        )}
      />
    </span>
  )
}
