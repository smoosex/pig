/**
 * Global top-left header button to toggle the Kanban board from Workspace or Bot mode.
 * Sits immediately to the right of `BotOrbButton` so global stage switches stay at fixed coordinates.
 */
import { Columns3 } from 'lucide-react'
import { useT } from '../../hooks/useT'
import { cn } from '../../lib/utils'
import { ShortcutKbd } from '../ShortcutKbd'
import { sidebarSurfaceToggle } from '../sidebar/sidebar-surface'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

export function KanbanToggleButton({
  active = false,
  onClick,
  className,
  ...rest
}: {
  active?: boolean
  onClick: () => void
  className?: string
  'data-bot-open-kanban'?: boolean
}) {
  const t = useT()
  const label = t(active ? 'kanban.closeBoard' : 'kanban.openBoard')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-kanban-toggle
          {...rest}
          aria-label={label}
          aria-pressed={active}
          onClick={onClick}
          className={cn(
            'no-drag translate-y-px text-muted-foreground hover:text-foreground',
            sidebarSurfaceToggle,
            className
          )}
        >
          <Columns3 />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start">
        <span>{label}</span>
        <span className="ml-1.5 inline-flex">
          <ShortcutKbd action="kanban.toggle" />
        </span>
      </TooltipContent>
    </Tooltip>
  )
}
