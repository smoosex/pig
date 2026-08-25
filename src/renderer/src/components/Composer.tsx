import { useCallback, useState } from 'react'
import { api } from '../ipc/api'
import { useSessionsStore } from '../stores/sessions'
import { Button } from './ui/button'
import { Separator } from './ui/separator'
import { Textarea } from './ui/textarea'

export function Composer() {
  const [text, setText] = useState('')
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const loadProjects = useSessionsStore((s) => s.loadProjects)
  const isStreaming = useSessionsStore((s) =>
    s.activeSessionId ? s.runtime[s.activeSessionId]?.isStreaming ?? false : false
  )

  const send = useCallback(async () => {
    const trimmed = text.trim()
    if (!trimmed || isStreaming || !activeSessionId) return
    setText('')
    await api.prompt(activeSessionId, trimmed)
    await loadProjects()
  }, [text, isStreaming, activeSessionId, loadProjects])

  const abort = useCallback(async () => {
    if (!activeSessionId) return
    await api.abort(activeSessionId)
  }, [activeSessionId])

  return (
    <div className="bg-background">
      <Separator />
      <div className="flex gap-2 px-4 py-3">
        <Textarea
          className="max-h-40 min-h-10 flex-1 resize-none bg-card text-sm leading-snug"
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
          <Button type="button" variant="destructive" size="lg" className="self-end" onClick={() => void abort()}>
            停止
          </Button>
        ) : (
          <Button
            type="button"
            size="lg"
            className="self-end"
            disabled={!text.trim() || !activeSessionId}
            onClick={() => void send()}
          >
            发送
          </Button>
        )}
      </div>
    </div>
  )
}
