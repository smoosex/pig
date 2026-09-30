/**
 * Conversation projection: persisted turns plus the current Pi message stream.
 * Requests belong to a runtime instance, so closing/reopening the same session
 * cannot let an old response replace the new view.
 */
import { api } from '../../ipc/api'
import { buildTurn, thinkingTimingKey } from '../../chat/turns'
import { isPiMessage, type PiMessage } from '../../pi/types'
import { createBranchViewId, patchRuntime, sameMessage } from './runtime'
import type { RuntimeState, SessionSlice } from './types'

/** Turns fetched when the reader scrolls above the loaded window. */
const PAGE_TURNS = 40
/** One request never reads more than this, so a far jump pages instead of blocking on the whole gap. */
const MAX_PAGE_TURNS = 200
/** Live command output is tailed at this size in both the pending batch and the store. */
export const MAX_LIVE_BASH_CHARS = 64 * 1024

function toolUpdatesAfterMessage(updates: RuntimeState['toolUpdates'], message: PiMessage): RuntimeState['toolUpdates'] {
  if (message.role !== 'toolResult' || !updates[message.toolCallId]) return updates
  const remaining = { ...updates }
  delete remaining[message.toolCallId]
  return remaining
}

export const createConversationSlice: SessionSlice<
  | 'runtime'
  | 'hydrateTurns'
  | 'loadTurnProcess'
  | 'loadOlderTurns'
  | 'loadTokenStats'
  | 'applySessionWindow'
  | 'loadControls'
  | 'applyControls'
  | 'setControlsStatus'
  | 'setFollowUpMessages'
  | 'queueFollowUpAction'
  | 'clearQueuedEditText'
  | 'setThinkingLevel'
  | 'setStreaming'
  | 'beginPrompt'
  | 'rollbackPrompt'
  | 'beginBash'
  | 'appendBashOutput'
  | 'endBash'
  | 'setThinkingDuration'
  | 'appendLiveMessage'
  | 'replaceLiveMessage'
  | 'setToolUpdates'
  | 'setRetryNotice'
  | 'viewBranch'
