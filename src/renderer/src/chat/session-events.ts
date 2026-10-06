import { api } from '../ipc/api'
import { isPiMessage, type PiMessage, type PiSessionEvent, type ToolPartialResult } from '../pi/types'
import { useSessionsStore } from '../stores/sessions'
import { MAX_LIVE_BASH_CHARS } from '../stores/sessions/conversation-slice'
import { sameMessage } from '../stores/sessions/runtime'
import { createThinkingTracker } from './thinking-tracker'

const HYDRATE_DELAY_MS = 320

/** A compaction result is an opaque payload on the wire; only its summary is worth keeping here. */
function summaryFields(result: unknown): { summary?: string; tokensBefore?: number } {
  if (typeof result !== 'object' || result === null) return {}
  const record = result as Record<string, unknown>
  return {
    ...(typeof record.summary === 'string' ? { summary: record.summary } : {}),
    ...(typeof record.tokensBefore === 'number' ? { tokensBefore: record.tokensBefore } : {})
  }
}

/**
 * Bridges Pi events into the renderer projection. Subscription-owned timers are
 * released together, so remounting the application cannot duplicate delivery.
 */
export function subscribeSessionEvents(): () => void {
  const delays = new Map<string, number>()
  const updates = new Map<string, { instanceId: number; branchRequest: number; message: PiMessage }>()
  const toolSnapshots = new Map<string, {
    instanceId: number
    branchRequest: number
    results: Map<string, ToolPartialResult>
  }>()
  const bashDeltas = new Map<string, { id: string; text: string }>()
  let frame: number | null = null
  const actions = useSessionsStore.getState()
  const {
    setStreaming, setThinkingDuration, appendLiveMessage, replaceLiveMessage, setToolUpdates, appendBashOutput,
    renameTab, loadControls, hydrateTurns, setThinkingLevel, setFollowUpMessages, setRetryNotice,
    startCompaction, updateCompaction, dropCompaction
  } = actions
  const thinking = createThinkingTracker(setThinkingDuration)
  const cancelFrame = () => {
    if (frame != null && updates.size === 0 && toolSnapshots.size === 0 && bashDeltas.size === 0) {
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
  const flushToolSnapshots = (sessionId: string) => {
    const pending = toolSnapshots.get(sessionId)
    if (!pending) return
    toolSnapshots.delete(sessionId)
    const current = useSessionsStore.getState().runtime[sessionId]
    if (current?.instanceId === pending.instanceId && current.branchRequest === pending.branchRequest) {
      setToolUpdates(sessionId, Object.fromEntries(pending.results))
    }
    cancelFrame()
  }
  const discardToolSnapshot = (sessionId: string, toolCallId: string) => {
    const pending = toolSnapshots.get(sessionId)
    if (!pending) return
    pending.results.delete(toolCallId)
    if (pending.results.size === 0) toolSnapshots.delete(sessionId)
    cancelFrame()
  }
  const scheduleFrame = () => {
    // Streaming snapshots and command output arrive per chunk; render the batches once per frame.
    frame ??= window.requestAnimationFrame(() => {
      frame = null
      for (const id of updates.keys()) flush(id)
      for (const id of toolSnapshots.keys()) flushToolSnapshots(id)
      for (const id of bashDeltas.keys()) flushBash(id)
    })
  }
  const queueToolSnapshot = (sessionId: string, toolCallId: string, result: ToolPartialResult) => {
    const current = useSessionsStore.getState().runtime[sessionId]
    if (!current) return
    let pending = toolSnapshots.get(sessionId)
    if (pending?.instanceId !== current.instanceId || pending.branchRequest !== current.branchRequest) {
      pending = { instanceId: current.instanceId, branchRequest: current.branchRequest, results: new Map() }
      toolSnapshots.set(sessionId, pending)
    }
    pending.results.set(toolCallId, result)
    scheduleFrame()
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
      toolSnapshots.delete(tab.id)
      bashDeltas.delete(tab.id)
      thinking.forgetSession(tab.id)
    }
    cancelFrame()
  })
  // Extension tree navigation moves the leaf behind the renderer's back, so the view rebinds to
  // the new branch through the same path as the tree dialog; a root leaf has no node to pass on.
  const offBranch = api.onSessionBranchChanged((sessionId, leafId) => {
    const store = useSessionsStore.getState()
    if (!store.runtime[sessionId]) return
    toolSnapshots.delete(sessionId)
    setRetryNotice(sessionId, null)
    cancelFrame()
    const refresh = leafId === null
      ? store.hydrateTurns(sessionId, { keepOlderTurns: true })
      : store.viewBranch(sessionId, leafId).catch(() => store.hydrateTurns(sessionId, { keepOlderTurns: true }))
    void refresh.catch(reportError('refresh the session branch'))
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
          if (event.message.role === 'toolResult') discardToolSnapshot(sessionId, event.message.toolCallId)
          appendLiveMessage(sessionId, event.message)
        }
        break
      case 'message_update':
        thinking.record(sessionId, event)
        if (isPiMessage(event.message)) queueUpdate(sessionId, event.message)
        break
      case 'message_end':
        if (isPiMessage(event.message)) {
          if (event.message.role === 'toolResult') discardToolSnapshot(sessionId, event.message.toolCallId)
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
      case 'tool_execution_update':
        if (typeof event.toolCallId === 'string' && event.partialResult && Array.isArray(event.partialResult.content)) {
          queueToolSnapshot(sessionId, event.toolCallId, event.partialResult)
        }
        break
      case 'turn_end':
        void loadControls(sessionId).catch(reportError('load session controls'))
        break
      case 'agent_end':
        flush(sessionId)
        flushToolSnapshots(sessionId)
        thinking.finishSession(sessionId, performance.now())
        break
      case 'agent_settled': {
        flush(sessionId)
        thinking.finishSession(sessionId, performance.now())
        cancelDelay(sessionId)
        toolSnapshots.delete(sessionId)
        // Settlement ends whatever the run was doing, retries included: a notice left standing here
        // would outlive the failure it describes.
        setRetryNotice(sessionId, null)
        cancelFrame()
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
      case 'auto_retry_start':
        if (
          typeof event.attempt === 'number' && typeof event.maxAttempts === 'number' &&
          typeof event.errorMessage === 'string'
        ) {
          setRetryNotice(sessionId, {
            kind: 'request',
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            errorMessage: event.errorMessage,
            endsAt: Date.now() + (typeof event.delayMs === 'number' ? Math.max(0, event.delayMs) : 0)
          })
        }
        break
      case 'auto_retry_end':
        // Success and final failure alike: the request is no longer pending, and a run that gave up
        // still carries its error on the assistant message the turn renders.
        setRetryNotice(sessionId, null)
        break
      case 'summarization_retry_scheduled':
        if (
          typeof event.attempt === 'number' && typeof event.maxAttempts === 'number' &&
          typeof event.errorMessage === 'string'
        ) {
          setRetryNotice(sessionId, {
            kind: 'summary',
            source: 'summary',
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            errorMessage: event.errorMessage,
            endsAt: Date.now() + (typeof event.delayMs === 'number' ? Math.max(0, event.delayMs) : 0)
          })
        }
        break
      case 'summarization_retry_attempt_start': {
        // The attempt's own payload carries no budget, so it only sharpens the scheduled notice into
        // "this attempt is running now"; an attempt nobody scheduled is not ours to invent.
        const scheduled = current.retryNotice
        if (scheduled?.kind !== 'summary') break
        setRetryNotice(sessionId, {
          ...scheduled,
          source: event.source === 'branchSummary'
            ? 'branchSummary'
            : event.source === 'compaction' ? 'compaction' : scheduled.source,
          endsAt: Date.now()
        })
        break
      }
      case 'summarization_retry_finished':
        setRetryNotice(sessionId, null)
        break
      case 'compaction_start': {
        const reason = event.reason
        if (reason !== 'manual' && reason !== 'threshold' && reason !== 'overflow') break
        const startedAt = Date.now()
        // Pi runs automatic compaction between the work and the summary, so the turn's work clock
        // stops here: it is frozen at whatever the turn had worked out, summaries already excluded.
        const summarized = current.liveCompactions.reduce(
          (sum, mark) => sum + (mark.endedAt == null ? 0 : mark.endedAt - mark.startedAt),
          0
        )
        startCompaction(sessionId, {
          id: `compaction:${startedAt}`,
          reason,
          startedAt,
          afterMessageCount: current.liveMessages.length,
          workMsBefore: current.streamStartedAt == null
            ? 0
            : Math.max(0, startedAt - current.streamStartedAt - summarized),
          endedAt: null,
          status: 'running'
        })
        break
      }
      case 'compaction_end': {
        const mark = current.liveCompactions.findLast((item) => item.status === 'running')
        if (event.aborted === true) {
          // A cancelled summary leaves no landmark and nothing to report.
          if (mark) dropCompaction(sessionId, mark.id)
          break
        }
        if (mark) {
          const endedAt = Date.now()
          // A result is a summary that reached disk; without one the attempt failed, whether Pi has
          // an error message for it or not.
          updateCompaction(sessionId, mark.id, event.result != null
            ? { status: 'done', endedAt, ...summaryFields(event.result) }
            : {
                status: 'failed',
                endedAt,
                errorMessage: typeof event.errorMessage === 'string' ? event.errorMessage : ''
              })
        }
        // Automatic compaction can run between `agent_end` and `agent_settled`. Active runs refresh
        // at settlement; manual compaction has no settlement event and must refresh here.
        if (event.result == null || current.isStreaming || event.willRetry === true) break
        void loadControls(sessionId).catch(reportError('load session controls'))
        void hydrateTurns(sessionId, { keepOlderTurns: true }).catch(reportError('refresh session history'))
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
    offBranch()
    offStore()
    for (const id of delays.values()) window.clearTimeout(id)
    delays.clear()
    updates.clear()
    toolSnapshots.clear()
    bashDeltas.clear()
    cancelFrame()
    thinking.clear()
  }
}
