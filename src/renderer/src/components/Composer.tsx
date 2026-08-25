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
    <div className="flex gap-2 border-t border-line bg-canvas px-4 py-3">
      <textarea
        className="max-h-40 flex-1 resize-none rounded-lg border border-line bg-elev px-3 py-2.5 font-sans text-sm leading-snug text-fg focus:border-accent focus:outline-none disabled:opacity-50"
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
        <button
          className="cursor-pointer self-end rounded-lg border-none bg-danger px-4.5 py-2.5 font-semibold text-white"
          onClick={() => void abort()}
        >
          停止
        </button>
      ) : (
        <button
          className="cursor-pointer self-end rounded-lg border-none bg-accent px-4.5 py-2.5 font-semibold text-black disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!text.trim() || !activeSessionId}
          onClick={() => void send()}
        >
          发送
        </button>
      )}
    </div>
  )
}