import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { groupTurns, type ProcessItem, type Turn } from '../chat/turns'
import { chatColumn } from '../chat/layout'
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
  const turns = useSessionsStore((s) =>
    s.activeSessionId ? (s.runtime[s.activeSessionId]?.turns ?? []) : []
  )
  const liveMessages = useSessionsStore((s) =>
    s.activeSessionId ? (s.runtime[s.activeSessionId]?.liveMessages ?? []) : []
  )
  const processByTurnId = useSessionsStore((s) =>
    s.activeSessionId ? (s.runtime[s.activeSessionId]?.processByTurnId ?? {}) : {}
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
  const items = useMemo(() => {
    const historical = turns.map((turn) =>
      toTurn(turn, processByTurnId[turn.id] ?? [], elapsedByTurnId[turn.id])
    )
    if (liveMessages.length === 0) return historical
    const live = groupTurns(liveMessages, isStreaming).map((turn, index) => ({
      ...turn,
      id: `live-${index}`,
      workedMs: streamElapsedMs ?? undefined
    }))
    return [...historical, ...live]
  }, [turns, liveMessages, processByTurnId, elapsedByTurnId, streamElapsedMs, isStreaming])

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

function FollowScroller({
  sessionId,
  isStreaming,
  turnCount,
  viewportRef
}: {
  sessionId: string | null
  isStreaming: boolean
  turnCount: number
  viewportRef: RefObject<HTMLDivElement | null>
}) {
  const { scrollToEnd } = useMessageScroller()
  const prevCount = useRef(turnCount)
  const prevStreaming = useRef(isStreaming)

  const jump = (behavior: ScrollBehavior) => {
    const el = viewportRef.current
    if (el) el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight)
    scrollToEnd({ behavior })
    requestAnimationFrame(() => {
      if (el) el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight)
      scrollToEnd({ behavior: 'auto' })
    })
  }

  useLayoutEffect(() => {
    prevCount.current = turnCount
    prevStreaming.current = isStreaming
    jump('auto')
  }, [sessionId])

  useLayoutEffect(() => {
    if (turnCount > prevCount.current) jump(isStreaming ? 'auto' : 'smooth')
    prevCount.current = turnCount
  }, [turnCount, isStreaming])

  useLayoutEffect(() => {
    if (isStreaming && !prevStreaming.current) jump('auto')
    if (!isStreaming && prevStreaming.current) jump('smooth')
    prevStreaming.current = isStreaming
  }, [isStreaming])

  return null
}

const TURN_ALIGN = 12

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
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 160,
    overscan: 8,
    paddingStart: 16,
    paddingEnd: TURN_ALIGN,
    getItemKey: (index) => items[index]?.id ?? index,
    anchorTo: 'end',
    scrollEndThreshold: 32,
    directDomUpdates: true
  })
  const virtualItems = virtualizer.getVirtualItems()

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
      <MessageScrollerProvider autoScroll={isStreaming} defaultScrollPosition="end">
        <FollowScroller
          sessionId={sessionId}
          isStreaming={isStreaming}
          turnCount={items.length}
          viewportRef={parentRef}
        />
        <MessageScroller>
          <MessageScrollerViewport
            ref={parentRef}
            className="[overflow-anchor:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            <MessageScrollerContent className="gap-0">
            <div ref={virtualizer.containerRef} className={cn(chatColumn, 'relative')}>
              {virtualItems.map((row) => {
                const turn = items[row.index]
                const turnId = turn.id
                return (
                  <div
                    key={row.key}
                    data-index={row.index}
                    ref={virtualizer.measureElement}
                    className="absolute top-0 left-0 w-full px-8"
                  >
                    <TurnView
                      turn={turn}
                      onNeedProcess={
                        sessionId && turnId && !turnId.startsWith('live-')
                          ? () => loadTurnProcess(sessionId, turnId)
                          : undefined
                      }
                    />
                  </div>
                )
              })}
            </div>
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
          <TurnMinimap
            items={items}
            onJump={jumpToTurn}
          />
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
  )
}
