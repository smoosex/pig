import { Avatar, AvatarFallback } from '../ui/avatar'
import { cn } from '../../lib/utils'

const projectAvatarBg = [
  'bg-chart-1',
  'bg-chart-2',
  'bg-chart-3',
  'bg-chart-4',
  'bg-chart-5'
] as const

export function ProjectAvatar({ name, index }: { name: string; index: number }) {
  return (
    <Avatar className="size-5 rounded-sm after:pointer-events-none after:rounded-sm after:border-glass-button-border after:mix-blend-normal dark:after:mix-blend-normal solid:after:border-border solid:after:mix-blend-darken solid:dark:after:mix-blend-lighten">
      <AvatarFallback
        className={cn(
          'rounded-sm bg-[image:var(--glass-badge-sheen)] text-xs font-normal text-primary-foreground shadow-glass-badge solid:bg-none solid:shadow-none',
          projectAvatarBg[index % projectAvatarBg.length]
        )}
      >
        {name.trim().charAt(0).toUpperCase() || '?'}
      </AvatarFallback>
    </Avatar>
  )
}
