import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'
import { ArrowDown } from 'lucide-react'
import { groupTurns, type ProcessItem, type Turn } from '../chat/turns'
import { chatColumn } from '../chat/layout'
import type { DisplayTurn } from '../ipc/api'
import { useSessionsStore } from '../stores/sessions'
import { cn } from '../lib/utils'
import { Empty } from './ui/empty'
import { Button } from './ui/button'
import { TurnView } from './TurnView'

function toTurn(display: DisplayTurn, process: ProcessItem[], workedMs?: number): Turn {
  const user = display.user
    ? display.user.images.length > 0
      ? {
          role: 'user' as const,
          content: [
            ...(display.user.text ? [{ type: 'text' as const, text: display.user.text }] : []),
            ...display.user.images.map((image) => ({
              type: 'image' as const,
              mimeType: image.mimeType,
              data: image.data
            }))
          ],
          timestamp: display.startedAt
        }
      : { role: 'user' as const, content: display.user.text, timestamp: display.startedAt }
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

const MINIMAP_MIN = 8
const MINIMAP_MAX = 24
const MINIMAP_DOCK = 0.55
const MINIMAP_REACH = 3
const MINIMAP_BAR = 2
const MINIMAP_GAP = 6
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
      className="absolute top-1/2 right-3 z-10 flex max-h-3/4 min-w-9 -translate-y-1/2 cursor-pointer flex-col items-end gap-1.5 overflow-y-auto py-2 pl-10 pr-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
          <Button
            key={id}
            type="button"
            variant="ghost"
            tabIndex={-1}
            aria-label="跳转到该轮对话"
            className={cn(
              'pointer-events-none h-0.5 min-h-0 origin-right shrink-0 rounded-full p-0 hover:bg-transparent',
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
    <VirtualTurns
      key={activeSessionId ?? 'none'}
      items={items}
      sessionId={activeSessionId}
      isStreaming={isStreaming}
    />
  )
}

const TURN_ALIGN = 12
const SCROLL_END = 32

function distanceFromEnd(el: HTMLDivElement): number {
  return Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop)
}

function snapToEnd(el: HTMLDivElement): void {
  el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight)
}

function followKey(turn: Turn | undefined): string {
  if (!turn) return ''
  let n = 0
  for (const item of turn.process) {
    if (item.kind === 'text' || item.kind === 'thinking') n += item.text.length
    else if (item.kind === 'tools') n += item.tools.length
    else n += 1
  }
  for (const block of turn.answer) {
    if (block.type === 'text') n += block.text.length
  }
  return `${turn.id}:${n}:${turn.streaming ? 1 : 0}`
}

