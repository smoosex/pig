/**
 * Catalog icon rendered through main's cache; a listing without a usable icon shows its initial.
 * The tile is a rounded square rather than Avatar's circle, so every part overrides that radius.
 */
import { cn } from '@/lib/utils'
import { mcpIconUrl } from '../../../../shared/mcp-icons'
import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar'

const TILE = 'rounded-lg after:rounded-lg'

export function McpIcon({
  source,
  name,
  className
}: {
  source?: string
  name: string
  className?: string
}) {
  return (
    <Avatar className={cn(TILE, className)}>
      {/* Radix swaps in the fallback when the image is missing or fails to load. */}
      {source ? <AvatarImage src={mcpIconUrl(source)} alt="" className={TILE} /> : null}
      <AvatarFallback className={cn(TILE, 'bg-muted text-xs')}>
        {name
          .replace(/^[^a-z0-9]+/i, '')
          .charAt(0)
          .toUpperCase() || '?'}
      </AvatarFallback>
    </Avatar>
  )
}
