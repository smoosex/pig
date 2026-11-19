/** Main-session telemetry collector. Aggregates memory tool calls per persisted user turn in memory
 * and appends one bounded JSONL line upon settlement, steering switch, or teardown. */
import type { ExtensionAPI, ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent'
import { memoryAccess } from '../long-term/access'
import { projectMemoryKey } from '../long-term/files'
import type { MemoryScope } from '../../../../shared/long-term-memory'
import { appendTelemetryRow, appendTelemetryRowSync, MAX_TELEMETRY_OPS_PER_ROW } from './store'
import type { MemoryTelemetryGap, MemoryTelemetryOp, MemoryTelemetryOpName, MemoryTelemetryOutcome, MemoryTelemetryRow } from './types'

export interface MemoryToolTelemetryEvent {
  toolCallId: string
  op: MemoryTelemetryOpName
  scope: MemoryScope
  resolvedProjectId?: string
  ok: boolean
  path?: string
  pathOmitted?: boolean
  from?: string
  fromOmitted?: boolean
  rev?: string
  beforeRev?: string
  afterRev?: string
  offset?: number
  hasMore?: boolean
  query?: string
  hits?: number
  count?: number
  err?: string
  committed?: boolean
  disabled?: boolean
}

const MAX_TRACKED_TOOLS_PER_TURN = 256
const MEMORY_TOOL_NAMES = new Set(['memory_read', 'memory_add', 'memory_edit', 'memory_delete'])

interface Segment {
  calls: number
  errs: number
}

interface InFlightTool {
  toolCallId: string
  parentToolCallId?: string
  segment?: Segment
  countedInSegment: boolean
  isMemoryWrapper: boolean
  isMemory: boolean
  finished: boolean
  isError: boolean
  plainChildren: InFlightTool[]
}

interface MemorySlot {
  toolCallId: string
  afterSeg: Segment
  op?: Omit<MemoryTelemetryOp, 'gap'>
  resolvedProjectId?: string
  dropped: boolean
  settled: boolean
}

interface ActiveTurn {
  epoch: number
  sessionId: string
  userMessage: unknown
  turnId?: string
  anchorEntryId?: string
  projectId?: string
  projectResolved: boolean
  projectPromise?: Promise<void>
  lastStopReason?: string
  segments: Segment[]
  slots: MemorySlot[]
  slotsByToolCallId: Map<string, MemorySlot>
  inFlight: Map<string, InFlightTool>
  settled: boolean
  truncated: boolean
  omittedMemory: boolean
}

function resolveTurnIdsFromBranch(
  branch: SessionEntry[],
  userMessage: unknown,
  knownTurnId?: string
): { turnId?: string; anchorEntryId?: string } {
  let userIndex = -1
  if (knownTurnId) {
    userIndex = branch.findIndex(entry => entry.id === knownTurnId && entry.type === 'message' && entry.message.role === 'user')
  }
  if (userIndex < 0) {
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i]!
      if (entry.type === 'message' && entry.message.role === 'user' && entry.message === userMessage) {
        userIndex = i
        break
      }
    }
  }
  if (userIndex < 0) {
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i]!
      if (entry.type === 'message' && entry.message.role === 'user') {
        const ts = (userMessage as { timestamp?: unknown } | undefined)?.timestamp
        if (typeof ts === 'number' && entry.message.timestamp === ts) {
          userIndex = i
          break
        }
      }
    }
  }
  if (userIndex < 0) return {}
  const turnId = branch[userIndex]!.id
  let anchorEntryId: string | undefined
  for (let i = userIndex + 1; i < branch.length; i++) {
    const entry = branch[i]!
    if (entry.type === 'message') {
      if (entry.message.role === 'user') break
      if (entry.message.role === 'assistant' || entry.message.role === 'toolResult') {
        anchorEntryId = entry.id
      }
    }
  }
  return { turnId, anchorEntryId }
}

function refreshAttribution(turn: ActiveTurn, ctx: ExtensionContext): void {
  const branch = ctx.sessionManager?.getBranch?.()
  if (!Array.isArray(branch)) return
  const resolved = resolveTurnIdsFromBranch(branch, turn.userMessage, turn.turnId)
  if (resolved.turnId) turn.turnId = resolved.turnId
  if (resolved.anchorEntryId) turn.anchorEntryId = resolved.anchorEntryId
}

