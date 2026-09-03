import { Helix } from 'ldrs/react'
import 'ldrs/react/Helix.css'
import { cn } from '../lib/utils'

export function SquaresSpinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'flex size-6 shrink-0 items-center justify-center text-muted-foreground',
        className
      )}
      aria-hidden
    >
      <Helix size="14" speed="2.5" color="currentColor" />
    </span>
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
