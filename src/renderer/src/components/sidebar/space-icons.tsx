/** Curated Lucide icon set and dot indicator for Project Spaces. */
import {
  BookOpen,
  Code2,
  Compass,
  Cpu,
  Database,
  FlaskConical,
  Folder,
  Globe,
  Layers,
  Palette,
  Rocket,
  Sparkles,
  SquareTerminal,
  Star,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import type { ProjectSpaceIcon } from '../../../../shared/project-spaces'
import { cn } from '../../lib/utils'

export const SPACE_ICON_MAP: Record<Exclude<ProjectSpaceIcon, 'dot'>, LucideIcon> = {
  sparkles: Sparkles,
  folder: Folder,
  code: Code2,
  terminal: SquareTerminal,
  rocket: Rocket,
  layers: Layers,
  globe: Globe,
  compass: Compass,
  flask: FlaskConical,
  palette: Palette,
  database: Database,
  book: BookOpen,
  cpu: Cpu,
  wrench: Wrench,
  star: Star
}

export function SpaceGlyph({
  icon,
  active = true,
  forceDot = false,
  className
}: {
  icon?: ProjectSpaceIcon
  active?: boolean
  forceDot?: boolean
  className?: string
}) {
  if (forceDot || !icon || icon === 'dot') {
    return (
      <span
        data-space-dot=""
        aria-hidden="true"
        className={cn(
          'block rounded-full bg-current transition-[width,height,opacity] duration-150 motion-reduce:transition-none',
          active ? 'size-1.25 opacity-100' : 'size-1 opacity-45',
          className
        )}
      />
    )
  }
  const Icon = SPACE_ICON_MAP[icon]
  return (
    <Icon
      data-space-icon={icon}
      aria-hidden="true"
      className={cn(
        'size-3 shrink-0 transition-opacity duration-150 motion-reduce:transition-none',
        !active && 'opacity-70',
        className
      )}
    />
  )
}
