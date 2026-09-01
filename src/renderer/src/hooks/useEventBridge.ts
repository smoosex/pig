import { useEffect, useRef } from 'react'
import { thinkingTimingKey } from '../chat/turns'
import { api } from '../ipc/api'
import { isPiMessage, type PiMessage, type PiSessionEvent } from '../pi/types'
import { useSessionsStore } from '../stores/sessions'

const HYDRATE_DELAY_MS = 320

function hasAssistantOutput(message: PiMessage): boolean {
  if (message.role !== 'assistant') return false
  return message.content.some((block) => {
    if (block.type === 'thinking') return block.thinking.length > 0
    if (block.type === 'text') return block.text.length > 0
    return true
  })
}

function assistantStreamEvent(
  event: PiSessionEvent
): { type: string; contentIndex: number } | null {
  const value = event.assistantMessageEvent
  if (!value || typeof value !== 'object') return null
  const nested = value as { type?: unknown; contentIndex?: unknown }
  if (
    typeof nested.type !== 'string' ||
    typeof nested.contentIndex !== 'number' ||
    !Number.isInteger(nested.contentIndex) ||
    nested.contentIndex < 0
  ) {
    return null
  }
  return { type: nested.type, contentIndex: nested.contentIndex }
}

export function useEventBridge(): void {
  const setStreaming = useSessionsStore((s) => s.setStreaming)
  const startStreamTimer = useSessionsStore((s) => s.startStreamTimer)
  const setThinkingDuration = useSessionsStore((s) => s.setThinkingDuration)
  const appendLiveMessage = useSessionsStore((s) => s.appendLiveMessage)
  const replaceLiveMessage = useSessionsStore((s) => s.replaceLiveMessage)
  const renameTab = useSessionsStore((s) => s.renameTab)
  const loadControls = useSessionsStore((s) => s.loadControls)
  const hydrateTurns = useSessionsStore((s) => s.hydrateTurns)
  const setThinkingLevel = useSessionsStore((s) => s.setThinkingLevel)
  const hydrateDelay = useRef(new Map<string, number>())
  const thinkingStarts = useRef(
    new Map<
      string,
      {
        sessionId: string
        messageTimestamp: number
        contentIndex: number
        startedAt: number
      }
    >()
  )

  useEffect(() => {
    const delays = hydrateDelay.current
    const starts = thinkingStarts.current

    const timingKey = (sessionId: string, messageTimestamp: number, contentIndex: number) =>
      `${sessionId}:${thinkingTimingKey(messageTimestamp, contentIndex)}`

    const finish = (
      entry: {
        sessionId: string
        messageTimestamp: number
        contentIndex: number
        startedAt: number
      },
      endedAt: number
    ) => {
      setThinkingDuration(
        entry.sessionId,
        entry.messageTimestamp,
        entry.contentIndex,
        Math.max(1000, endedAt - entry.startedAt)
      )
    }

    const finishMessage = (sessionId: string, messageTimestamp: number, endedAt: number) => {
      for (const [key, entry] of starts) {
        if (entry.sessionId !== sessionId || entry.messageTimestamp !== messageTimestamp) continue
        starts.delete(key)
        finish(entry, endedAt)
      }
    }

    const finishSession = (sessionId: string, endedAt: number) => {
      for (const [key, entry] of starts) {
        if (entry.sessionId !== sessionId) continue
        starts.delete(key)
        finish(entry, endedAt)
      }
    }

    const recordThinkingEvent = (sessionId: string, event: PiSessionEvent) => {
      if (event.type !== 'message_update' || !isPiMessage(event.message)) return
      if (event.message.role !== 'assistant') return
      const streamEvent = assistantStreamEvent(event)
      if (!streamEvent) return
      const key = timingKey(sessionId, event.message.timestamp, streamEvent.contentIndex)
      const now = performance.now()

      if (streamEvent.type === 'thinking_start' || streamEvent.type === 'thinking_delta') {
        if (!starts.has(key)) {
          starts.set(key, {
            sessionId,
            messageTimestamp: event.message.timestamp,
            contentIndex: streamEvent.contentIndex,
            startedAt: now
          })
        }
        return
      }

      if (streamEvent.type === 'thinking_end') {
        const entry = starts.get(key)
        if (!entry) return
        starts.delete(key)
        finish(entry, now)
      }
    }

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
          if (isPiMessage(event.message)) {
            if (hasAssistantOutput(event.message)) startStreamTimer(sessionId)
            appendLiveMessage(sessionId, event.message)
          }
          break
        case 'message_update':
          recordThinkingEvent(sessionId, event)
          if (isPiMessage(event.message)) {
            if (hasAssistantOutput(event.message)) startStreamTimer(sessionId)
            replaceLiveMessage(sessionId, event.message)
          }
          break
        case 'message_end':
          if (isPiMessage(event.message)) {
            if (event.message.role === 'assistant') {
              finishMessage(sessionId, event.message.timestamp, performance.now())
            }
            if (hasAssistantOutput(event.message)) startStreamTimer(sessionId)
            replaceLiveMessage(sessionId, event.message)
          }
          break
        case 'agent_end': {
          finishSession(sessionId, performance.now())
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
      thinkingStarts.current.clear()
    }
  }, [
    setStreaming,
    startStreamTimer,
    setThinkingDuration,
    appendLiveMessage,
    replaceLiveMessage,
    renameTab,
    loadControls,
    hydrateTurns,
    setThinkingLevel
  ])
}
