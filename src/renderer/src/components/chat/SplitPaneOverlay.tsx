import type { FC } from 'react'
import { cn } from '../../lib/utils'

export type SplitDropPosition = 'left' | 'right' | 'top' | 'bottom'

export interface SplitPaneOverlayProps {
  position: SplitDropPosition | null
  className?: string
}

const positionClasses: Record<SplitDropPosition, string> = {
  left: 'top-0 left-0 w-1/2 h-full',
  right: 'top-0 right-0 w-1/2 h-full',
  top: 'top-0 left-0 w-full h-1/2',
  bottom: 'bottom-0 left-0 w-full h-1/2'
}

export const SplitPaneOverlay: FC<SplitPaneOverlayProps> = ({ position, className }) => {
  if (!position) {
    return null
  }

  return (
    <div
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute z-50 rounded-lg border-2 border-primary/40 bg-primary/15 transition-all duration-150 ease-out',
        positionClasses[position],
        className
      )}
    />
  )
}

export default SplitPaneOverlay
