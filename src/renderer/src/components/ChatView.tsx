import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'
import type { PastedTextDisplayMetadata } from '../../../shared/pasted-text'
import { groupTurns, type ProcessItem, type Turn } from '../chat/turns'
import { chatColumn } from '../chat/layout'
import {
  captureAnchor,
  pruneMeasurements,
  restoredScrollOffset,
  SCROLL_END,
  TURN_ALIGN,
  turnScrollOffset,
  type ScrollSnapshot
} from '../chat/scroll-state'
import type { DisplayTurn } from '../ipc/api'
import { useSessionsStore } from '../stores/sessions'
import { cn } from '../lib/utils'
import { Empty } from './ui/empty'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller
} from './ui/message-scroller'
import { TurnView } from './TurnView'

function toTurn(display: DisplayTurn, process: ProcessItem[], workedMs?: number): Turn {
  const user = display.user
    ? {
        role: 'user' as const,
        content: display.user.images.length > 0
          ? [
              ...(display.user.text ? [{ type: 'text' as const, text: display.user.text }] : []),
              ...display.user.images.map((image) => ({
                type: 'image' as const,
                mimeType: image.mimeType,
                data: image.data
              }))
            ]
          : display.user.text,
        timestamp: display.startedAt,
        pastedText: {
          body: display.user.text,
          attachments: display.user.textAttachments,
          ...(display.user.textSegments ? { segments: display.user.textSegments } : {})
        } satisfies PastedTextDisplayMetadata
      }
    : undefined

  return {
    id: display.id,
    user,
    process,
    answer: display.answer.map((block) =>
      block.type === 'text'
        ? block
        : {
            type: 'image' as const,
            image: { type: 'image', mimeType: block.mimeType, data: block.data }
          }
    ),
    errorMessage: display.errorMessage,
    startedAt: display.startedAt,
    endedAt: display.endedAt,
    streaming: false,
    hasProcess: display.hasProcess,
    workedMs
  }
}

const MINIMAP_MIN = 6
const MINIMAP_MAX = 18
const MINIMAP_DOCK = 0.55
const MINIMAP_REACH = 3
const MINIMAP_BAR = 2
const MINIMAP_GAP = 8
const MINIMAP_PAD_Y = 8
const MINIMAP_FADE = MINIMAP_PAD_Y + 4 * MINIMAP_BAR + 3 * MINIMAP_GAP

function userTextLength(user: Turn['user']): number {
  if (!user) return 0
  if (typeof user.content === 'string') return user.content.length
  if (!Array.isArray(user.content)) return 0
  let n = 0
  for (const block of user.content) {
    if (block.type === 'text') n += block.text.length
  }
  return n
}

function turnLength(turn: Turn): number {
  let n = userTextLength(turn.user)
  for (const block of turn.answer) {
    if (block.type === 'text') n += block.text.length
  }
  return n
}

function dockBoost(index: number, hoverPos: number | null): number {
  if (hoverPos == null) return 0
  const dist = Math.abs(index - hoverPos)
  if (dist >= MINIMAP_REACH) return 0
  return Math.cos((dist / MINIMAP_REACH) * (Math.PI / 2))
}

