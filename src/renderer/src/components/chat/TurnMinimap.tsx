import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Turn } from '../../chat/turns'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'

const MIN_WIDTH = 6
const MAX_WIDTH = 18
const DOCK_SCALE = 0.55
const DOCK_REACH = 3
const BAR_HEIGHT = 2
const GAP = 8
const PADDING_Y = 8
const FADE = PADDING_Y + 4 * BAR_HEIGHT + 3 * GAP

function userText(user: Turn['user']): string[] {
  if (!user) return []
  if (typeof user.content === 'string') return [user.content]
  return user.content.flatMap((block) => block.type === 'text' ? [block.text] : [])
}

function describeTurn(turn: Turn, index: number) {
  const user = userText(turn.user)
  const answer = turn.answer.flatMap((block) => block.type === 'text' ? [block.text] : [])
  const length = [...user, ...answer].reduce((sum, text) => sum + text.length, 0)
  const text = user.find((value) => value.length > 0) ?? answer.find((value) => value.length > 0)
  const preview = text?.slice(0, 160).replace(/\s+/g, ' ').trim().slice(0, 60)
  return {
    id: turn.id ?? String(index),
    length,
    label: `第 ${index + 1} 轮${preview ? `：${preview}` : turn.user ? '：图片消息' : '对话'}`
  }
}

function dockBoost(index: number, position: number | null): number {
  if (position == null) return 0
  const distance = Math.abs(index - position)
  return distance >= DOCK_REACH ? 0 : Math.cos((distance / DOCK_REACH) * (Math.PI / 2))
}

export function TurnMinimap({ items, onJump }: { items: Turn[]; onJump: (index: number) => void }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [hoverPos, setHoverPos] = useState<number | null>(null)
  const [focusIndex, setFocusIndex] = useState(0)
  const [focused, setFocused] = useState(false)
  const [overflow, setOverflow] = useState({ top: false, bottom: false })
  const { rows, maxLength } = useMemo(() => {
    let maxLength = 1
    const rows = items.map((turn, index) => {
      const row = describeTurn(turn, index)
      maxLength = Math.max(maxLength, row.length)
      return row
    })
    return { rows, maxLength }
  }, [items])

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

  if (items.length === 0) return null
  const activeIndex = Math.min(focusIndex, items.length - 1)
  const position = hoverPos ?? (focused ? activeIndex : null)
  const hoveredIndex = position == null ? -1 : Math.min(items.length - 1, Math.max(0, Math.round(position)))
  const mask = `linear-gradient(to bottom, ${overflow.top ? 'transparent' : 'black'} 0, black ${FADE}px, black calc(100% - ${FADE}px), ${overflow.bottom ? 'transparent' : 'black'} 100%)`
  const pointerPosition = (element: HTMLDivElement, clientY: number) =>
    (clientY - element.getBoundingClientRect().top + element.scrollTop - PADDING_Y - BAR_HEIGHT / 2) /
    (BAR_HEIGHT + GAP)

  return (
    <div
      ref={rootRef}
      role="navigation"
      aria-label="对话轮次导航"
      className="absolute top-1/2 right-3 z-10 flex max-h-3/4 min-w-9 -translate-y-1/2 cursor-pointer flex-col items-end gap-2 overflow-y-auto py-2 pl-10 pr-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{ maskImage: mask, WebkitMaskImage: mask }}
      onScroll={(event) => syncOverflow(event.currentTarget)}
      onPointerMove={(event) => setHoverPos(pointerPosition(event.currentTarget, event.clientY))}
      onPointerLeave={() => setHoverPos(null)}
      onBlur={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFocused(false)
      }}
      onClick={(event) => {
        const index = Math.round(pointerPosition(event.currentTarget, event.clientY))
        if (index >= 0 && index < items.length) onJump(index)
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
        rootRef.current?.querySelector<HTMLButtonElement>(`[data-turn-index="${next}"]`)?.focus()
      }}
    >
      {rows.map((row, index) => {
        const width = MIN_WIDTH + Math.sqrt(row.length / maxLength) * (MAX_WIDTH - MIN_WIDTH)
        return (
          <Button
            key={row.id}
            type="button"
            variant="link"
            tabIndex={index === activeIndex ? 0 : -1}
            aria-label={row.label}
            data-turn-index={index}
            className={cn(
              'h-0.5 origin-right shrink-0 rounded-full border-0 p-0 transition-[width] duration-300 ease-out active:translate-y-0',
              index === hoveredIndex ? 'bg-foreground' : 'bg-border'
            )}
            style={{ width: position == null ? MIN_WIDTH : width, transform: `scaleX(${1 + DOCK_SCALE * dockBoost(index, position)})` }}
            onFocus={(event) => { setFocusIndex(index); setFocused(event.currentTarget.matches(':focus-visible')) }}
            onClick={(event) => { event.stopPropagation(); onJump(index) }}
          />
        )
      })}
    </div>
  )
}
