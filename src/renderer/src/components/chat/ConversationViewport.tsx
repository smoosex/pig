import { useCallback, useMemo } from 'react'
import { chatColumn } from '../../chat/layout'
import type { ScrollSnapshot } from '../../chat/scroll-state'
import type { Turn } from '../../chat/turns'
import { cn } from '../../lib/utils'
import { useSessionsStore } from '../../stores/sessions'
import { TurnView } from '../TurnView'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerViewport,
  useMessageScroller
} from '../ui/message-scroller'
import { TurnMinimap } from './TurnMinimap'
import { useConversationScroll } from './useConversationScroll'

const measuredItem = '[content-visibility:visible] [contain-intrinsic-size:none]'

export function ConversationViewport({
  active,
  historical,
  live,
  sessionId,
  initialScrollState,
  onSave
}: {
  active: boolean
  historical: Turn[]
  live: Turn[]
  sessionId: string
  initialScrollState?: ScrollSnapshot
  onSave: (state: ScrollSnapshot) => void
}) {
  const items = useMemo(() => [...historical, ...live], [historical, live])
  const scroller = useMessageScroller()
  const loadTurnProcess = useSessionsStore((s) => s.loadTurnProcess)
  const { viewportRef, visibleTurns, hasMoreAbove, onScroll, registerTurn, jumpToTurn } = useConversationScroll({
    active, historical, live, initialScrollState, onSave
  })
  const onNeedProcess = useCallback(async (turnId: string) => {
    await loadTurnProcess(sessionId, turnId)
  }, [sessionId, loadTurnProcess])

  return (
    <MessageScroller className="min-h-0 flex-1">
      <MessageScrollerViewport
        ref={viewportRef}
        preserveScrollOnPrepend={false}
        onScroll={onScroll}
        onClickCapture={(event) => {
          if ((event.target as HTMLElement).closest('[data-slot="collapsible-trigger"]')) {
            scroller.pauseAutoScroll()
          }
        }}
      >
        <MessageScrollerContent className="gap-0">
          {hasMoreAbove ? (
            <div className={cn(chatColumn, 'py-3 text-center text-xs text-muted-foreground/60')}>
              向上滚动加载更早消息
            </div>
          ) : null}
          {visibleTurns.map(({ turn, index, key }) => (
            <MessageScrollerItem
              key={key}
              messageId={key}
              ref={(element) => registerTurn(key, element)}
              data-turn-key={key}
              data-turn-index={index}
              className={cn(measuredItem, chatColumn)}
            >
              <TurnView turn={turn} onNeedProcess={onNeedProcess} />
            </MessageScrollerItem>
          ))}
        </MessageScrollerContent>
      </MessageScrollerViewport>
      <MessageScrollerButton behavior="smooth" />
      <TurnMinimap items={items} onJump={jumpToTurn} />
    </MessageScroller>
  )
}
