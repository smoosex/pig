import { useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { groupTurns, type ProcessItem, type Turn } from '../chat/turns'
import { chatColumn } from '../chat/layout'
import type { DisplayTurn } from '../ipc/api'
import { useSessionsStore } from '../stores/sessions'
import { cn } from '../lib/utils'
import { Empty, EmptyDescription } from './ui/empty'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerProvider,
  MessageScrollerViewport
} from './ui/message-scroller'
import { TurnView } from './TurnView'

function toTurn(display: DisplayTurn, process: ProcessItem[]): Turn {
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
    hasProcess: display.hasProcess
  }
}

function TurnMinimap({
  ids,
  visibleIds,
  onJump
}: {
  ids: string[]
  visibleIds: string[]
  onJump: (index: number) => void
}) {
  if (ids.length === 0) return null
  const visible = new Set(visibleIds)
  const current = visibleIds[0]

  return (
    <div className="absolute top-1/2 right-3 z-10 flex max-h-1/2 -translate-y-1/2 flex-col items-end gap-1.5 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {ids.map((id, index) => {
        const active = id === current
        const onScreen = visible.has(id)
        return (
          <button
            key={id || index}
            type="button"
            aria-label="跳转到该轮对话"
            className={cn(
              'h-0.5 shrink-0 rounded-full transition-all',
              active ? 'w-4 bg-foreground' : onScreen ? 'w-3 bg-muted-foreground' : 'w-3 bg-border'
            )}
            onClick={() => onJump(index)}
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
  const isStreaming = useSessionsStore((s) =>
    s.activeSessionId ? (s.runtime[s.activeSessionId]?.isStreaming ?? false) : false
  )
  const items = useMemo(() => {
    const historical = turns.map((turn) => toTurn(turn, processByTurnId[turn.id] ?? []))
    if (liveMessages.length === 0) return historical
    const live = groupTurns(liveMessages, isStreaming).map((turn, index) => ({
      ...turn,
      id: `live-${index}`
    }))
    return [...historical, ...live]
  }, [turns, liveMessages, processByTurnId, isStreaming])

  if (items.length === 0) {
    return (
      <Empty className="min-h-0 flex-1">
        <EmptyDescription>和 Pig 说点什么吧</EmptyDescription>
      </Empty>
    )
  }

  return <VirtualTurns items={items} sessionId={activeSessionId} />
}

function VirtualTurns({ items, sessionId }: { items: Turn[]; sessionId: string | null }) {
  const loadTurnProcess = useSessionsStore((s) => s.loadTurnProcess)
  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 160,
    overscan: 8,
    paddingStart: 16,
    paddingEnd: 16,
    getItemKey: (index) => items[index]?.id ?? index
  })
  const virtualItems = virtualizer.getVirtualItems()
  const ids = items.map((item, index) => item.id ?? String(index))

  return (
    <div className="relative min-h-0 flex-1">
      <MessageScrollerProvider autoScroll>
        <MessageScroller>
          <MessageScrollerViewport
            ref={parentRef}
            className="[scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            <div className={cn(chatColumn, 'relative')} style={{ height: virtualizer.getTotalSize() }}>
              {virtualItems.map((row) => {
                const turn = items[row.index]
                const turnId = turn.id
                return (
                  <div
                    key={row.key}
                    data-index={row.index}
                    ref={virtualizer.measureElement}
                    className="absolute top-0 left-0 w-full"
                    style={{ transform: `translateY(${row.start}px)` }}
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
          </MessageScrollerViewport>
          <MessageScrollerButton />
          <TurnMinimap
            ids={ids}
            visibleIds={virtualItems.map((row) => ids[row.index] ?? '')}
            onJump={(index) => virtualizer.scrollToIndex(index, { align: 'start' })}
          />
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
  )
}
