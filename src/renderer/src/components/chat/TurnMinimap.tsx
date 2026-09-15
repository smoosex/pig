import { useVirtualizer } from '@tanstack/react-virtual'
import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MinimapItem } from '../../chat/minimap'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'

const MIN_WIDTH = 6
const MAX_WIDTH = 18
const DOCK_SCALE = 0.55
const DOCK_REACH = 3
const BAR_HEIGHT = 2
const GAP = 8
const ITEM_SIZE = BAR_HEIGHT + GAP
const OVERSCAN = 8
const PADDING_Y = 8
const FADE = PADDING_Y + 4 * BAR_HEIGHT + 3 * GAP

function dockBoost(index: number, position: number | null): number {
  if (position == null) return 0
  const distance = Math.abs(index - position)
  return distance >= DOCK_REACH ? 0 : Math.cos((distance / DOCK_REACH) * (Math.PI / 2))
}

export const TurnMinimap = memo(function TurnMinimap({
  items,
  onJump
}: {
  items: MinimapItem[]
  onJump: (index: number) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [hoverPos, setHoverPos] = useState<number | null>(null)
  const [focusIndex, setFocusIndex] = useState(0)
  const [pendingFocusIndex, setPendingFocusIndex] = useState<number | null>(null)
  const [focused, setFocused] = useState(false)
  const [overflow, setOverflow] = useState({ top: false, bottom: false })
  const { rows, maxLength } = useMemo(() => {
    let maxLength = 1
    const rows = items.map((item) => {
      maxLength = Math.max(maxLength, item.length)
      return item
    })
    return { rows, maxLength }
  }, [items])
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => rootRef.current,
    getItemKey: (index) => rows[index]?.id ?? index,
    estimateSize: () => ITEM_SIZE,
    overscan: OVERSCAN
  })
  const virtualRows = virtualizer.getVirtualItems()

  function syncOverflow(element: HTMLDivElement): void {
    const top = element.scrollTop > 1
    const bottom = element.scrollTop + element.clientHeight < element.scrollHeight - 1
    setOverflow((previous) => previous.top === top && previous.bottom === bottom ? previous : { top, bottom })
  }

  useLayoutEffect(() => {
    const element = rootRef.current
    if (!element) return
    const sync = () => syncOverflow(element)
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(element)
    return () => observer.disconnect()
  }, [items.length])

  useLayoutEffect(() => {
    if (pendingFocusIndex == null) return
    const target = rootRef.current?.querySelector<HTMLButtonElement>(`[data-turn-index="${pendingFocusIndex}"]`)
    if (!target) return
    target.focus()
    setPendingFocusIndex(null)
  }, [pendingFocusIndex, virtualRows])

  if (items.length === 0) return null
  const activeIndex = Math.min(focusIndex, items.length - 1)
  const tabbableIndex = virtualRows.some((row) => row.index === activeIndex)
    ? activeIndex
    : virtualRows[0]?.index ?? activeIndex
  const position = hoverPos ?? (focused ? activeIndex : null)
  const hoveredIndex = position == null ? -1 : Math.min(items.length - 1, Math.max(0, Math.round(position)))
  const mask = `linear-gradient(to bottom, ${overflow.top ? 'transparent' : 'black'} 0, black ${FADE}px, black calc(100% - ${FADE}px), ${overflow.bottom ? 'transparent' : 'black'} 100%)`
  const pointerPosition = (element: HTMLDivElement, clientY: number) =>
    (clientY - element.getBoundingClientRect().top + element.scrollTop - PADDING_Y - BAR_HEIGHT / 2) /
    ITEM_SIZE

  return (
    <div
      ref={rootRef}
      role="navigation"
      aria-label="对话轮次导航"
      className="absolute top-1/2 right-3 z-10 w-16 max-h-3/4 -translate-y-1/2 cursor-pointer overflow-y-auto py-2 pl-10 pr-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{ maskImage: mask, WebkitMaskImage: mask }}
      onScroll={(event) => syncOverflow(event.currentTarget)}
      onPointerMove={(event) => setHoverPos(pointerPosition(event.currentTarget, event.clientY))}
      onPointerLeave={() => setHoverPos(null)}
      onBlur={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFocused(false)
      }}
      onClick={(event) => {
        const index = Math.round(pointerPosition(event.currentTarget, event.clientY))
        const item = items[index]
        if (item) onJump(item.turn)
      }}
      onKeyDown={(event) => {
        let next = activeIndex
        if (event.key === 'ArrowDown') next = Math.min(items.length - 1, activeIndex + 1)
        else if (event.key === 'ArrowUp') next = Math.max(0, activeIndex - 1)
        else if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = items.length - 1
        else return
        event.preventDefault()
        event.stopPropagation()
        setFocused(true)
        setFocusIndex(next)
        setPendingFocusIndex(next)
        virtualizer.scrollToIndex(next, { align: 'auto' })
      }}
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualRows.map((virtualRow) => {
          const index = virtualRow.index
          const row = rows[index]
          const width = MIN_WIDTH + Math.sqrt(row.length / maxLength) * (MAX_WIDTH - MIN_WIDTH)
          return (
            <div
              key={virtualRow.key}
              className="absolute top-0 left-0 flex w-full justify-end"
              style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
            >
              <Button
                type="button"
                variant="link"
                tabIndex={index === tabbableIndex ? 0 : -1}
                aria-label={row.label}
                data-turn-index={index}
                className={cn(
                  'h-0.5 origin-right shrink-0 rounded-full border-0 p-0 transition-[width] duration-300 ease-out active:translate-y-0',
                  index === hoveredIndex ? 'bg-foreground' : 'bg-border'
                )}
                style={{ width: position == null ? MIN_WIDTH : width, transform: `scaleX(${1 + DOCK_SCALE * dockBoost(index, position)})` }}
                onFocus={(event) => {
                  setPendingFocusIndex(null)
                  setFocusIndex(index)
                  setFocused(event.currentTarget.matches(':focus-visible'))
                }}
                onClick={(event) => { event.stopPropagation(); onJump(row.turn) }}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
})
