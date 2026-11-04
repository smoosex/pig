/** Track a sent task across parent idle gaps, child final writes, and background report delivery. */
import { randomUUID } from 'node:crypto'
import type { AgentSession, SessionEntry } from '@earendil-works/pi-coding-agent'
import type { SubagentInfo, TurnUsage } from '../../shared/api'
import type { SessionAgentTask } from '../../shared/session-agent'
import { addUsage } from '../../shared/turn-usage'

export interface SessionTaskDeps {
  current(sessionId: string): AgentSession | undefined
  children(sessionId: string): SubagentInfo[]
  pendingChildren(sessionId: string): boolean
  busy(sessionId: string): boolean
  waitingApproval?(sessionId: string): boolean
  now?: () => number
}
interface Record {
  caller: string
  agent?: AgentSession
  entryOffset: number
  childBaseline: Map<string, { usage?: TurnUsage; cost: number; turns: number }>
  value: SessionAgentTask
  started: number
  promptDone: boolean
  settled: boolean
  aborted: boolean
  submissionAbort: AbortController
  submission?: Promise<void>
  unsubscribe: () => void
  release: () => void
  timer?: ReturnType<typeof setTimeout>
}

function usageIn(entries: readonly SessionEntry[]) {
  let usage: TurnUsage | undefined
  let cost = 0
  let incomplete = false
  for (const entry of entries) {
    const measured = entry.type === 'message' && entry.message.role === 'assistant'
      ? entry.message.usage
      : entry.type === 'usage' || entry.type === 'compaction' || entry.type === 'branch_summary' ? entry.usage : undefined
    const expected = entry.type === 'usage' || entry.type === 'compaction' || entry.type === 'branch_summary' || (entry.type === 'message' && entry.message.role === 'assistant')
    if (!measured) { if (expected) incomplete = true; continue }
    usage = addUsage(usage, measured)
    if (Number.isFinite(measured.cost?.total)) cost += measured.cost.total
    else incomplete = true
  }
  return { usage, cost, incomplete }
}

export class SessionTaskTracker {
  private records = new Map<string, Record>()
  private now: () => number
  constructor(private deps: SessionTaskDeps) { this.now = deps.now ?? (() => performance.now()) }

  active(sessionId: string): boolean {
    return [...this.records.values()].some(record => record.value.sessionId === sessionId && record.value.status === 'running')
  }

  start(caller: string, sessionId: string, agent: AgentSession, release: () => void): string {
    if (this.active(sessionId)) throw new Error('Session already has a running controlled task')
    const owned = [...this.records.entries()].filter(([, record]) => record.caller === caller)
    if (owned.filter(([, record]) => record.value.status === 'running').length >= 8) throw new Error('At most 8 tasks may run per caller')
    if ([...this.records.values()].filter(record => record.value.status === 'running').length >= 64) throw new Error('Too many running session tasks')
    let retained = owned.length
    for (const [id, record] of owned) {
      if (retained < 32) break
      if (record.value.status !== 'running') { this.records.delete(id); retained-- }
    }
    for (const [id, record] of this.records) {
      if (this.records.size < 256) break
      if (record.value.status !== 'running') this.records.delete(id)
    }
    if (this.records.size >= 256) throw new Error('Session task record limit reached')
    const taskId = randomUUID()
    const record: Record = {
      caller, agent, entryOffset: agent.sessionManager.getEntries().length,
      childBaseline: new Map(this.deps.children(sessionId).map(child => [child.id, { usage: child.usage && { ...child.usage }, cost: child.cost, turns: child.turns }])),
      value: { taskId, sessionId, status: 'running', startedAt: Date.now(), durationMs: 0, reply: '', cost: 0, usageIncomplete: false, children: 0 },
      started: this.now(), promptDone: false, settled: false, aborted: false,
      submissionAbort: new AbortController(), unsubscribe: () => {}, release,
    }
    record.unsubscribe = agent.subscribe(event => {
      if (event.type === 'agent_start') record.settled = false
      if (event.type === 'agent_settled') { record.settled = true; record.aborted ||= event.aborted }
    })
    this.records.set(taskId, record)
    this.schedule(record)
    return taskId
  }

  submitted(taskId: string, work: Promise<void>): void {
    const record = this.records.get(taskId)!
    record.submission = work
    work.then(() => { record.promptDone = true }, error => {
      record.promptDone = true
      record.value.error = error instanceof Error ? error.message : String(error)
    })
  }

  private schedule(record: Record): void {
    record.timer = setTimeout(() => {
      try { this.tick(record) } catch (error) {
        record.value.error = error instanceof Error ? error.message : String(error)
        this.finish(record, 'failed')
      }
      if (record.value.status === 'running') this.schedule(record)
    }, 50)
    record.timer.unref?.()
  }