function JumpToEnd({
  viewportRef,
  hidden
}: {
  viewportRef: RefObject<HTMLDivElement | null>
  hidden?: boolean
}) {
  const [show, setShow] = useState(false)

  useEffect(() => {
    const scroller = viewportRef.current
    if (!scroller) return
    const sync = () => setShow(distanceFromEnd(scroller) > SCROLL_END)
    sync()
    scroller.addEventListener('scroll', sync, { passive: true })
    const observer = new ResizeObserver(sync)
    observer.observe(scroller)
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild)
    return () => {
      scroller.removeEventListener('scroll', sync)
      observer.disconnect()
    }
  }, [viewportRef])

  if (hidden || !show) return null
  return (
    <Button
      type="button"
      variant="secondary"
      size="icon-sm"
      className="absolute inset-s-1/2 bottom-4 z-10 -translate-x-1/2 border-border bg-card"
      aria-label="滚动到底部"
      onClick={() => {
        const scroller = viewportRef.current
        if (scroller) snapToEnd(scroller)
      }}
    >
      <ArrowDown />
    </Button>
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

function VirtualTurns({
  items,
  sessionId,
  isStreaming
}: {
  items: Turn[]
  sessionId: string | null
  isStreaming: boolean
}) {
  const loadTurnProcess = useSessionsStore((s) => s.loadTurnProcess)
  const parentRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const userIntent = useRef(false)
  const prevCount = useRef(items.length)
  const prevStreaming = useRef(isStreaming)
  const prevSession = useRef(sessionId)
  const onNeedProcess = useCallback(
    async (turnId: string) => {
      if (!sessionId) return
      await loadTurnProcess(sessionId, turnId)
    },
    [sessionId, loadTurnProcess]
  )
  const streamKey = followKey(items[items.length - 1])
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 160,
    overscan: 8,
    paddingStart: 16,
    paddingEnd: TURN_ALIGN,
    getItemKey: (index) => items[index]?.id ?? index,
    anchorTo: 'start',
    scrollEndThreshold: SCROLL_END,
    directDomUpdates: true,
    directDomUpdatesMode: 'position'
  })
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    shouldAdjustOnItemResize(item, instance)
  const virtualItems = virtualizer.getVirtualItems()

  useEffect(() => {
    const el = parentRef.current
    if (!el) return
    const onScroll = () => {
      if (!userIntent.current) return
      userIntent.current = false
      following.current = distanceFromEnd(el) <= SCROLL_END
    }
    const onUserInput = () => {
      userIntent.current = true
      if (isStreaming) following.current = false
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onUserInput, { passive: true })
    el.addEventListener('touchmove', onUserInput, { passive: true })
    el.addEventListener('keydown', onUserInput)
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onUserInput)
      el.removeEventListener('touchmove', onUserInput)
      el.removeEventListener('keydown', onUserInput)
    }
  }, [isStreaming])

  useLayoutEffect(() => {
    const el = parentRef.current
    if (!el) return
    if (prevSession.current !== sessionId) {
      prevSession.current = sessionId
      following.current = true
      prevCount.current = items.length
      prevStreaming.current = isStreaming
      snapToEnd(el)
      return
    }
    if (isStreaming && !prevStreaming.current) following.current = true
    const ended = !isStreaming && prevStreaming.current
    prevStreaming.current = isStreaming
    const grew = items.length > prevCount.current
    prevCount.current = items.length
    if (!following.current) return
    if (isStreaming || grew || ended) snapToEnd(el)
  }, [sessionId, isStreaming, items.length, streamKey])

  const jumpToTurn = (index: number) => {
    const scroller = parentRef.current
    if (!scroller) return
    scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -1 }))

    const place = (): boolean => {
      const row = scroller.querySelector(`[data-index="${index}"]`)
      const target = row?.querySelector('[data-turn-user]') ?? row
      if (!target) return false
      const sRect = scroller.getBoundingClientRect()
      const tRect = target.getBoundingClientRect()
      const maxScroll = scroller.scrollHeight - scroller.clientHeight
      const toTop = scroller.scrollTop + tRect.top - sRect.top - TURN_ALIGN
      if (toTop <= maxScroll + 1) {
        scroller.scrollTop = Math.max(0, toTop)
      } else {
        const toBottom = scroller.scrollTop + tRect.bottom - sRect.bottom + TURN_ALIGN
        scroller.scrollTop = Math.max(0, Math.min(maxScroll, toBottom))
      }
      return true
    }

    if (place()) return

    const measured = virtualizer.measurementsCache[index]
    if (measured) {
      const maxScroll = scroller.scrollHeight - scroller.clientHeight
      scroller.scrollTop = Math.max(0, Math.min(maxScroll, measured.start - TURN_ALIGN))
    }

    let tries = 0
    const tick = () => {
      if (place() || tries++ >= 30) return
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={parentRef}
        className="size-full min-h-0 min-w-0 overflow-y-auto overscroll-contain contain-content [overflow-anchor:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
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
      </div>
      <JumpToEnd viewportRef={parentRef} hidden={isStreaming} />
      <TurnMinimap items={items} onJump={jumpToTurn} />
    </div>
  )
}
