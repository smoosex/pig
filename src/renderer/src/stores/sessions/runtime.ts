import type { RuntimeState } from './types'
import type { PiMessage } from '../../pi/types'

let branchViewSequence = 0
let runtimeSequence = 0

export function createBranchViewId(): string {
  branchViewSequence += 1
  return `branch-view-${branchViewSequence}`
}

export const emptyRuntime = (): RuntimeState => ({
  instanceId: ++runtimeSequence,
  controlsRevision: 0,
  controlsPending: false,
  controlsError: null,
  turns: [],
  turnStart: 0,
  turnSummary: [],
  turnLoading: false,
  turnPending: false,
  // An empty window has nothing to mislabel: only a provisional tail can lower this.
  turnIndexTrusted: true,
  turnError: null,
  leafId: null,
  branchViewId: createBranchViewId(),
  branchViews: {},
  branchRequest: 0,
  liveMessages: [],
  pendingUserMessage: false,
  processByTurnId: {},
  thinkingDurations: {},
  elapsedByTurnId: {},
  isStreaming: false,
  streamStartedAt: null,
  streamElapsedMs: null,
  model: null,
  models: [],
  thinkingLevel: 'off',
  thinkingLevels: ['off'],
  contextUsage: null,
  tokens: null,
  tokensLoading: false,
  tokensError: null,
  followUpMessages: [],
  queuedEditText: null
})

/** Late events and IPC results must never recreate a closed tab's runtime. */
export function patchRuntime(
  runtime: Record<string, RuntimeState>,
  sessionId: string,
  patch: Partial<RuntimeState> | ((current: RuntimeState) => Partial<RuntimeState> | null)
): Record<string, RuntimeState> {
  const current = runtime[sessionId]
  if (!current) return runtime
  const changes = typeof patch === 'function' ? patch(current) : patch
  if (!changes) return runtime
  return {
    ...runtime,
    [sessionId]: { ...current, ...changes }
  }
}

export function sameMessage(left: PiMessage, right: PiMessage): boolean {
  if (left.role !== right.role || left.timestamp !== right.timestamp) return false
  return left.role !== 'toolResult' ||
    (right.role === 'toolResult' && left.toolCallId === right.toolCallId)
}
