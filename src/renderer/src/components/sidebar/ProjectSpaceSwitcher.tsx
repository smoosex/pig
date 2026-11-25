/**
 * Compact macOS Dock-inspired space switcher strip centered in the Projects sidebar footer:
 * - Tighter spacing and smaller 12px icons (`size-3`) / 4px–5px dots.
 * - When `spaces.length > 3`, only the active space displays its icon; inactive spaces collapse to dots
 *   until hovered, expanding and revealing their icon on hover.
 * - Continuous pointer-distance cosine bell-curve magnification (`motion` springs) gives neighbors a smooth
 *   Dock wave lift without clipping.
 * - Supports wheel / horizontal swipe directly over the strip.
 */
import { forwardRef, useEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react'
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform, type MotionValue } from 'motion/react'
import { PenLine, Plus, Sparkles, Trash2 } from 'lucide-react'
import { resolveProjectSpaceId, type ProjectSpace } from '../../../../shared/project-spaces'
import { api } from '../../ipc/api'
import { useT } from '../../hooks/useT'
import { cn, hideScroll } from '../../lib/utils'
import { spaceDisplayName, useProjectSpacesStore } from '../../stores/project-spaces'
import { useSessionsStore } from '../../stores/sessions'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '../ui/context-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { sidebarSurfaceHover } from './sidebar-surface'
import { SpaceGlyph } from './space-icons'
import { useSpaceWheelSwipe } from './use-space-swipe'

const DOCK_RADIUS_PX = 42
const DOCK_MAX_SCALE = 0.42
const DOCK_MAX_LIFT_PX = 2.5

export function useProjectSpacesSync(): void {
  useEffect(() => {
    const store = useProjectSpacesStore.getState()
    void store.load()
    if (!api?.spaces?.onChanged) return
    return api.spaces.onChanged((snapshot) => {
      useProjectSpacesStore.getState().applySnapshot(snapshot)
    })
  }, [])
}

function useDockMagnification(
  mouseX: MotionValue<number>,
  buttonRef: React.RefObject<HTMLButtonElement | null>,
  reduced: boolean
) {
  const factor = useTransform(mouseX, (x) => {
    if (reduced || !Number.isFinite(x) || !buttonRef.current) return 0
    const rect = buttonRef.current.getBoundingClientRect()
    if (rect.width <= 0) return 0
    const dist = Math.abs(x - (rect.left + rect.width / 2))
    if (dist >= DOCK_RADIUS_PX) return 0
    return 0.5 * (1 + Math.cos((Math.PI * dist) / DOCK_RADIUS_PX))
  })
  const smooth = useSpring(factor, { mass: 0.08, stiffness: 380, damping: 24 })
  const scale = useTransform(smooth, (f) => 1 + f * DOCK_MAX_SCALE)
  const y = useTransform(smooth, (f) => -f * DOCK_MAX_LIFT_PX)
  return { scale, y }
}

const DockSpaceButton = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<'button'> & {
    space: ProjectSpace
    active: boolean
    hovered: boolean
    collapseInactive: boolean
    label: string
    mouseX: MotionValue<number>
    reduced: boolean
  }
>(function DockSpaceButton(
  { space, active, hovered, collapseInactive, label, mouseX, reduced, className, onPointerEnter, onFocus, onBlur, ...props },
  forwardedRef
) {
  const innerRef = useRef<HTMLButtonElement | null>(null)
  const { scale, y } = useDockMagnification(mouseX, innerRef, reduced)
  const showIcon = !collapseInactive || active || hovered
  const compactDotSlot = collapseInactive && !active && !hovered

  return (
    <button
      ref={(node) => {
        innerRef.current = node
        if (typeof forwardedRef === 'function') forwardedRef(node)
        else if (forwardedRef) forwardedRef.current = node
      }}
      type="button"
      role="tab"
      data-space-id={space.id}
      data-space-compact-dot={compactDotSlot ? 'true' : undefined}
      aria-selected={active}
      aria-label={label}
      onPointerEnter={onPointerEnter}
      onFocus={onFocus}
      onBlur={onBlur}
      className={cn(
        'group/space-btn relative inline-flex h-5 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-[width,background-color,color] duration-150 ease-out focus-visible:ring-(length:--focus-ring-width) focus-visible:ring-focus-ring motion-reduce:transition-none',
        compactDotSlot ? 'w-3.5' : 'w-5',
        active
          ? 'bg-sidebar-foreground/10 text-sidebar-foreground hover:bg-sidebar-foreground/12! solid:bg-sidebar-accent solid:text-sidebar-accent-foreground solid:hover:bg-sidebar-accent!'
          : hovered
            ? 'bg-sidebar-foreground/6 text-sidebar-foreground solid:bg-sidebar-accent/70 solid:text-sidebar-accent-foreground'
            : sidebarSurfaceHover,
        className
      )}
      {...props}
    >
      <motion.span
        style={reduced ? undefined : { scale, y }}
        className="pointer-events-none relative flex origin-bottom items-center justify-center will-change-transform"
      >
        <SpaceGlyph icon={space.icon} active={active || hovered} forceDot={!showIcon} />
      </motion.span>
    </button>
  )
})

