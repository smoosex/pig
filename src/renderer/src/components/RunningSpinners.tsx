import { cn } from '../lib/utils'

export function SquaresSpinner({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn('size-3.5 shrink-0 text-muted-foreground', className)}
      aria-hidden
    >
      <rect className="squares-chase fill-current" x="1" y="1" rx="1" width="10" height="10" />
      <rect className="squares-chase squares-chase-2 fill-current" x="1" y="1" rx="1" width="10" height="10" />
      <rect className="squares-chase squares-chase-3 fill-current" x="1" y="1" rx="1" width="10" height="10" />
    </svg>
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