function findCountedAncestor(turn: ActiveTurn, parentToolCallId: string | undefined): InFlightTool | undefined {
  let cursor = parentToolCallId
  while (cursor) {
    const tool = turn.inFlight.get(cursor)
    if (!tool) return undefined
    if (tool.countedInSegment && !tool.isMemoryWrapper) return tool
    cursor = tool.parentToolCallId
  }
  return undefined
}

function restorePlainDescendants(children: InFlightTool[]): void {
  for (const child of children) {
    if (child.isMemory) continue
    if (child.isMemoryWrapper) {
      restorePlainDescendants(child.plainChildren)
      continue
    }
    if (!child.countedInSegment && child.segment) {
      child.segment.calls += 1
      if (child.finished && child.isError) child.segment.errs += 1
      child.countedInSegment = true
    }
  }
}

function markAncestorsMemoryWrapper(turn: ActiveTurn, parentToolCallId: string | undefined): void {
  let cursor = parentToolCallId
  while (cursor) {
    const ancestor = turn.inFlight.get(cursor)
    if (!ancestor) break
    if (!ancestor.isMemoryWrapper) {
      ancestor.isMemoryWrapper = true
      if (ancestor.countedInSegment && ancestor.segment) {
        ancestor.segment.calls = Math.max(0, ancestor.segment.calls - 1)
        if (ancestor.finished && ancestor.isError) {
          ancestor.segment.errs = Math.max(0, ancestor.segment.errs - 1)
        }
        ancestor.countedInSegment = false
      }
      restorePlainDescendants(ancestor.plainChildren)
    }
    cursor = ancestor.parentToolCallId
  }
}

function collapseTurnSegments(turn: ActiveTurn): { ops: MemoryTelemetryOp[]; tail: MemoryTelemetryGap } {
  const first = turn.segments[0] ?? { calls: 0, errs: 0 }
  let acc: MemoryTelemetryGap = { calls: first.calls, errs: first.errs }
  const ops: MemoryTelemetryOp[] = []
  for (const slot of turn.slots) {
    if (slot.settled && !slot.dropped && slot.op) {
      const op: MemoryTelemetryOp = {
        ...slot.op,
        ...(slot.op.scope === 'project' && slot.resolvedProjectId && slot.resolvedProjectId !== turn.projectId
          ? { projectId: slot.resolvedProjectId }
          : {}),
        gap: acc
      }
      ops.push(op)
      acc = { calls: slot.afterSeg.calls, errs: slot.afterSeg.errs }
    } else {
      acc.calls += slot.afterSeg.calls
      acc.errs += slot.afterSeg.errs
    }
  }
  return { ops, tail: acc }
}

function buildRow(turn: ActiveTurn, outcome: MemoryTelemetryOutcome, at: number): MemoryTelemetryRow | null {
  if (!turn.turnId) return null
  const { ops, tail } = collapseTurnSegments(turn)
  if (!ops.length && !turn.omittedMemory) return null
  return {
    v: 1,
    at,
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    ...(turn.anchorEntryId ? { anchorEntryId: turn.anchorEntryId } : {}),
    ...(turn.projectId ? { projectId: turn.projectId } : {}),
    outcome,
    ops,
    tail,
    ...(turn.truncated ? { opsTruncated: true } : {})
  }
}

export interface TelemetryCollectorOptions {
  telemetryRoot?: string
  now?: () => number
}

