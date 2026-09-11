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
    <Avatar className="size-5 rounded-sm after:rounded-sm">
      <AvatarFallback
        className={cn(
          'rounded-sm text-xs font-normal text-primary-foreground',
          projectAvatarBg[index % projectAvatarBg.length]
        )}
      >
        {name.trim().charAt(0).toUpperCase() || '?'}
      </AvatarFallback>
    </Avatar>
  )
}
