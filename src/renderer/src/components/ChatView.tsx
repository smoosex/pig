import { groupTurns } from '../chat/turns'
import { useSessionsStore } from '../stores/sessions'
import { Empty, EmptyDescription } from './ui/empty'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport
} from './ui/message-scroller'
import { TurnView } from './TurnView'

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

  return (
    <div className="min-h-0 flex-1">
      <MessageScrollerProvider autoScroll>
        <MessageScroller>
          <MessageScrollerViewport className="p-4">
            <MessageScrollerContent className="gap-0">
              {turns.map((turn, i) => {
                const messageId = `turn-${turn.startedAt}-${i}`
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
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
  )
}
