import { useEffect, useRef } from 'react'
import { api } from '../ipc/api'
import { isPiMessage, type PiSessionEvent } from '../pi/types'
import { useSessionsStore } from '../stores/sessions'

const HYDRATE_DELAY_MS = 320

export function useEventBridge(): void {
  const setStreaming = useSessionsStore((s) => s.setStreaming)
  const appendLiveMessage = useSessionsStore((s) => s.appendLiveMessage)
  const replaceLiveMessage = useSessionsStore((s) => s.replaceLiveMessage)
  const renameTab = useSessionsStore((s) => s.renameTab)
  const loadControls = useSessionsStore((s) => s.loadControls)
  const hydrateTurns = useSessionsStore((s) => s.hydrateTurns)
  const setThinkingLevel = useSessionsStore((s) => s.setThinkingLevel)
  const hydrateDelay = useRef(new Map<string, number>())

  useEffect(() => {
    const delays = hydrateDelay.current
    const off = api.onEvent((raw) => {
      const payload = raw as { sessionId: string; event: PiSessionEvent }
      if (!payload?.sessionId || !payload?.event) return
      const { sessionId, event } = payload
      switch (event.type) {
        case 'agent_start': {
          const pending = delays.get(sessionId)
          if (pending != null) {
            window.clearTimeout(pending)
            delays.delete(sessionId)
          }
          setStreaming(sessionId, true)
          break
        }
        case 'message_start':
          if (isPiMessage(event.message)) appendLiveMessage(sessionId, event.message)
          break
        case 'message_update':
        case 'message_end':
          if (isPiMessage(event.message)) replaceLiveMessage(sessionId, event.message)
          break
        case 'agent_end': {
          const pending = delays.get(sessionId)
          if (pending != null) window.clearTimeout(pending)
          setStreaming(sessionId, false)
          void loadControls(sessionId)
          delays.set(
            sessionId,
            window.setTimeout(() => {
              delays.delete(sessionId)
              void hydrateTurns(sessionId)
            }, HYDRATE_DELAY_MS)
          )
          break
        }
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
    return () => {
      off()
      for (const id of delays.values()) window.clearTimeout(id)
      delays.clear()
    }
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