  private measure(record: Record): void {
    const entries = record.agent!.sessionManager.getEntries().slice(record.entryOffset)
    const parent = usageIn(entries)
    let usage = parent.usage
    let cost = parent.cost
    let incomplete = parent.incomplete
    const children = this.deps.children(record.value.sessionId).filter(child => {
      const before = record.childBaseline.get(child.id)
      return !before || child.turns !== before.turns || child.cost !== before.cost
    })
    for (const child of children) {
      const before = record.childBaseline.get(child.id)
      if (child.usage) {
        const delta = Object.fromEntries((['input', 'output', 'cacheRead', 'cacheWrite'] as const).map(key => [key, Math.max(0, child.usage![key] - (before?.usage?.[key] ?? 0))])) as Pick<TurnUsage, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>
        usage = addUsage(usage, delta)!
        usage.calls += Math.max(0, child.usage.calls - (before?.usage?.calls ?? 0)) - 1
      }
      cost += Math.max(0, child.cost - (before?.cost ?? 0))
      // The current child index measures assistant messages, not every auxiliary/compaction call.
      incomplete = true
    }
    const last = entries.findLast(entry => entry.type === 'message' && entry.message.role === 'assistant')
    if (last?.type === 'message' && last.message.role === 'assistant') {
      record.value.reply = last.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').slice(0, 32000)
    }
    Object.assign(record.value, { usage, cost, usageIncomplete: incomplete, children: children.length, durationMs: Math.max(0, this.now() - record.started) })
  }

  private tick(record: Record): void {
    if (this.deps.current(record.value.sessionId) !== record.agent) {
      record.value.error = 'Target session was closed or replaced'
      this.finish(record, 'aborted')
      return
    }
    this.measure(record)
    if (!record.promptDone || this.deps.busy(record.value.sessionId) || this.deps.pendingChildren(record.value.sessionId)) return
    if (record.aborted) { this.finish(record, 'aborted'); return }
    if (!record.settled && !record.value.error) {
      record.value.error = 'Input was handled without a model run'
      this.finish(record, 'failed')
      return
    }
    const last = record.agent!.sessionManager.getEntries().slice(record.entryOffset).findLast(entry => entry.type === 'message' && entry.message.role === 'assistant')
    if (last?.type === 'message' && last.message.role === 'assistant') {
      if (last.message.stopReason !== 'stop') record.value.error ??= last.message.errorMessage || `Model stopped with ${last.message.stopReason}`
    } else record.value.error ??= 'No final assistant response was produced'
    this.finish(record, record.value.error ? 'failed' : 'completed')
  }

  private finish(record: Record, status: SessionAgentTask['status']): void {
    if (record.value.status !== 'running') return
    clearTimeout(record.timer)
    record.value.status = status
    record.value.endedAt = Date.now()
    record.value.durationMs = Math.max(0, this.now() - record.started)
    try { record.unsubscribe() } finally {
      try { record.release() } finally {
        record.agent = undefined
        record.submission = undefined
        record.unsubscribe = () => {}
        record.release = () => {}
        record.childBaseline.clear()
      }
    }
  }

  status(caller: string, taskId: string): SessionAgentTask {
    const record = this.records.get(taskId)
    if (!record || record.caller !== caller) throw new Error('No task with this ID belongs to this session')
    const snapshot = structuredClone(record.value)
    if (snapshot.status === 'running' && this.deps.waitingApproval?.(snapshot.sessionId)) snapshot.blockedBy = 'approval'
    return snapshot
  }

  assertSubmissionActive(taskId: string): void {
    const record = this.records.get(taskId)
    if (!record || record.value.status !== 'running') throw new DOMException('Session task is no longer active', 'AbortError')
    record.submissionAbort.signal.throwIfAborted()
  }

  async markStopping(sessionId: string): Promise<void> {
    const records = [...this.records.values()].filter(record => record.value.sessionId === sessionId && record.value.status === 'running')
    // Invalidate all preflights synchronously before waiting for any active run to abort.
    for (const record of records) {
      record.aborted = true
      record.submissionAbort.abort(new DOMException('Session task stopped', 'AbortError'))
    }
    const results = await Promise.allSettled(records.map(record => record.submission))
    for (const [index, result] of results.entries()) {
      // Our cancellation is expected; other submission failures remain real errors.
      if (result.status === 'rejected' && result.reason !== records[index].submissionAbort.signal.reason) throw result.reason
    }
  }

  async wait(caller: string, taskId: string, timeoutMs: number, signal?: AbortSignal): Promise<{ timedOut: boolean; task: SessionAgentTask }> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('Invalid wait timeout')
    const until = this.now() + timeoutMs
    while (true) {
      signal?.throwIfAborted()
      const task = this.status(caller, taskId)
      if (task.status !== 'running' || task.blockedBy === 'approval') return { timedOut: false, task }
      if (this.now() >= until) return { timedOut: true, task }
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => signal?.removeEventListener('abort', abort)
        const timer = setTimeout(() => { cleanup(); resolve() }, Math.min(50, Math.max(1, until - this.now())))
        const abort = () => { clearTimeout(timer); cleanup(); reject(signal?.reason) }
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      })
    }
  }

  dispose(): void {
    for (const record of this.records.values()) this.finish(record, 'aborted')
    this.records.clear()
  }
}
