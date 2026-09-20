import { useVirtualizer } from '@tanstack/react-virtual'
import { useReducedMotion } from 'motion/react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent } from 'react'
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
const DOCK_SCALE = 1.5
const DOCK_REACH = 3
const BAR_HEIGHT = 2
const GAP = 8
const ITEM_SIZE = BAR_HEIGHT + GAP
const DOCK_RADIUS = DOCK_REACH * ITEM_SIZE
const DOCK_STIFFNESS = 320
const DOCK_DAMPING = 34
const DOCK_MASS = 0.7
const DOCK_REST_VALUE = 0.002
const DOCK_REST_SPEED = 0.02
const DOCK_MAX_STEP = 1 / 30
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

type DockSpring = { element: HTMLSpanElement | null; value: number; velocity: number }

/** How far one bar stretches for a pointer at this height: full under it, back to 1 a radius away. */
function dockTarget(pointerY: number, element: HTMLElement): number {
  if (!Number.isFinite(pointerY)) return 1
  const rect = element.getBoundingClientRect()
  const distance = Math.abs(pointerY - (rect.top + rect.height / 2))
  return 1 + DOCK_SCALE * Math.max(0, 1 - distance / DOCK_RADIUS)
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

/**
 * One bar of the rail. The width stays React's business, while `transform` is owned by the rail's
 * spring loop, which writes it straight to the node: the dock animation must not go through a
 * re-render, and the rail asserts that unmounting leaves no frame scheduled.
 */
const MinimapBar = ({
  index,
  label,
  turn,
  width,
  hovered,
  current,
  visible,
  docked,
  tabbable,
  registerBar,
  onJump,
  onFocus
}: {
  index: number
  label: string
  turn: number
  width: number
  hovered: boolean
  current: boolean
  visible: boolean
  docked: boolean
  tabbable: boolean
  registerBar: (index: number, element: HTMLSpanElement | null) => void
  onJump: (turn: number) => void
  onFocus: (index: number, event: FocusEvent<HTMLButtonElement>) => void
}) => (
  <Button
    type="button"
    variant="link"
    tabIndex={tabbable ? 0 : -1}
    aria-label={label}
    aria-current={current ? 'step' : undefined}
    data-turn-index={index}
    className="h-0.5 shrink-0 border-0 p-0 active:translate-y-0"
    onFocus={(event) => onFocus(index, event)}
    onClick={(event) => {
      event.stopPropagation()
      onJump(turn)
    }}
  >
    <span
      ref={(element) => registerBar(index, element)}
      className={cn(
        'block h-0.5 origin-right rounded-full transition-[width] duration-300 ease-out',
        hovered ? 'bg-foreground' : current ? 'bg-primary' : visible ? 'bg-primary/50' : 'bg-border'
      )}
      style={{ width: docked ? width : MIN_WIDTH }}
    />
  </Button>
)

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
  const springsRef = useRef(new Map<number, DockSpring>())
  const pointerYRef = useRef(Infinity)
  const dockFrameRef = useRef<number | null>(null)
  const dockTimeRef = useRef(0)
  const reduceMotion = useReducedMotion() ?? false
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
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

  // The whole rail shares one spring loop: a pointer move retargets every mounted bar and each one
  // keeps its own value and velocity. Motion values would put a framesync subscription on every bar,
  // and this view is expected to leave no frame behind when it unmounts.
  const stepDock = useCallback(
    (timestamp: number) => {
      const dt = Math.min(DOCK_MAX_STEP, Math.max(0.001, (timestamp - dockTimeRef.current) / 1000))
      dockTimeRef.current = timestamp
      let moving = false
      for (const [index, spring] of springsRef.current) {
        const element = spring.element
        if (!element) {
          springsRef.current.delete(index)
          continue
        }
        const target = dockTarget(pointerYRef.current, element)
        if (reduceMotion) {
          spring.value = target
          spring.velocity = 0
        } else {
          const force = -DOCK_STIFFNESS * (spring.value - target) - DOCK_DAMPING * spring.velocity
          spring.velocity += (force / DOCK_MASS) * dt
          spring.value += spring.velocity * dt
          if (Math.abs(spring.value - target) < DOCK_REST_VALUE && Math.abs(spring.velocity) < DOCK_REST_SPEED) {
            spring.value = target
            spring.velocity = 0
          } else moving = true
        }
        element.style.transform = `scaleX(${spring.value.toFixed(4)})`
      }
      dockFrameRef.current = moving ? requestAnimationFrame(stepDock) : null
    },
    [reduceMotion]
  )

  const startDock = useCallback(() => {
    if (dockFrameRef.current != null) return
    dockTimeRef.current = performance.now()
    dockFrameRef.current = requestAnimationFrame(stepDock)
  }, [stepDock])

  const registerBar = useCallback((index: number, element: HTMLSpanElement | null) => {
    const springs = springsRef.current
    const existing = springs.get(index)
    if (existing) {
      existing.element = element
      return
    }
    if (!element) return
    const value = dockTarget(pointerYRef.current, element)
    springs.set(index, { element, value, velocity: 0 })
    element.style.transform = `scaleX(${value.toFixed(4)})`
  }, [])

  useEffect(() => () => {
    if (dockFrameRef.current != null) cancelAnimationFrame(dockFrameRef.current)
  }, [])

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
  const focusTarget = focused && activeIndex >= 0 ? activeIndex : null
  const hoveredIndex = hoverIndex ?? focusTarget ?? -1
  const docked = hoverIndex != null || focusTarget != null
  const targetIndex = hoverIndex ?? focusTarget

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
  const pointerIndex = (clientX: number, clientY: number): number | null => {
    const position = pointerPosition(clientX, clientY)
    if (position == null) return null
    return Math.min(items.length - 1, Math.max(0, Math.round(position)))
  }
  const focusRow = (index: number, event: FocusEvent<HTMLButtonElement>): void => {
    setPendingFocusIndex(null)
    setFocusIndex(index)
    setFocused(event.currentTarget.matches(':focus-visible'))
  }

  return (
    <div
      ref={rootRef}
      role="navigation"
      aria-label="对话轮次导航"
      className="absolute top-1/2 right-4 z-10 w-8 max-h-3/4 -translate-y-1/2 cursor-pointer overflow-y-auto py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{ maskImage: mask, WebkitMaskImage: mask }}
      onScroll={(event) => {
        syncOverflow(event.currentTarget)
        const pointer = pointerRef.current
        if (!pointer) return
        movementSource.current = 'scroll'
        setHoverIndex(pointerIndex(pointer.x, pointer.y))
        startDock()
      }}
      onPointerMove={(event) => {
        const index = pointerIndex(event.clientX, event.clientY)
        pointerRef.current = index == null ? null : { x: event.clientX, y: event.clientY }
        movementSource.current = 'pointer'
        setHoverIndex(index)
        pointerYRef.current = index == null ? Infinity : event.clientY
        startDock()
      }}
      onPointerLeave={() => {
        pointerRef.current = null
        setHoverIndex(null)
        pointerYRef.current = Infinity
        startDock()
      }}
      onBlur={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFocused(false)
      }}
      onClick={(event) => {
        const index = pointerIndex(event.clientX, event.clientY)
        if (index == null) return
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
              <MinimapBar
                index={index}
                label={row.label}
                turn={row.turn}
                width={width}
                hovered={index === hoveredIndex}
                current={index === currentIndex}
                visible={visibleIndexes.has(index)}
                docked={docked}
                tabbable={index === tabbableIndex}
                registerBar={registerBar}
                onJump={onJump}
                onFocus={focusRow}
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