function TurnMinimap({
  items,
  onJump
}: {
  items: Turn[]
  onJump: (index: number) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [hoverPos, setHoverPos] = useState<number | null>(null)
  const [overflow, setOverflow] = useState({ top: false, bottom: false })
  const lengths = useMemo(() => items.map(turnLength), [items])
  const maxLen = Math.max(...lengths, 1)
  const hovering = hoverPos != null

  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const sync = () => {
      const top = el.scrollTop > 1
      const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1
      setOverflow((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }))
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(el)
    return () => observer.disconnect()
  }, [items.length])

  if (items.length === 0) return null
  const hoveredIndex =
    hoverPos == null ? -1 : Math.min(items.length - 1, Math.max(0, Math.round(hoverPos)))
  const mask = `linear-gradient(to bottom, ${overflow.top ? 'transparent' : 'black'} 0, black ${MINIMAP_FADE}px, black calc(100% - ${MINIMAP_FADE}px), ${overflow.bottom ? 'transparent' : 'black'} 100%)`

  return (
    <div
      ref={rootRef}
      className="absolute top-1/2 right-3 z-10 flex max-h-3/4 min-w-9 -translate-y-1/2 cursor-pointer flex-col items-end gap-2 overflow-y-auto py-2 pl-10 pr-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{ maskImage: mask, WebkitMaskImage: mask }}
      onScroll={(event) => {
        const el = event.currentTarget
        const top = el.scrollTop > 1
        const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1
        setOverflow((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }))
      }}
      onPointerMove={(event) => {
        const el = event.currentTarget
        const y =
          event.clientY - el.getBoundingClientRect().top + el.scrollTop - MINIMAP_PAD_Y
        setHoverPos((y - MINIMAP_BAR / 2) / (MINIMAP_BAR + MINIMAP_GAP))
      }}
      onPointerLeave={() => setHoverPos(null)}
      onClick={(event) => {
        const el = event.currentTarget
        const y =
          event.clientY - el.getBoundingClientRect().top + el.scrollTop - MINIMAP_PAD_Y
        const index = Math.round((y - MINIMAP_BAR / 2) / (MINIMAP_BAR + MINIMAP_GAP))
        if (index >= 0 && index < items.length) onJump(index)
      }}
    >
      {items.map((item, index) => {
        const id = item.id ?? String(index)
        const content =
          MINIMAP_MIN + Math.sqrt(lengths[index] / maxLen) * (MINIMAP_MAX - MINIMAP_MIN)
        const boost = dockBoost(index, hoverPos)
        return (
          <button
            key={id}
            type="button"
            tabIndex={-1}
            aria-label="跳转到该轮对话"
            className={cn(
              'pointer-events-none h-0.5 origin-right shrink-0 rounded-full transition-[width] duration-300 ease-out',
              index === hoveredIndex ? 'bg-foreground' : 'bg-border'
            )}
            style={{
              width: hovering ? content : MINIMAP_MIN,
              transform: `scaleX(${1 + MINIMAP_DOCK * boost})`
            }}
          />
        )
      })}
    </div>
  )
}

export function ChatView() {
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const activeBranchViewId = useSessionsStore((s) =>
    s.activeSessionId ? (s.runtime[s.activeSessionId]?.branchViewId ?? null) : null
  )
  const turns = useSessionsStore((s) =>
    s.activeSessionId ? (s.runtime[s.activeSessionId]?.turns ?? []) : []
  )
  const liveMessages = useSessionsStore((s) =>
    s.activeSessionId ? (s.runtime[s.activeSessionId]?.liveMessages ?? []) : []
  )
  const processByTurnId = useSessionsStore((s) =>
    s.activeSessionId ? (s.runtime[s.activeSessionId]?.processByTurnId ?? {}) : {}
  )
  const thinkingDurations = useSessionsStore((s) =>
    s.activeSessionId ? (s.runtime[s.activeSessionId]?.thinkingDurations ?? {}) : {}
  )
  const elapsedByTurnId = useSessionsStore((s) =>
    s.activeSessionId ? (s.runtime[s.activeSessionId]?.elapsedByTurnId ?? {}) : {}
  )
  const streamElapsedMs = useSessionsStore((s) =>
    s.activeSessionId ? (s.runtime[s.activeSessionId]?.streamElapsedMs ?? null) : null
  )
  const isStreaming = useSessionsStore((s) =>
    s.activeSessionId ? (s.runtime[s.activeSessionId]?.isStreaming ?? false) : false
  )
  const historical = useMemo(
    () => turns.map((turn) => toTurn(turn, processByTurnId[turn.id] ?? [], elapsedByTurnId[turn.id])),
    [turns, processByTurnId, elapsedByTurnId]
  )
  const live = useMemo(() => {
    if (liveMessages.length === 0) return []
    return groupTurns(liveMessages, isStreaming, thinkingDurations).map((turn, index) => ({
      ...turn,
      id: `live-${index}`,
      workedMs: streamElapsedMs ?? undefined
    }))
  }, [liveMessages, isStreaming, thinkingDurations, streamElapsedMs])
  const items = useMemo(
    () => (live.length === 0 ? historical : [...historical, ...live]),
    [historical, live]
  )
  const scrollStates = useRef(new Map<string, ScrollSnapshot>())
  const scrollKey =
    activeSessionId && activeBranchViewId
      ? `${activeSessionId}\u0000${activeBranchViewId}`
      : null
  const saveScrollState = useCallback((key: string, state: ScrollSnapshot) => {
    scrollStates.current.set(key, state)
  }, [])
  const initialScrollState = scrollKey ? scrollStates.current.get(scrollKey) : undefined

  if (items.length === 0) {
    return (
      <Empty className="min-h-0 flex-1 gap-6">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 800 800"
          aria-hidden="true"
          className="size-12 text-primary"
        >
          <path
            fill="currentColor"
            fillRule="evenodd"
            d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
          />
          <path fill="currentColor" d="M517.36 400H634.72V634.72H517.36Z" />
        </svg>
        <p className="max-w-xl font-wenkai text-xl text-foreground">
          昨天是段历史，明天是个谜团，而今天是天赐的礼物
        </p>
      </Empty>
    )
  }

  return (
    <MessageScrollerProvider
        key={scrollKey ?? 'none'}
        autoScroll
        defaultScrollPosition={initialScrollState?.following ? 'end' : 'start'}
      >
      <VirtualTurns
        items={items}
        sessionId={activeSessionId}
        scrollKey={scrollKey}
        isStreaming={isStreaming}
        initialScrollState={initialScrollState}
        onScrollStateChange={saveScrollState}
      />
    </MessageScrollerProvider>
  )
}

