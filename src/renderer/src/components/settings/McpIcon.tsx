/** Catalog icon rendered through main's cache; a listing without a usable icon shows its initial. */
import { mcpIconUrl } from '../../../../shared/mcp-icons'
import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar'

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
    <Avatar className={className}>
      {/* Radix swaps in the fallback when the image is missing or fails to load. */}
      {source ? <AvatarImage src={mcpIconUrl(source)} alt="" /> : null}
      <AvatarFallback className="bg-muted text-xs">
        {name
          .replace(/^[^a-z0-9]+/i, '')
          .charAt(0)
          .toUpperCase() || '?'}
      </AvatarFallback>
    </Avatar>
  )
}
