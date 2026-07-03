import { useEffect, useRef } from 'react'
import { useSessionsStore } from '../stores/sessions'

export function ChatView() {
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const messages = useSessionsStore((s) =>
    s.activeSessionId ? s.runtime[s.activeSessionId]?.messages ?? [] : []
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

  return (
    <div className="messages" ref={scrollRef}>
      {messages.map((m) => (
        <div key={m.id} className={`msg ${m.role}`}>
          <div className="msg-bubble">{m.text}</div>
        </div>
      ))}
    </div>
  )
}