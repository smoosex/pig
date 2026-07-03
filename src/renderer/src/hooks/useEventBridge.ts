import { useEffect } from 'react'
import { api, type PiEvent } from '../ipc/api'
import { useSessionsStore } from '../stores/sessions'

type DeltaEvent = { type: string; delta?: string }

export function useEventBridge(): void {
  const beginAssistant = useSessionsStore((s) => s.beginAssistant)
  const appendChunk = useSessionsStore((s) => s.appendChunk)
  const finalizeAssistant = useSessionsStore((s) => s.finalizeAssistant)
  const setStreaming = useSessionsStore((s) => s.setStreaming)

  useEffect(() => {
    const off = api.onEvent((raw) => {
      const payload = raw as { sessionId: string; event: PiEvent }
      if (!payload?.sessionId || !payload?.event) return
      const { sessionId, event } = payload
      switch (event.type) {
        case 'agent_start':
          setStreaming(sessionId, true)
          break
        case 'message_start':
          beginAssistant(sessionId)
          break
        case 'message_update': {
          const ev = event.assistantMessageEvent as DeltaEvent | undefined
          if (ev && ev.type === 'text_delta' && typeof ev.delta === 'string') {
            appendChunk(sessionId, ev.delta)
          }
          break
        }
        case 'agent_end':
          finalizeAssistant(sessionId)
          setStreaming(sessionId, false)
          break
      }
    })
    return off
  }, [beginAssistant, appendChunk, finalizeAssistant, setStreaming])
}