const DockCreateButton = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<'button'> & {
    label: string
    mouseX: MotionValue<number>
    reduced: boolean
  }
>(function DockCreateButton({ label, mouseX, reduced, className, ...props }, forwardedRef) {
  const innerRef = useRef<HTMLButtonElement | null>(null)
  const { scale, y } = useDockMagnification(mouseX, innerRef, reduced)

  return (
    <button
      ref={(node) => {
        innerRef.current = node
        if (typeof forwardedRef === 'function') forwardedRef(node)
        else if (forwardedRef) forwardedRef.current = node
      }}
      type="button"
      data-space-create=""
      aria-label={label}
      className={cn(
        'relative inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors duration-150 focus-visible:ring-(length:--focus-ring-width) focus-visible:ring-focus-ring motion-reduce:transition-none',
        sidebarSurfaceHover,
        className
      )}
      {...props}
    >
      <motion.span
        style={reduced ? undefined : { scale, y }}
        className="pointer-events-none flex origin-bottom items-center justify-center will-change-transform"
      >
        <Plus className="size-3" />
      </motion.span>
    </button>
  )
})

export function ProjectSpaceSwitcher() {
  const t = useT()
  const reduced = useReducedMotion() ?? false
  const mouseX = useMotionValue(Infinity)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const spaces = useProjectSpacesStore((s) => s.spaces)
  const activeSpaceId = useProjectSpacesStore((s) => s.activeSpaceId)
  const assignments = useProjectSpacesStore((s) => s.assignments)
  const selectSpace = useProjectSpacesStore((s) => s.selectSpace)
  const openDialog = useProjectSpacesStore((s) => s.openDialog)
  const removeSpace = useProjectSpacesStore((s) => s.removeSpace)
  const projects = useSessionsStore((s) => s.projects)
  const handleWheel = useSpaceWheelSwipe({ allowVertical: true })

  const collapseInactive = spaces.length > 3

  const handleDeleteRequest = (spaceId: string) => {
    if (spaces.length <= 1) return
    const count = projects.filter(
      (project) => resolveProjectSpaceId({ spaces, assignments }, project.cwd) === spaceId
    ).length
    if (count === 0) {
      void removeSpace(spaceId).catch(() => {})
    } else {
      openDialog({ mode: 'delete', spaceId })
    }
  }

  return (
    <div
      role="tablist"
      aria-label={t('spaces.switcherAria')}
      onWheel={handleWheel}
      onPointerMove={(event) => mouseX.set(event.clientX)}
      onPointerLeave={() => {
        mouseX.set(Infinity)
        setHoveredId(null)
      }}
      className="flex min-w-0 flex-1 items-center justify-center gap-px px-0.5"
    >
      <div
        className={cn(
          'flex min-w-0 items-center gap-px pt-2 -mt-2 pb-0.5 -mb-0.5',
          spaces.length > 8 && cn('overflow-x-auto', hideScroll)
        )}
      >
        {spaces.map((space) => {
          const active = space.id === activeSpaceId
          const hovered = hoveredId === space.id
          const label = spaceDisplayName(space, t)
          return (
            <ContextMenu key={space.id}>
              <Tooltip>
                <ContextMenuTrigger asChild>
                  <TooltipTrigger asChild>
                    <DockSpaceButton
                      space={space}
                      active={active}
                      hovered={hovered}
                      collapseInactive={collapseInactive}
                      label={label}
                      mouseX={mouseX}
                      reduced={reduced}
                      onPointerEnter={() => setHoveredId(space.id)}
                      onFocus={() => setHoveredId(space.id)}
                      onBlur={() => setHoveredId((prev) => (prev === space.id ? null : prev))}
                      onClick={() => void selectSpace(space.id)}
                    />
                  </TooltipTrigger>
                </ContextMenuTrigger>
                <TooltipContent side="top" sideOffset={6}>
                  {label}
                </TooltipContent>
              </Tooltip>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => openDialog({ mode: 'rename', spaceId: space.id })}>
                  <PenLine data-icon="inline-start" />
                  {t('common.rename')}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => openDialog({ mode: 'icon', spaceId: space.id })}>
                  <Sparkles data-icon="inline-start" />
                  {t('spaces.changeIcon')}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  variant="destructive"
                  disabled={spaces.length <= 1}
                  onSelect={() => handleDeleteRequest(space.id)}
                >
                  <Trash2 data-icon="inline-start" />
                  {t('common.delete')}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          )
        })}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <DockCreateButton
            label={t('spaces.create')}
            mouseX={mouseX}
            reduced={reduced}
            onPointerEnter={() => setHoveredId(null)}
            onClick={() => openDialog({ mode: 'create' })}
          />
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          {t('spaces.create')}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
