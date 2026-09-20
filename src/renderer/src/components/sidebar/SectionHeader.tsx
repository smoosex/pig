import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'

export function SectionHeader({
  label,
  collapsed,
  onToggle,
  action,
  className
}: {
  label: string
  collapsed: boolean
  onToggle: () => void
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'sticky z-10 shrink-0 bg-sidebar px-1 has-[[data-sidebar-hover-target]]:bg-transparent',
        className
      )}
    >
      <div
        data-sidebar-hover-row
        className="group/header relative flex h-8 items-center gap-0.5 rounded-md px-1"
      >
        <Button
          variant="ghost"
          className="h-full min-w-0 flex-1 justify-start gap-1 rounded-md px-0 text-xs font-normal text-muted-foreground !bg-transparent"
          onClick={onToggle}
        >
          <ChevronRight
            className={cn('size-2.5 shrink-0 transition-transform', !collapsed && 'rotate-90')}
          />
          <span className="truncate">{label}</span>
        </Button>
        {action}
      </div>
    </div>
  )
}
