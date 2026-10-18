/**
 * Catalog icon rendered through main's cache; a listing without a usable icon shows its initial.
 * The tile is a rounded square rather than Avatar's circle, so every part overrides that radius.
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { mcpIconUrl } from '../../../../shared/mcp-icons'
import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar'

const TILE = 'rounded-lg after:rounded-lg'

export function McpIcon({
  source,
  name,
  fallback,
  className
}: {
  source?: string
  name: string
  /** Shown instead of the initial when there is no icon or it fails to load. */
  fallback?: ReactNode
  className?: string
}) {
  return (
    <Avatar className={cn(TILE, 'shadow-glass-inline-code after:pointer-events-none after:border-glass-button-border after:mix-blend-normal dark:after:mix-blend-normal solid:shadow-none solid:after:border-border solid:after:mix-blend-darken solid:dark:after:mix-blend-lighten', className)}>
      {/* Radix swaps in the fallback when the image is missing or fails to load. */}
      {source ? <AvatarImage src={mcpIconUrl(source)} alt="" className={TILE} /> : null}
      <AvatarFallback className={cn(TILE, 'bg-glass-button-background bg-[image:var(--glass-button-sheen)] text-xs text-glass-prompt-foreground solid:bg-muted solid:bg-none solid:text-muted-foreground')}>
        {fallback ??
          (name
            .replace(/^[^a-z0-9]+/i, '')
            .charAt(0)
            .toUpperCase() || '?')}
      </AvatarFallback>
    </Avatar>
  )
}
