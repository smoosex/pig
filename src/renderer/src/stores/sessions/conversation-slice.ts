/**
 * Conversation projection: persisted turns plus the current Pi message stream.
 * Requests belong to a runtime instance, so closing/reopening the same session
 * cannot let an old response replace the new view.
 */
import { api } from '../../ipc/api'
import { buildTurn, thinkingTimingKey } from '../../chat/turns'
import { isPiMessage } from '../../pi/types'
import { createBranchViewId, patchRuntime, sameMessage } from './runtime'
import type { RuntimeState, SessionSlice } from './types'

export const createConversationSlice: SessionSlice<
  | 'runtime'
  | 'hydrateTurns'
  | 'loadTurnProcess'
  | 'loadControls'
  | 'applyControls'
  | 'setFollowUpMessages'
  | 'queueFollowUpAction'
  | 'clearQueuedEditText'
  | 'setThinkingLevel'
  | 'setStreaming'
  | 'beginPrompt'
  | 'rollbackPrompt'
  | 'setThinkingDuration'
  | 'appendLiveMessage'
  | 'replaceLiveMessage'
  | 'viewBranch'
> = (set, get) => {
  const historyRequests = new Map<number, object>()
  const controlRequests = new Map<number, object>()
  const processRequests = new Map<string, Promise<void>>()

  const currentInstance = (sessionId: string, expected: RuntimeState) => {
    const current = get().runtime[sessionId]
    return current?.instanceId === expected.instanceId ? current : undefined
  }

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
        const result = await api.getDisplayTurns(sessionId)
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
          return {
            turns: result.turns,
            leafId: result.leafId,
            branchViewId,
            branchViews,
            liveMessages: rt.isStreaming ? rt.liveMessages : [],
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
      streamStartedAt: streaming ? (rt.isStreaming ? rt.streamStartedAt : Date.now()) : null,
      streamElapsedMs: streaming ? null : rt.streamStartedAt != null
        ? Date.now() - rt.streamStartedAt : rt.streamElapsedMs
    })),

    beginPrompt: (sessionId, message) => update(sessionId, (rt) => ({
      isStreaming: true,
      streamStartedAt: rt.isStreaming ? rt.streamStartedAt : Date.now(),
      streamElapsedMs: null,
      liveMessages: [...rt.liveMessages, message],
      pendingUserMessage: true
    })),

    rollbackPrompt: (sessionId) => update(sessionId, (rt) => ({
      isStreaming: false,
      streamStartedAt: null,
      streamElapsedMs: null,
      liveMessages: rt.pendingUserMessage ? rt.liveMessages.slice(0, -1) : rt.liveMessages,
      pendingUserMessage: false
    })),

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
      return { liveMessages, pendingUserMessage: rt.pendingUserMessage && message.role !== 'user' }
    }),

    replaceLiveMessage: (sessionId, message) => update(sessionId, (rt) => {
      const index = rt.liveMessages.findLastIndex((item) => sameMessage(item, message))
      if (index === -1) return { liveMessages: [...rt.liveMessages, message] }
      const liveMessages = [...rt.liveMessages]
      liveMessages[index] = message
      return { liveMessages }
    }),

    viewBranch: async (sessionId, tipId) => {
      const initial = get().runtime[sessionId]
      if (!initial) return
      const branchRequest = initial.branchRequest + 1
      update(sessionId, { branchRequest })
      const branch = await api.viewBranch(sessionId, tipId)
      const latest = currentInstance(sessionId, initial)
      if (!latest || latest.branchRequest !== branchRequest) return
      const branchViewId = branch.leafId === latest.leafId ? latest.branchViewId
        : (branch.leafId ? latest.branchViews[branch.leafId] : undefined) ?? createBranchViewId()
      const hydrated = await get().hydrateTurns(sessionId, {
        expectedLeafId: branch.leafId,
        expectedBranchRequest: branchRequest,
        branchViewId
      })
      if (!hydrated || currentInstance(sessionId, initial)?.branchRequest !== branchRequest) return
      await get().loadControls(sessionId)
    }
  }
}
