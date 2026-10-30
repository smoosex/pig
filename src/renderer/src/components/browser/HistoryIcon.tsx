import { Globe } from 'lucide-react'
import { cn } from '../../lib/utils'

/** A history entry's favicon, or a globe until one has been fetched. */
export function HistoryIcon({ icon, className }: { icon?: string; className?: string }) {
  return icon
    ? <img src={icon} alt="" draggable={false} className={cn('size-3.5 shrink-0 rounded-xs', className)} />
    : <Globe className={cn('size-3.5 shrink-0 opacity-60', className)} />
}
