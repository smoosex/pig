import { useVirtualizer } from '@tanstack/react-virtual'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../ipc/api'
import { buildTurn } from '../../chat/turns'
import { isPiMessage } from '../../pi/types'
import { turnMinimapPreview, type MinimapItem, type MinimapPreview } from '../../chat/minimap'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../ui/hover-card'
import { useMessageScrollerVisibility } from '../ui/message-scroller'

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
const PREVIEW_CACHE_LIMIT = 128
const CARD_DELAY = 50
const CARD_MOVE_MS = 150
const PREVIEW_REQUEST_DELAY = 100
const SCROLL_BUFFER_ITEMS = 5

const previewCache = new Map<string, MinimapPreview>()
const previewRequests = new Map<string, Promise<MinimapPreview>>()

function dockBoost(index: number, position: number | null): number {
  if (position == null) return 0
  const distance = Math.abs(index - position)
  return distance >= DOCK_REACH ? 0 : Math.cos((distance / DOCK_REACH) * (Math.PI / 2))
}

function rememberPreview(key: string, preview: MinimapPreview): MinimapPreview {
  previewCache.delete(key)
  previewCache.set(key, preview)
  if (previewCache.size > PREVIEW_CACHE_LIMIT) previewCache.delete(previewCache.keys().next().value!)
  return preview
}

function requestPreview(sessionId: string, branchViewId: string, turnId: string): Promise<MinimapPreview> {
  const key = `${sessionId}\u0000${branchViewId}\u0000${turnId}`
  const cached = previewCache.get(key)
  if (cached) return Promise.resolve(rememberPreview(key, cached))
  const pending = previewRequests.get(key)
  if (pending) return pending
  const request = api.getTurnMessages(sessionId, turnId)
    .then((raw) => {
      const messages = (raw ?? []).filter(isPiMessage)
      if (messages.length === 0) throw new Error('Turn preview is empty')
      return rememberPreview(key, turnMinimapPreview(buildTurn(messages, false)))
    })
    .finally(() => previewRequests.delete(key))
  previewRequests.set(key, request)
  return request
}

function TurnPreviewCard({
  item,
  sessionId,
  branchViewId,
  loadedPreview
}: {
  item: MinimapItem
  sessionId: string
  branchViewId: string
  loadedPreview: (turn: number, turnId: string) => MinimapPreview | undefined
}) {
  const [preview, setPreview] = useState<MinimapPreview | null>(() => loadedPreview(item.turn, item.turnId) ?? null)
  const [loading, setLoading] = useState(() => preview == null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const loaded = loadedPreview(item.turn, item.turnId)
    if (loaded) {
      setPreview(loaded)
      setLoading(false)
      setFailed(false)
      return
    }
    let current = true
    setLoading(true)
    setFailed(false)
    const timer = window.setTimeout(() => {
      void requestPreview(sessionId, branchViewId, item.turnId).then(
        (next) => {
          if (!current) return
          setPreview(next)
          setLoading(false)
          setFailed(false)
        },
        () => {
          if (!current) return
          setPreview(null)
          setLoading(false)
          setFailed(true)
        }
      )
    }, PREVIEW_REQUEST_DELAY)
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [branchViewId, item.turn, item.turnId, loadedPreview, sessionId])

  if (failed) return <p className="text-muted-foreground">预览加载失败</p>

  const question = preview?.question || (preview?.hasQuestionImage || item.hasImages ? '图片消息' : loading ? '正在加载…' : '暂无提问')
  const answer = preview?.answer || (preview?.hasAnswerImage
    ? '图片回复'
    : preview?.streaming
      ? '正在生成…'
      : preview?.error
        ? '回答失败'
        : loading
          ? '正在加载…'
          : '暂无最终回答')
  const compact = (text: string) => text.replace(/\s+/g, ' ').trim()

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="line-clamp-1 break-words font-medium text-foreground">{compact(question)}</p>
      <p className="line-clamp-3 break-words text-muted-foreground">{compact(answer)}</p>
    </div>
  )
}

