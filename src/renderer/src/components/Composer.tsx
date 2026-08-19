import { useState, useCallback } from 'react'
import { api } from '../ipc/api'
import { useSessionsStore } from '../stores/sessions'

export function Composer() {
  const [text, setText] = useState('')
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const isStreaming = useSessionsStore((s) =>
    s.activeSessionId ? s.runtime[s.activeSessionId]?.isStreaming ?? false : false
  )

  const send = useCallback(async () => {
    const trimmed = text.trim()
    if (!trimmed || isStreaming || !activeSessionId) return
    setText('')
    await api.prompt(activeSessionId, trimmed)
  }, [text, isStreaming, activeSessionId])

  const abort = useCallback(async () => {
    if (!activeSessionId) return
    await api.abort(activeSessionId)
  }, [activeSessionId])

  return (
    <div className="composer">
      <textarea
        value={text}
        placeholder={activeSessionId ? '输入消息，Shift+Enter 换行' : '请先选择会话'}
        rows={1}
        disabled={!activeSessionId}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void send()
          }
        }}
      />
      {isStreaming ? (
        <button className="abort" onClick={() => void abort()}>
          停止
        </button>
      ) : (
        <button disabled={!text.trim() || !activeSessionId} onClick={() => void send()}>
          发送
        </button>
      )}
    </div>
  )
}