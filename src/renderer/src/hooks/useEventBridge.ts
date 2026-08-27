import { useEffect } from 'react'
import { api } from '../ipc/api'
import { isPiMessage, type PiSessionEvent } from '../pi/types'
import { useSessionsStore } from '../stores/sessions'

export function useEventBridge(): void {
  const setStreaming = useSessionsStore((s) => s.setStreaming)
  const appendLiveMessage = useSessionsStore((s) => s.appendLiveMessage)
  const replaceLiveMessage = useSessionsStore((s) => s.replaceLiveMessage)
  const renameTab = useSessionsStore((s) => s.renameTab)
  const loadControls = useSessionsStore((s) => s.loadControls)
  const hydrateTurns = useSessionsStore((s) => s.hydrateTurns)
  const setThinkingLevel = useSessionsStore((s) => s.setThinkingLevel)

  useEffect(() => {
    const off = api.onEvent((raw) => {
      const payload = raw as { sessionId: string; event: PiSessionEvent }
      if (!payload?.sessionId || !payload?.event) return
      const { sessionId, event } = payload
      switch (event.type) {
        case 'agent_start':
          setStreaming(sessionId, true)
          break
        case 'message_start':
          if (isPiMessage(event.message)) appendLiveMessage(sessionId, event.message)
          break
        case 'message_update':
        case 'message_end':
          if (isPiMessage(event.message)) replaceLiveMessage(sessionId, event.message)
          break
        case 'agent_end':
          setStreaming(sessionId, false)
          void Promise.all([hydrateTurns(sessionId), loadControls(sessionId)])
          break
        case 'thinking_level_changed':
          if (
            event.level === 'off' ||
            event.level === 'minimal' ||
            event.level === 'low' ||
            event.level === 'medium' ||
            event.level === 'high' ||
            event.level === 'xhigh' ||
            event.level === 'max'
          ) {
            setThinkingLevel(sessionId, event.level)
          }
          break
        case 'session_info_changed':
          if (typeof event.name === 'string' && event.name.length > 0) {
            renameTab(sessionId, event.name)
          }
          break
      }
    })
    return off
  }, [
    setStreaming,
    appendLiveMessage,
    replaceLiveMessage,
    renameTab,
    loadControls,
    hydrateTurns,
    setThinkingLevel
  ])
}
