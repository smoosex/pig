import { useEffect, useRef } from 'react'
import { groupTurns } from '../chat/turns'
import { useSessionsStore } from '../stores/sessions'
import { TurnView } from './TurnView'

export function ChatView() {
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const messages = useSessionsStore((s) =>
    s.activeSessionId ? s.runtime[s.activeSessionId]?.messages ?? [] : []
  )
  const isStreaming = useSessionsStore((s) =>
    s.activeSessionId ? s.runtime[s.activeSessionId]?.isStreaming ?? false : false
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, activeSessionId])

  if (messages.length === 0) {
    return (
      <div className="messages">
        <div className="empty">和 Pig 说点什么吧</div>
      </div>
    )
  }

  const turns = groupTurns(messages, isStreaming)

  return (
    <div className="messages" ref={scrollRef}>
      {turns.map((turn, i) => (
        <TurnView key={`${turn.startedAt}-${i}`} turn={turn} />
      ))}
    </div>
  )
}