function shouldAdjustOnItemResize(
  item: { key: string | number | bigint; start: number; size: number },
  instance: Virtualizer<HTMLDivElement, Element>
): boolean {
  const scrollOffset = (instance.scrollOffset ?? 0) + instance.scrollAdjustments
  if (!instance.itemSizeCache.has(item.key)) return item.start < scrollOffset
  return item.start + item.size <= scrollOffset && instance.scrollDirection !== 'backward'
}

function snapshotFrom(
  scroller: ReturnType<typeof useMessageScroller>,
  viewport: HTMLDivElement | null,
  virtualizer: Virtualizer<HTMLDivElement, Element>
): ScrollSnapshot {
  const state = scroller.getScrollState()
  const measurements = virtualizer.takeSnapshot()
  return {
    ...state,
    width: viewport?.clientWidth ?? 0,
    measurements,
    anchor: captureAnchor(measurements, state.scrollTop)
  }
}

function VirtualTurns({
  items,
  sessionId,
  scrollKey,
  isStreaming,
  initialScrollState,
  onScrollStateChange
}: {
  items: Turn[]
  sessionId: string | null
  scrollKey: string | null
  isStreaming: boolean
  initialScrollState?: ScrollSnapshot
  onScrollStateChange: (key: string, state: ScrollSnapshot) => void
}) {
  const loadTurnProcess = useSessionsStore((s) => s.loadTurnProcess)
  const scroller = useMessageScroller()
  const viewportRef = useRef<HTMLDivElement>(null)
  const jumpFrame = useRef(0)
  const restored = useRef(false)
  const prevStreaming = useRef(isStreaming)
  const itemKeys = useMemo(
    () => new Set(items.map((item) => item.id ?? '').filter(Boolean)),
    [items]
  )
  const measurements = useMemo(() => {
    const cached = initialScrollState?.measurements ?? []
    return cached.length === 0 ? cached : pruneMeasurements(cached, itemKeys)
  }, [initialScrollState, itemKeys])
  const onNeedProcess = useCallback(
    async (turnId: string) => {
      scroller.pauseAutoScroll()
      if (!sessionId) return
      await loadTurnProcess(sessionId, turnId)
    },
    [sessionId, loadTurnProcess, scroller]
  )
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => 160,
    overscan: 8,
    paddingStart: 16,
    paddingEnd: TURN_ALIGN,
    getItemKey: (index) => items[index]?.id ?? index,
    anchorTo: 'start',
    scrollEndThreshold: SCROLL_END,
    directDomUpdates: true,
    directDomUpdatesMode: 'position',
    initialOffset: initialScrollState && !initialScrollState.following
      ? initialScrollState.scrollTop
      : undefined,
    initialMeasurementsCache: measurements.length > 0 ? measurements : undefined
  })
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    shouldAdjustOnItemResize(item, instance)
  const virtualItems = virtualizer.getVirtualItems()

  const persist = useCallback(() => {
    if (!scrollKey) return
    onScrollStateChange(scrollKey, snapshotFrom(scroller, viewportRef.current, virtualizer))
  }, [onScrollStateChange, scrollKey, scroller, virtualizer])
  const persistRef = useRef(persist)
  persistRef.current = persist

  useLayoutEffect(() => {
    if (restored.current) return
    restored.current = true
    const snapshot = initialScrollState
    if (!snapshot) {
      scroller.scrollToEnd({ behavior: 'smooth' })
      return
    }
    if (snapshot.following) return
    const viewport = viewportRef.current
    const measured = snapshot.anchor
      ? virtualizer.measurementsCache.find((item) => item.key === snapshot.anchor?.key)
      : undefined
    const row = measured && viewport
      ? viewport.querySelector(`[data-index="${measured.index}"]`)
      : null
    const node = (row?.querySelector('[data-turn-user]') ?? row) as HTMLElement | null
    if (viewport && node && snapshot.anchor) {
      scroller.scrollToOffset(
        restoredScrollOffset(
          viewport,
          viewport.getBoundingClientRect(),
          node.getBoundingClientRect(),
          snapshot.anchor.offset
        ),
        { behavior: 'smooth' }
      )
      return
    }
    scroller.scrollToOffset(snapshot.scrollTop, { behavior: 'smooth' })
  }, [initialScrollState, scroller, virtualizer])

  useLayoutEffect(() => {
    return () => {
      cancelAnimationFrame(jumpFrame.current)
      persistRef.current()
    }
  }, [scrollKey])

  useLayoutEffect(() => {
    if (isStreaming && !prevStreaming.current) scroller.scrollToEnd({ behavior: 'smooth' })
    prevStreaming.current = isStreaming
  }, [isStreaming, scroller])

  const jumpToTurn = (index: number) => {
    const viewport = viewportRef.current
    if (!viewport) return
    scroller.pauseAutoScroll()
    const place = (): boolean => {
      const row = viewport.querySelector(`[data-index="${index}"]`)
      const target = row?.querySelector('[data-turn-user]') ?? row
      if (!target) return false
      return scroller.scrollToOffset(
        turnScrollOffset(viewport, viewport.getBoundingClientRect(), target.getBoundingClientRect())
      )
    }
    if (place()) return
    const measured = virtualizer.measurementsCache[index]
    if (measured) scroller.scrollToOffset(Math.max(0, measured.start - TURN_ALIGN))
    virtualizer.scrollToIndex(index, { align: 'start' })
    cancelAnimationFrame(jumpFrame.current)
    let tries = 0
    const tick = () => {
      if (place() || tries++ >= 30) return
      jumpFrame.current = requestAnimationFrame(tick)
    }
    jumpFrame.current = requestAnimationFrame(tick)
  }

  return (
    <MessageScroller className="min-h-0 flex-1">
      <MessageScrollerViewport
        ref={viewportRef}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('[data-slot="collapsible-trigger"]')) {
            scroller.pauseAutoScroll()
          }
        }}
      >
        <MessageScrollerContent className="relative gap-0">
          <div ref={virtualizer.containerRef} className={cn(chatColumn, 'relative')}>
            {virtualItems.map((row) => {
              const turn = items[row.index]
              return (
                <div
                  key={row.key}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  className="absolute top-0 left-0 w-full px-8"
                >
                  <TurnView turn={turn} onNeedProcess={onNeedProcess} />
                </div>
              )
            })}
          </div>
        </MessageScrollerContent>
      </MessageScrollerViewport>
      {isStreaming ? null : <MessageScrollerButton behavior="smooth" />}
      <TurnMinimap items={items} onJump={jumpToTurn} />
    </MessageScroller>
  )
}
