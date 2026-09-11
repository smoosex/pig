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
  MessageScrollerViewport
} from '../ui/message-scroller'
import { TurnMinimap } from './TurnMinimap'
import { useConversationScroll } from './useConversationScroll'

const measuredItem = '[content-visibility:visible] [contain-intrinsic-size:none]'

export function ConversationViewport({
  historical,
  live,
  sessionId,
  initialScrollState,
  onSave
}: {
  historical: Turn[]
  live: Turn[]
  sessionId: string | null
  initialScrollState?: ScrollSnapshot
  onSave: (state: ScrollSnapshot) => void
}) {
  const items = useMemo(() => [...historical, ...live], [historical, live])
  const loadTurnProcess = useSessionsStore((s) => s.loadTurnProcess)
  const { viewportRef, virtualizer, scroller, jumpToTurn } = useConversationScroll({
    historical, live, initialScrollState, onSave
  })
  const onNeedProcess = useCallback(async (turnId: string) => {
    if (sessionId) await loadTurnProcess(sessionId, turnId)
  }, [sessionId, loadTurnProcess])

  return (
    <MessageScroller className="min-h-0 flex-1">
      <MessageScrollerViewport
        ref={viewportRef}
        preserveScrollOnPrepend={false}
        onClickCapture={(event) => {
          if ((event.target as HTMLElement).closest('[data-slot="collapsible-trigger"]')) {
            scroller.pauseAutoScroll()
          }
        }}
      >
        <MessageScrollerContent className="gap-0">
          <MessageScrollerItem className={measuredItem} data-history-turns="">
            <div ref={virtualizer.containerRef} className={cn(chatColumn, 'relative')}>
              {virtualizer.getVirtualItems().map((row) => (
                <MessageScrollerItem
                  key={row.key}
                  messageId={historical[row.index].id}
                  data-index={row.index}
                  data-historical-turn=""
                  ref={virtualizer.measureElement}
                  className={cn(measuredItem, 'absolute top-0 left-0 w-full px-8')}
                >
                  <TurnView turn={historical[row.index]} onNeedProcess={onNeedProcess} />
                </MessageScrollerItem>
              ))}
            </div>
          </MessageScrollerItem>
          {live.map((turn, index) => (
            <MessageScrollerItem
              key={turn.id}
              messageId={turn.id}
              data-index={historical.length + index}
              data-live-turn=""
              className={cn(chatColumn, measuredItem)}
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