> = (set, get) => {
  const historyRequests = new Map<number, object>()
  const controlRequests = new Map<number, object>()
  const processRequests = new Map<string, Promise<void>>()
  const olderRequests = new Map<string, Promise<void>>()

  const currentInstance = (sessionId: string, expected: RuntimeState) => {
    const current = get().runtime[sessionId]
    return current?.instanceId === expected.instanceId ? current : undefined
  }

  const describeError = (error: unknown) =>
    error instanceof Error ? error.message : String(error)

  const update = (
    sessionId: string,
    patch: Parameters<typeof patchRuntime>[2]
  ) => set((state) => {
    const runtime = patchRuntime(state.runtime, sessionId, patch)
    return runtime === state.runtime ? state : { runtime }
  })

  return {
    runtime: {},

    hydrateTurns: async (sessionId, options) => {
      const initial = get().runtime[sessionId]
      if (!initial) return false
      const request = {}
      historyRequests.set(initial.instanceId, request)
      try {
        const result = options?.display ?? await api.getDisplayTurns(sessionId)
        const current = currentInstance(sessionId, initial)
        if (
          !current ||
          historyRequests.get(initial.instanceId) !== request ||
          current.branchRequest !== initial.branchRequest ||
          current.liveMessages !== initial.liveMessages ||
          current.isStreaming !== initial.isStreaming ||
          (options?.expectedLeafId !== undefined && result.leafId !== options.expectedLeafId) ||
          (options?.expectedBranchRequest != null && current.branchRequest !== options.expectedBranchRequest)
        ) return false

        update(sessionId, (rt) => {
          const branchViewId = options?.branchViewId ?? rt.branchViewId
          const branchViews = { ...rt.branchViews }
          if (result.leafId) {
            if (options?.branchViewId === undefined && rt.leafId && rt.leafId !== result.leafId) {
              delete branchViews[rt.leafId]
            }
            branchViews[result.leafId] = branchViewId
          }
          const elapsedByTurnId = { ...rt.elapsedByTurnId }
          const last = result.turns[result.turns.length - 1]
          if (!rt.isStreaming && rt.streamElapsedMs != null && last) {
            elapsedByTurnId[last.id] = rt.streamElapsedMs
          }
          // A refresh of the same branch replaces the window with the tail. A reader who paged up
          // still holds turns the fetch no longer covers, and dropping them would lose their place.
          // Only a window whose offset is already authoritative can be spliced: a provisional tail
          // is numbered from 0 by convention, so keeping its prefix would duplicate turns.
          const heldTurns =
            options?.keepOlderTurns === true &&
            rt.turnIndexTrusted &&
            rt.turnStart < result.startIndex &&
            rt.turnStart + rt.turns.length >= result.startIndex
              ? rt.turns.slice(0, result.startIndex - rt.turnStart)
              : null
          return {
            turns: heldTurns ? [...heldTurns, ...result.turns] : result.turns,
            turnStart: heldTurns ? rt.turnStart : result.startIndex,
            turnPending: result.indexPending === true,
            turnIndexTrusted: result.indexPending !== true,
            turnLoading: false,
            turnError: null,
            turnSummary: result.summary ?? [],
            leafId: result.leafId,
            branchViewId,
            branchViews,
            liveMessages: rt.isStreaming ? rt.liveMessages : [],
            toolUpdates: rt.isStreaming ? rt.toolUpdates : {},
            pendingUserMessage: rt.isStreaming && rt.pendingUserMessage,
            processByTurnId: rt.isStreaming ? rt.processByTurnId : {},
            elapsedByTurnId
          }
        })
        return true
      } finally {
        if (historyRequests.get(initial.instanceId) === request) historyRequests.delete(initial.instanceId)
      }
    },

    loadOlderTurns: async (sessionId, target) => {
      const initial = get().runtime[sessionId]
      if (!initial) return
      if (!initial.turnIndexTrusted) {
        // The held window is the provisional tail, so its offset is a promise rather than a number:
        // nothing above it can be paged. The authoritative window is the only answer, and it is also
        // the escape route for an index whose push was lost or failed.
        try {
          await get().hydrateTurns(sessionId)
        } catch (error) {
          // Callers are `void` and the view must hear about it instead of the console.
          update(sessionId, (rt) =>
            rt.instanceId === initial.instanceId && !rt.turnError
              ? { turnError: describeError(error), turnLoading: false }
              : null
          )
        }
        return
      }
      if (initial.turnStart === 0) return
      const key = `${sessionId}:${initial.instanceId}`
      const running = olderRequests.get(key)
      if (running) {
        // A page is already on its way: this caller waits for it instead of restarting it.
        await running
        const joined = get().runtime[sessionId]
        // The page it waited for may have been the last one nobody else would have asked for, so a
        // window that moved is continued below; one that did not is a dead end and stops here.
        if (
          !joined ||
          joined.instanceId !== initial.instanceId ||
          joined.turnStart === 0 ||
          joined.turnStart >= initial.turnStart
        ) return
      }
      const current = get().runtime[sessionId]
      if (!current || current.instanceId !== initial.instanceId || current.turnStart === 0) return
      const wanted = Math.min(target ?? current.turnStart - PAGE_TURNS, current.turnStart - 1)
      const from = Math.max(0, wanted, current.turnStart - MAX_PAGE_TURNS)
      update(sessionId, { turnLoading: true })
      const request = (async () => {
        let result
        try {
          result = await api.getTurnWindow(sessionId, from, current.turnStart - from)
        } catch (error) {
          // The reader asked for these turns: the failure has to reach the view, not a console.
          // No change means no new runtime object: this response belongs to a window that moved on.
          update(sessionId, (rt) =>
            rt.instanceId === current.instanceId ? { turnError: describeError(error) } : null
          )
          return
        }
        update(sessionId, (rt) => {
          // A window that moved underneath the response wins: new turns, another branch, or a
          // reopened session all make these turns somebody else's history.
          if (
            rt.instanceId !== current.instanceId ||
            rt.branchRequest !== current.branchRequest ||
            rt.turnStart !== current.turnStart
          ) return null
          return {
            turns: [...result.turns, ...rt.turns],
            turnStart: result.startIndex,
            turnPending: false,
            turnIndexTrusted: true,
            turnError: null
          }
        })
      })()
      olderRequests.set(key, request)
      try {
        await request
      } finally {
        if (olderRequests.get(key) === request) olderRequests.delete(key)
        // Only this instance waits on the page; a reopened session must not inherit the flag.
        update(sessionId, (rt) =>
          rt.instanceId === current.instanceId && rt.turnLoading ? { turnLoading: false } : null
        )
      }
    },

    applySessionWindow: (next) => {
      const runtime = get().runtime[next.sessionId]
      if (!runtime) return
      if ('error' in next) {
        // The index failed after first paint: stop promising older turns and say what happened.
        update(next.sessionId, (rt) => (
          rt.leafId === runtime.leafId ? { turnPending: false, turnError: next.error } : null
        ))
        return
      }
      if (runtime.leafId !== next.leafId) {
        // The file moved while the index was building: the held window is another branch's tail, so
        // refetch it instead of relabelling it (and never leave the provisional window pending).
        void get().hydrateTurns(next.sessionId).catch((error: unknown) => {
          // This branch means the file moved under the index: if the refetch fails, the provisional
          // window must stop promising older turns and say why, like any other failed read.
          update(next.sessionId, (rt) => (
            rt.leafId === runtime.leafId ? { turnPending: false, turnError: describeError(error) } : null
          ))
        })
        return
      }
      update(next.sessionId, (rt) => {
        // A window the reader already moved is not ours to set any more.
        if (rt.leafId !== next.leafId || rt.turnStart !== 0) return null
        return {
          turnStart: next.startIndex,
          turnPending: false,
          turnIndexTrusted: true,
          turnError: null,
          turnSummary: next.summary ?? rt.turnSummary
        }
      })
    },

    loadTokenStats: async (sessionId) => {
      const initial = get().runtime[sessionId]
      if (!initial || initial.tokensLoading) return
      update(sessionId, { tokensLoading: true, tokensError: null })
      try {
        const tokens = await api.getTokenStats(sessionId)
        update(sessionId, (rt) => (rt.instanceId === initial.instanceId ? { tokens } : null))
      } catch (error) {
        update(sessionId, (rt) =>
          rt.instanceId === initial.instanceId ? { tokensError: describeError(error) } : null
        )
      } finally {
        // A read that belongs to a replaced instance must not touch the new one, and clearing a flag
        // that was never set is not a change to re-render for either.
        update(sessionId, (rt) =>
          rt.instanceId === initial.instanceId && rt.tokensLoading ? { tokensLoading: false } : null
        )
      }
    },

    loadTurnProcess: async (sessionId, turnId) => {
      const initial = get().runtime[sessionId]
      if (!initial || initial.processByTurnId[turnId]) return
      const key = `${initial.instanceId}:${initial.branchRequest}:${turnId}`
      const pending = processRequests.get(key)
      if (pending) return pending

      const request = (async () => {
        const raw = await api.getTurnMessages(sessionId, turnId)
        const current = currentInstance(sessionId, initial)
        if (!current || current.branchRequest !== initial.branchRequest) return
        const process = buildTurn((raw ?? []).filter(isPiMessage), false, current.thinkingDurations).process
        update(sessionId, (rt) => ({ processByTurnId: { ...rt.processByTurnId, [turnId]: process } }))
      })()
      processRequests.set(key, request)
      try {
        await request
      } finally {
        processRequests.delete(key)
      }
    },

    loadControls: async (sessionId) => {
      const initial = get().runtime[sessionId]
      if (!initial) return
      const request = {}
      controlRequests.set(initial.instanceId, request)
      try {
        const controls = await api.getControls(sessionId)
        const current = currentInstance(sessionId, initial)
        if (
          !current ||
          current.controlsRevision !== initial.controlsRevision ||
          controlRequests.get(initial.instanceId) !== request
        ) return
        get().applyControls(sessionId, {
          ...controls,
          // Queue and thinking events may be newer than this controls snapshot.
          followUpMessages: current.followUpMessages !== initial.followUpMessages
            ? current.followUpMessages : controls.followUpMessages,
          thinkingLevel: current.thinkingLevel !== initial.thinkingLevel
            ? current.thinkingLevel : controls.thinkingLevel
        })
      } finally {
        if (controlRequests.get(initial.instanceId) === request) controlRequests.delete(initial.instanceId)
      }
    },

    applyControls: (sessionId, controls) => update(sessionId, (rt) => ({
      ...controls,
      controlsRevision: rt.controlsRevision + 1
    })),

    setControlsStatus: (sessionId, status) => update(sessionId, status),

    setThinkingLevel: (sessionId, thinkingLevel) => update(sessionId, { thinkingLevel }),
    setFollowUpMessages: (sessionId, followUpMessages) => update(sessionId, { followUpMessages }),

    queueFollowUpAction: async (sessionId, index, action) => {
      const initial = get().runtime[sessionId]
      if (!initial) return
      const text = await api.followUpAction(sessionId, index, action)
      if (action === 'edit' && text != null && currentInstance(sessionId, initial)) {
        update(sessionId, { queuedEditText: text })
      }
    },

    clearQueuedEditText: (sessionId) => update(sessionId, { queuedEditText: null }),

    setStreaming: (sessionId, streaming) => update(sessionId, (rt) => ({
      isStreaming: streaming,
      toolUpdates: streaming ? rt.toolUpdates : {},
      streamStartedAt: streaming ? (rt.isStreaming ? rt.streamStartedAt : Date.now()) : null,
      streamElapsedMs: streaming ? null : rt.streamStartedAt != null
        ? Date.now() - rt.streamStartedAt : rt.streamElapsedMs
    })),

    beginPrompt: (sessionId, message) => update(sessionId, (rt) => ({
      isStreaming: true,
      streamStartedAt: rt.isStreaming ? rt.streamStartedAt : Date.now(),
      streamElapsedMs: null,
      liveMessages: [...rt.liveMessages, message],
      toolUpdates: {},
      retryNotice: null,
      pendingUserMessage: true
    })),

    rollbackPrompt: (sessionId) => update(sessionId, (rt) => ({
      isStreaming: false,
      toolUpdates: {},
      retryNotice: null,
      streamStartedAt: null,
      streamElapsedMs: null,
      liveMessages: rt.pendingUserMessage ? rt.liveMessages.slice(0, -1) : rt.liveMessages,
      pendingUserMessage: false
    })),

    beginBash: (sessionId, id, command) => update(sessionId, {
      bashExecution: {
        id,
        message: {
          role: 'bashExecution', command, output: '', exitCode: undefined,
          cancelled: false, truncated: false, timestamp: Date.now()
        }
      }
    }),

    appendBashOutput: (sessionId, id, delta) => update(sessionId, (rt) =>
      rt.bashExecution?.id === id
        ? { bashExecution: {
            id,
            message: {
              ...rt.bashExecution.message,
              output: (rt.bashExecution.message.output + delta).slice(-MAX_LIVE_BASH_CHARS)
            }
          } }
        : null
    ),

    endBash: (sessionId, id, result, turnId) => update(sessionId, (rt) => {
      const execution = rt.bashExecution
      if (execution?.id !== id) return null
      return {
        bashExecution: null,
        ...(result && turnId ? {
          processByTurnId: {
            ...rt.processByTurnId,
            [turnId]: [{
              kind: 'bash' as const,
              message: { ...execution.message, ...result }
            }]
          }
        } : {})
      }
    }),

    setThinkingDuration: (sessionId, timestamp, index, durationMs) => update(sessionId, (rt) => {
      const key = thinkingTimingKey(timestamp, index)
      return rt.thinkingDurations[key] != null ? null : {
        thinkingDurations: { ...rt.thinkingDurations, [key]: Math.max(1000, durationMs) }
      }
    }),

    appendLiveMessage: (sessionId, message) => update(sessionId, (rt) => {
      // Only the optimistic first user message is replaced by a message_start.
      // Consecutive tool results and assistant messages are distinct messages.
      const liveMessages = [...rt.liveMessages]
      const optimistic = rt.pendingUserMessage && message.role === 'user'
        ? liveMessages.findLastIndex((item) => item.role === 'user') : -1
      if (optimistic !== -1) liveMessages[optimistic] = message
      else liveMessages.push(message)
      return {
        liveMessages,
        toolUpdates: toolUpdatesAfterMessage(rt.toolUpdates, message),
        pendingUserMessage: rt.pendingUserMessage && message.role !== 'user'
      }
    }),

    replaceLiveMessage: (sessionId, message) => update(sessionId, (rt) => {
      const index = rt.liveMessages.findLastIndex((item) => sameMessage(item, message))
      const liveMessages = [...rt.liveMessages]
      if (index === -1) liveMessages.push(message)
      else liveMessages[index] = message
      return { liveMessages, toolUpdates: toolUpdatesAfterMessage(rt.toolUpdates, message) }
    }),

    setToolUpdates: (sessionId, updates) => update(sessionId, (rt) => ({
      toolUpdates: { ...rt.toolUpdates, ...updates }
    })),

    setRetryNotice: (sessionId, retryNotice) => update(sessionId, { retryNotice }),

    viewBranch: async (sessionId, tipId) => {
      const initial = get().runtime[sessionId]
      if (!initial) return
      const branchRequest = initial.branchRequest + 1
      update(sessionId, { branchRequest, toolUpdates: {}, retryNotice: null })
      const branch = await api.viewBranch(sessionId, tipId)
      const latest = currentInstance(sessionId, initial)
      if (!latest || latest.branchRequest !== branchRequest) return
      const branchViewId = branch.leafId === latest.leafId ? latest.branchViewId
        : (branch.leafId ? latest.branchViews[branch.leafId] : undefined) ?? createBranchViewId()
      const hydrated = await get().hydrateTurns(sessionId, {
        expectedLeafId: branch.leafId,
        expectedBranchRequest: branchRequest,
        branchViewId,
        display: branch
      })
      if (!hydrated || currentInstance(sessionId, initial)?.branchRequest !== branchRequest) return
      await get().loadControls(sessionId)
    }
  }
}