export function createMemoryTelemetryCollector(pi: ExtensionAPI, options: TelemetryCollectorOptions = {}): (event: MemoryToolTelemetryEvent) => void {
  const now = options.now ?? (() => Date.now())
  let epoch = 0
  let disposed = false
  let activeTurn: ActiveTurn | undefined

  const startProjectLookup = (turn: ActiveTurn, ctx: ExtensionContext) => {
    const capturedEpoch = turn.epoch
    turn.projectPromise = memoryAccess(ctx).then(access => {
      if (disposed || turn.settled || turn.epoch !== capturedEpoch) return
      turn.projectId = access.project.startsWith('chat:') ? undefined : projectMemoryKey(access.project)
      turn.projectResolved = true
    }).catch(() => {
      if (disposed || turn.settled || turn.epoch !== capturedEpoch) return
      turn.projectResolved = true
    })
  }

  const finalizeTurn = (turn: ActiveTurn | undefined, outcome: MemoryTelemetryOutcome, syncOnly: boolean): void => {
    if (!turn || turn.settled) return
    turn.settled = true
    if (activeTurn === turn) activeTurn = undefined
    epoch += 1
    const settledAt = now()
    const write = () => {
      try {
        const row = buildRow(turn, outcome, settledAt)
        if (!row) return
        if (syncOnly) appendTelemetryRowSync(row, { root: options.telemetryRoot, now: settledAt })
        else void appendTelemetryRow(row, { root: options.telemetryRoot, now: settledAt })
      } catch {
        // Telemetry persistence failures must never affect session state or tool outcomes.
      }
    }
    if (syncOnly || turn.projectResolved || !turn.projectPromise) {
      write()
      return
    }
    const { ops } = collapseTurnSegments(turn)
    if (!turn.turnId || (!ops.length && !turn.omittedMemory)) return
    void turn.projectPromise.then(write, write)
  }

  pi.on('session_start', () => {
    disposed = false
    epoch += 1
    activeTurn = undefined
  })

  pi.on('message_start', (event, ctx) => {
    if (disposed || event.message.role !== 'user') return
    if (activeTurn && !activeTurn.settled) {
      refreshAttribution(activeTurn, ctx)
      finalizeTurn(activeTurn, 'steered', false)
    }
    const sessionId = ctx.sessionManager?.getSessionId?.()
    if (!sessionId) return
    const turnEpoch = ++epoch
    const turn: ActiveTurn = {
      epoch: turnEpoch,
      sessionId,
      userMessage: event.message,
      projectResolved: false,
      segments: [{ calls: 0, errs: 0 }],
      slots: [],
      slotsByToolCallId: new Map(),
      inFlight: new Map(),
      settled: false,
      truncated: false,
      omittedMemory: false
    }
    activeTurn = turn
    startProjectLookup(turn, ctx)
  })

  pi.on('turn_start', (_event, ctx) => {
    if (disposed || !activeTurn || activeTurn.settled) return
    refreshAttribution(activeTurn, ctx)
  })

  pi.on('tool_execution_start', (event, ctx) => {
    if (disposed || !activeTurn || activeTurn.settled) return
    const turn = activeTurn
    if (!turn.turnId) refreshAttribution(turn, ctx)
    const parentId = event.parentToolCallId
    const isMemory = MEMORY_TOOL_NAMES.has(event.toolName)
    if (isMemory) markAncestorsMemoryWrapper(turn, parentId)
    if (turn.truncated || turn.inFlight.size >= MAX_TRACKED_TOOLS_PER_TURN || (isMemory && turn.slots.length >= MAX_TELEMETRY_OPS_PER_ROW)) {
      turn.truncated = true
      return
    }
    if (isMemory) {
      const beforeSeg = turn.segments[turn.segments.length - 1]!
      const afterSeg: Segment = { calls: 0, errs: 0 }
      turn.segments.push(afterSeg)
      const slot: MemorySlot = { toolCallId: event.toolCallId, afterSeg, dropped: false, settled: false }
      turn.slots.push(slot)
      turn.slotsByToolCallId.set(event.toolCallId, slot)
      turn.inFlight.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        parentToolCallId: parentId,
        segment: beforeSeg,
        countedInSegment: false,
        isMemoryWrapper: false,
        isMemory: true,
        finished: false,
        isError: false,
        plainChildren: []
      })
      return
    }

    const seg = turn.segments[turn.segments.length - 1]!
    const countedAncestor = findCountedAncestor(turn, parentId)
    const entry: InFlightTool = {
      toolCallId: event.toolCallId,
      parentToolCallId: parentId,
      segment: seg,
      countedInSegment: !countedAncestor,
      isMemoryWrapper: false,
      isMemory: false,
      finished: false,
      isError: false,
      plainChildren: []
    }
    if (!countedAncestor) {
      seg.calls += 1
    } else if (parentId) {
      turn.inFlight.get(parentId)?.plainChildren.push(entry)
    }
    turn.inFlight.set(event.toolCallId, entry)
  })

  pi.on('tool_execution_end', (event, ctx) => {
    if (disposed || !activeTurn || activeTurn.settled) return
    const turn = activeTurn
    const entry = turn.inFlight.get(event.toolCallId)
    if (!entry) return
    entry.finished = true
    entry.isError = Boolean(event.isError)
    if (entry.isMemory) {
      const slot = turn.slotsByToolCallId.get(event.toolCallId)
      if (slot) {
        if (!slot.op) slot.dropped = true
        slot.settled = true
      }
      refreshAttribution(turn, ctx)
      return
    }
    if (entry.countedInSegment && !entry.isMemoryWrapper && event.isError && entry.segment) {
      entry.segment.errs += 1
    }
  })

  pi.on('message_end', (event) => {
    if (disposed || !activeTurn || activeTurn.settled) return
    if (event.message.role === 'assistant' && event.message.stopReason) {
      activeTurn.lastStopReason = event.message.stopReason
    }
  })

  pi.on('turn_end', (event) => {
    if (disposed || !activeTurn || activeTurn.settled) return
    const anchor = event.toolResultEntryIds?.at(-1) ?? event.messageEntryId
    if (anchor) activeTurn.anchorEntryId = anchor
    if (event.message.role === 'assistant' && event.message.stopReason) {
      activeTurn.lastStopReason = event.message.stopReason
    }
  })

  pi.on('agent_settled', (event, ctx) => {
    if (disposed || !activeTurn || activeTurn.settled) return
    const turn = activeTurn
    refreshAttribution(turn, ctx)
    const outcome: MemoryTelemetryOutcome = event.aborted
      ? 'aborted'
      : turn.lastStopReason === 'error'
        ? 'error'
        : 'completed'
    finalizeTurn(turn, outcome, false)
  })

  pi.on('session_tree', () => {
    if (disposed) return
    if (activeTurn && !activeTurn.settled) {
      const outcome: MemoryTelemetryOutcome = activeTurn.lastStopReason === 'error'
        ? 'error'
        : activeTurn.lastStopReason === 'aborted'
          ? 'aborted'
          : 'unknown'
      finalizeTurn(activeTurn, outcome, false)
    } else {
      epoch += 1
      activeTurn = undefined
    }
  })

  pi.on('session_shutdown', (_event, ctx) => {
    if (disposed) return
    if (activeTurn && !activeTurn.settled) {
      refreshAttribution(activeTurn, ctx)
      const outcome: MemoryTelemetryOutcome = activeTurn.lastStopReason === 'error'
        ? 'error'
        : activeTurn.lastStopReason === 'aborted'
          ? 'aborted'
          : 'unknown'
      finalizeTurn(activeTurn, outcome, true)
    }
    disposed = true
    epoch += 1
    activeTurn = undefined
  })

  return (event: MemoryToolTelemetryEvent) => {
    if (disposed || !activeTurn || activeTurn.settled) return
    const slot = activeTurn.slotsByToolCallId.get(event.toolCallId)
    if (!slot) {
      if (activeTurn.truncated && !event.disabled) activeTurn.omittedMemory = true
      return
    }
    if (event.disabled) {
      slot.dropped = true
      slot.settled = true
      return
    }
    slot.resolvedProjectId = event.resolvedProjectId
    slot.settled = true
    slot.op = {
      op: event.op,
      scope: event.scope,
      ok: event.ok,
      ...(event.path !== undefined ? { path: event.path } : {}),
      ...(event.pathOmitted ? { pathOmitted: true } : {}),
      ...(event.from !== undefined ? { from: event.from } : {}),
      ...(event.fromOmitted ? { fromOmitted: true } : {}),
      ...(event.rev !== undefined ? { rev: event.rev } : {}),
      ...(event.beforeRev !== undefined ? { beforeRev: event.beforeRev } : {}),
      ...(event.afterRev !== undefined ? { afterRev: event.afterRev } : {}),
      ...(event.offset !== undefined ? { offset: event.offset } : {}),
      ...(event.hasMore !== undefined ? { hasMore: event.hasMore } : {}),
      ...(event.query !== undefined ? { query: event.query } : {}),
      ...(event.hits !== undefined ? { hits: event.hits } : {}),
      ...(event.count !== undefined ? { count: event.count } : {}),
      ...(event.err !== undefined ? { err: event.err } : {}),
      ...(event.committed ? { committed: true } : {})
    }
  }
}
