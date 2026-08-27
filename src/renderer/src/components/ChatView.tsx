import { groupTurns } from '../chat/turns'
import { chatColumn } from '../chat/layout'
import { useSessionsStore } from '../stores/sessions'
import { cn } from '../lib/utils'
import { Empty, EmptyDescription } from './ui/empty'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerVisibility
} from './ui/message-scroller'
import { TurnView } from './TurnView'

function TurnMinimap({ ids }: { ids: string[] }) {
  const { scrollToMessage } = useMessageScroller()
  const { visibleMessageIds, currentAnchorId } = useMessageScrollerVisibility()
  if (ids.length === 0) return null
  const visible = new Set(visibleMessageIds)

  return (
    <div className="absolute top-1/2 right-3 z-10 flex max-h-1/2 -translate-y-1/2 flex-col items-end gap-1.5 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {ids.map((id) => {
        const active = id === currentAnchorId
        const onScreen = visible.has(id)
        return (
          <button
            key={id}
            type="button"
            aria-label="跳转到该轮对话"
            className={cn(
              'h-0.5 rounded-full transition-all',
              active ? 'w-4 bg-foreground' : onScreen ? 'w-3 bg-muted-foreground' : 'w-3 bg-border'
            )}
            onClick={() => scrollToMessage(id, { align: 'start' })}
          />
        )
      })}
    </div>
  )
}

export function ChatView() {
  const messages = useSessionsStore((s) =>
    s.activeSessionId ? s.runtime[s.activeSessionId]?.messages ?? [] : []
  )
  const isStreaming = useSessionsStore((s) =>
    s.activeSessionId ? s.runtime[s.activeSessionId]?.isStreaming ?? false : false
  )

  if (messages.length === 0) {
    return (
      <Empty className="min-h-0 flex-1">
        <EmptyDescription>和 Pig 说点什么吧</EmptyDescription>
      </Empty>
    )
  }

  const turns = groupTurns(messages, isStreaming)
  const turnIds = turns.map((turn, i) => `turn-${turn.startedAt}-${i}`)

  return (
    <div className="relative min-h-0 flex-1">
      <MessageScrollerProvider autoScroll>
        <MessageScroller>
          <MessageScrollerViewport className="scrollbar-gutter-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <MessageScrollerContent className={cn(chatColumn, 'gap-0 py-4')}>
              {turns.map((turn, i) => {
                const messageId = turnIds[i]
                return (
                  <MessageScrollerItem
                    key={messageId}
                    messageId={messageId}
                    scrollAnchor={Boolean(turn.user)}
                  >
                    <TurnView turn={turn} />
                  </MessageScrollerItem>
                )
              })}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
          <TurnMinimap ids={turnIds} />
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
  )
}
