import { api } from '../ipc/api'
import { isPiMessage, type PiMessage, type PiSessionEvent } from '../pi/types'
import { useSessionsStore } from '../stores/sessions'
import { MAX_LIVE_BASH_CHARS } from '../stores/sessions/conversation-slice'
import { sameMessage } from '../stores/sessions/runtime'
import { createThinkingTracker } from './thinking-tracker'

const HYDRATE_DELAY_MS = 320

/**
 * Bridges Pi events into the renderer projection. Subscription-owned timers are
 * released together, so remounting the application cannot duplicate delivery.
 */
export function subscribeSessionEvents(): () => void {
  const delays = new Map<string, number>()
  const updates = new Map<string, { instanceId: number; branchRequest: number; message: PiMessage }>()
  const bashDeltas = new Map<string, { id: string; text: string }>()
  let frame: number | null = null
  const actions = useSessionsStore.getState()
  const {
    setStreaming, setThinkingDuration, appendLiveMessage, replaceLiveMessage, appendBashOutput,
    renameTab, loadControls, hydrateTurns, setThinkingLevel, setFollowUpMessages
  } = actions
  const thinking = createThinkingTracker(setThinkingDuration)
  const cancelFrame = () => {
    if (frame != null && updates.size === 0 && bashDeltas.size === 0) {
      window.cancelAnimationFrame(frame)
      frame = null
    }
  }
  const flush = (sessionId: string) => {
    const update = updates.get(sessionId)
    if (!update) return
    updates.delete(sessionId)
    const current = useSessionsStore.getState().runtime[sessionId]
    if (current?.instanceId === update.instanceId && current.branchRequest === update.branchRequest) {
      replaceLiveMessage(sessionId, update.message)
    }
    cancelFrame()
  }
  const cancelDelay = (sessionId: string) => {
    const pending = delays.get(sessionId)
    if (pending != null) window.clearTimeout(pending)
    delays.delete(sessionId)
  }
  const flushBash = (sessionId: string) => {
    const pending = bashDeltas.get(sessionId)
    if (!pending) return
    bashDeltas.delete(sessionId)
    appendBashOutput(sessionId, pending.id, pending.text)
    cancelFrame()
  }
  const scheduleFrame = () => {
    // Streaming snapshots and command output arrive per chunk; render the batches once per frame.
    frame ??= window.requestAnimationFrame(() => {
      frame = null
      for (const id of updates.keys()) flush(id)
      for (const id of bashDeltas.keys()) flushBash(id)
    })
  }
  const queueBashDelta = (sessionId: string, id: string, delta: string) => {
    const pending = bashDeltas.get(sessionId)
    if (pending && pending.id !== id) flushBash(sessionId)
    const accumulated = pending?.id === id ? pending : { id, text: '' }
    // Frames stop in hidden windows, so a batch can outlive any single stream chunk.
    accumulated.text = (accumulated.text + delta).slice(-MAX_LIVE_BASH_CHARS)
    bashDeltas.set(sessionId, accumulated)
    scheduleFrame()
  }
  const queueUpdate = (sessionId: string, message: PiMessage) => {
    const current = useSessionsStore.getState().runtime[sessionId]
    if (!current) return
    const pending = updates.get(sessionId)
    if (pending && !sameMessage(pending.message, message)) flush(sessionId)
    updates.set(sessionId, { instanceId: current.instanceId, branchRequest: current.branchRequest, message })
    scheduleFrame()
  }
  const reportError = (operation: string) => (error: unknown) => {
    console.error(`Failed to ${operation}:`, error)
  }
  const offStore = useSessionsStore.subscribe((state, previous) => {
    if (state.openTabs === previous.openTabs) return
    for (const tab of previous.openTabs) {
      // Diff tabs own no session: they leave no streaming state behind.
      if (tab.kind === 'diff') continue
      if (state.runtime[tab.id]) continue
      cancelDelay(tab.id)
      updates.delete(tab.id)
      bashDeltas.delete(tab.id)
      thinking.forgetSession(tab.id)
    }
    cancelFrame()
  })
  const off = api.onEvent((raw) => {
    const payload = raw as { sessionId: string; event: PiSessionEvent }
    if (typeof payload?.sessionId !== 'string' || typeof payload?.event?.type !== 'string') return
    const { sessionId, event } = payload
    const current = useSessionsStore.getState().runtime[sessionId]
    if (!current) return
    switch (event.type) {
      case 'agent_start': {
        flush(sessionId)
        cancelDelay(sessionId)
        setStreaming(sessionId, true)
        break
      }
      case 'message_start':
        flush(sessionId)
        if (isPiMessage(event.message)) {
          appendLiveMessage(sessionId, event.message)
        }
        break
      case 'message_update':
        thinking.record(sessionId, event)
        if (isPiMessage(event.message)) queueUpdate(sessionId, event.message)
        break
      case 'message_end':
        if (isPiMessage(event.message)) {
          const pending = updates.get(sessionId)
          if (pending && sameMessage(pending.message, event.message)) {
            updates.delete(sessionId)
            cancelFrame()
          } else flush(sessionId)
          if (event.message.role === 'assistant') {
            thinking.finishMessage(sessionId, event.message.timestamp, performance.now())
          }
          replaceLiveMessage(sessionId, event.message)
        }
        break
      case 'agent_end': {
        flush(sessionId)
        thinking.finishSession(sessionId, performance.now())
        cancelDelay(sessionId)
        setStreaming(sessionId, false)
        void loadControls(sessionId).catch(reportError('load session controls'))
        delays.set(
          sessionId,
          window.setTimeout(() => {
            delays.delete(sessionId)
            const latest = useSessionsStore.getState().runtime[sessionId]
            if (latest?.instanceId === current.instanceId && !latest.isStreaming) {
              void hydrateTurns(sessionId, { keepOlderTurns: true }).catch(reportError('refresh session history'))
            }
          }, HYDRATE_DELAY_MS)
        )
        break
      }
      case 'bash_execution_update':
        if (typeof event.id === 'string' && typeof event.delta === 'string') {
          queueBashDelta(sessionId, event.id, event.delta)
        }
        break
      case 'queue_update':
        if (Array.isArray(event.followUp) && event.followUp.every((item) => typeof item === 'string')) {
          setFollowUpMessages(sessionId, [...event.followUp] as string[])
        }
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
  return () => {
    off()
    offStore()
    for (const id of delays.values()) window.clearTimeout(id)
    delays.clear()
    updates.clear()
    cancelFrame()
    thinking.clear()
  }
}