export const TurnMinimap = memo(function TurnMinimap({
  items,
  sessionId,
  branchViewId,
  indexTrusted,
  loadedPreview,
  onJump
}: {
  items: MinimapItem[]
  sessionId: string
  branchViewId: string
  indexTrusted: boolean
  loadedPreview: (turn: number, turnId: string) => MinimapPreview | undefined
  onJump: (index: number) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const pointerRef = useRef<{ x: number; y: number } | null>(null)
  const movementSource = useRef<'pointer' | 'scroll'>('pointer')
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  const previousPreviewIndex = useRef<number | null>(null)
  const [hoverPos, setHoverPos] = useState<number | null>(null)
  const [focusIndex, setFocusIndex] = useState(0)
  const [pendingFocusIndex, setPendingFocusIndex] = useState<number | null>(null)
  const [focused, setFocused] = useState(false)
  const [contentHovered, setContentHovered] = useState(false)
  const [cardOpen, setCardOpen] = useState(false)
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [moving, setMoving] = useState(false)
  const [overflow, setOverflow] = useState({ top: false, bottom: false })
  const { visibleMessageIds } = useMessageScrollerVisibility()
  const { rows, maxLength, indexById } = useMemo(() => {
    let maxLength = 1
    const indexById = new Map<string, number>()
    const rows = items.map((item, index) => {
      maxLength = Math.max(maxLength, item.length)
      indexById.set(item.id, index)
      return item
    })
    return { rows, maxLength, indexById }
  }, [items])
  const visibleIndexes = useMemo(() => {
    if (!indexTrusted) return new Set<number>()
    return new Set(visibleMessageIds.flatMap((id) => {
      const index = indexById.get(id)
      return index == null ? [] : [index]
    }))
  }, [indexById, indexTrusted, visibleMessageIds])
  const currentMessageId = visibleMessageIds[visibleMessageIds.length - 1]
  const currentIndex = indexTrusted ? indexById.get(currentMessageId ?? '') ?? -1 : -1
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

  useLayoutEffect(() => {
    const element = rootRef.current
    if (currentIndex < 0 || !element || element.clientHeight <= 0) return
    if (virtualizer.getTotalSize() + PADDING_Y * 2 <= element.clientHeight) return
    const firstVisible = Math.max(
      0,
      Math.floor((element.scrollTop - PADDING_Y - BAR_HEIGHT) / ITEM_SIZE) + 1
    )
    const lastVisible = Math.min(
      rows.length - 1,
      Math.ceil((element.scrollTop + element.clientHeight - PADDING_Y) / ITEM_SIZE) - 1
    )
    if (lastVisible - firstVisible < SCROLL_BUFFER_ITEMS * 2) {
      virtualizer.scrollToIndex(currentIndex, { align: 'center' })
    } else if (currentIndex < firstVisible + SCROLL_BUFFER_ITEMS) {
      virtualizer.scrollToIndex(Math.max(0, currentIndex - SCROLL_BUFFER_ITEMS), { align: 'start' })
    } else if (currentIndex > lastVisible - SCROLL_BUFFER_ITEMS) {
      virtualizer.scrollToIndex(Math.min(rows.length - 1, currentIndex + SCROLL_BUFFER_ITEMS), { align: 'end' })
    }
  }, [currentIndex, rows.length, virtualizer])

  const activeIndex = Math.min(focusIndex, items.length - 1)
  const tabbableIndex = virtualRows.some((row) => row.index === activeIndex)
    ? activeIndex
    : virtualRows[0]?.index ?? activeIndex
  const position = hoverPos ?? (focused ? activeIndex : null)
  const hoveredIndex = position == null ? -1 : Math.min(items.length - 1, Math.max(0, Math.round(position)))
  const targetIndex = hoveredIndex >= 0 ? hoveredIndex : focused && activeIndex >= 0 ? activeIndex : null

  useEffect(() => {
    const clearOpen = () => {
      if (openTimer.current == null) return
      window.clearTimeout(openTimer.current)
      openTimer.current = null
    }
    const clearClose = () => {
      if (closeTimer.current == null) return
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    if (targetIndex != null) {
      setPreviewIndex(targetIndex)
      clearClose()
      if (cardOpen) {
        clearOpen()
        return
      }
      clearOpen()
      openTimer.current = window.setTimeout(() => {
        openTimer.current = null
        setCardOpen(true)
      }, CARD_DELAY)
      return
    }
    clearOpen()
    if (contentHovered) {
      clearClose()
      return
    }
    if (!cardOpen) return
    clearClose()
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      setCardOpen(false)
    }, CARD_DELAY)
  }, [cardOpen, contentHovered, targetIndex])

  useEffect(() => () => {
    if (openTimer.current != null) window.clearTimeout(openTimer.current)
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current)
  }, [])

  useEffect(() => {
    const previous = previousPreviewIndex.current
    previousPreviewIndex.current = previewIndex
    if (
      movementSource.current === 'scroll' ||
      !cardOpen ||
      previous == null ||
      previewIndex == null ||
      previous === previewIndex
    ) {
      setMoving(false)
      return
    }
    setMoving(true)
    const timer = window.setTimeout(() => setMoving(false), CARD_MOVE_MS + 30)
    return () => window.clearTimeout(timer)
  }, [cardOpen, previewIndex])

  if (items.length === 0) return null
  const previewItem = previewIndex == null ? undefined : rows[previewIndex]
  const mask = `linear-gradient(to bottom, ${overflow.top ? 'transparent' : 'black'} 0, black ${FADE}px, black calc(100% - ${FADE}px), ${overflow.bottom ? 'transparent' : 'black'} 100%)`
  const pointerPosition = (clientX: number, clientY: number): number | null => {
    const track = trackRef.current
    if (!track) return null
    const rect = track.getBoundingClientRect()
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null
    return (clientY - rect.top - BAR_HEIGHT / 2) / ITEM_SIZE
  }

  return (
    <div
      ref={rootRef}
      role="navigation"
      aria-label="对话轮次导航"
      className="absolute top-1/2 right-4 z-10 w-5 max-h-3/4 -translate-y-1/2 cursor-pointer overflow-y-auto py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{ maskImage: mask, WebkitMaskImage: mask }}
      onScroll={(event) => {
        syncOverflow(event.currentTarget)
        const pointer = pointerRef.current
        if (!pointer) return
        movementSource.current = 'scroll'
        setHoverPos(pointerPosition(pointer.x, pointer.y))
      }}
      onPointerMove={(event) => {
        const position = pointerPosition(event.clientX, event.clientY)
        pointerRef.current = position == null ? null : { x: event.clientX, y: event.clientY }
        movementSource.current = 'pointer'
        setHoverPos(position)
      }}
      onPointerLeave={() => {
        pointerRef.current = null
        setHoverPos(null)
      }}
      onBlur={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFocused(false)
      }}
      onClick={(event) => {
        const position = pointerPosition(event.clientX, event.clientY)
        if (position == null) return
        const item = items[Math.round(position)]
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
        movementSource.current = 'pointer'
        setFocused(true)
        setFocusIndex(next)
        setPendingFocusIndex(next)
        virtualizer.scrollToIndex(next, { align: 'auto' })
      }}
    >
      <div ref={trackRef} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
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
                aria-current={index === currentIndex ? 'step' : undefined}
                data-turn-index={index}
                className={cn(
                  'h-0.5 origin-right shrink-0 rounded-full border-0 p-0 transition-[width] duration-300 ease-out active:translate-y-0',
                  index === hoveredIndex
                    ? 'bg-foreground'
                    : index === currentIndex
                      ? 'bg-primary'
                      : visibleIndexes.has(index) ? 'bg-primary/50' : 'bg-border'
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
        {previewItem && previewIndex != null ? (
          <HoverCard open={cardOpen} openDelay={CARD_DELAY} closeDelay={CARD_DELAY}>
            <HoverCardTrigger asChild>
              <div
                className="pointer-events-none absolute top-0 right-0 h-0.5 transition-transform ease-out"
                style={{
                  width: MIN_WIDTH,
                  transform: `translateY(${previewIndex * ITEM_SIZE}px)`,
                  transitionDuration: movementSource.current === 'scroll' ? '0ms' : `${CARD_MOVE_MS}ms`
                }}
              />
            </HoverCardTrigger>
            <HoverCardContent
              side="left"
              align="center"
              sideOffset={24}
              updatePositionStrategy={moving ? 'always' : 'optimized'}
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              onPointerEnter={() => setContentHovered(true)}
              onPointerLeave={() => setContentHovered(false)}
              onPointerMove={(event) => event.stopPropagation()}
            >
              <TurnPreviewCard
                key={`${branchViewId}:${previewItem.turnId}`}
                item={previewItem}
                sessionId={sessionId}
                branchViewId={branchViewId}
                loadedPreview={loadedPreview}
              />
            </HoverCardContent>
          </HoverCard>
        ) : null}
      </div>
    </div>
  )
})
