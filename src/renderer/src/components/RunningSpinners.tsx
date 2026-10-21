import { ThinkingOrb } from 'thinking-orbs'
import { useDarkMode } from '../lib/useDarkMode'
import { cn } from '../lib/utils'

/** A running session's indicator in session lists (sidebar rows, the history popover). */
export function SessionRunningOrb({ className }: { className?: string }) {
  // Pig only ever toggles the `dark` class, so let the orb read it instead of
  // resolving `auto` against prefers-color-scheme, which a pinned appearance overrides.
  const dark = useDarkMode()
  return (
    <ThinkingOrb
      state="breathing"
      size={20}
      theme={dark ? 'dark' : 'light'}
      aria-hidden
      className={cn('pointer-events-none', className)}
    />
  )
}

export function CloseSpin({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn('pointer-events-none absolute inset-0 size-full text-muted-foreground', className)}
      aria-hidden
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        opacity="0.25"
      />
      <circle
        className="close-spin"
        cx="12"
        cy="12"
        r="10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeDasharray="16 47"
      />
    </svg>
  )
}
