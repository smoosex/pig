/**
 * Unified stop coordinator for sessions, controlled tasks, subagents, and Bot-managed runs.
 * UI `session:abort`, agent `stop`, worktree removal, and session close all funnel through here
 * with an explicit `stopOrigin`, aborting preflight submissions and waiting for subagents to settle.
 */
import type { SessionStopOrigin } from '../../shared/session-agent'

export interface StopParticipant {
  /** Called synchronously before aborting the agent session; may return a promise awaiting submission settle. */
  onBeforeStop?: (sessionId: string, origin: SessionStopOrigin) => Promise<void> | void
  /** Called after agent, submissions, and subagents have all settled. */
  onAfterStop?: (sessionId: string, origin: SessionStopOrigin) => Promise<void> | void
}

export interface SessionStopRuntimeDeps {
  getAgent(sessionId: string): { abort(): Promise<void> } | undefined
  prepareAgent?(sessionId: string): Promise<{ abort(): Promise<void> } | undefined>
  abortSubagents(sessionId: string): Promise<void>
}

export class SessionStopCoordinator {
  private participants = new Set<StopParticipant>()
  private deps?: SessionStopRuntimeDeps

  setRuntimeDeps(deps: SessionStopRuntimeDeps): void {
    this.deps = deps
  }

  registerParticipant(participant: StopParticipant): () => void {
    this.participants.add(participant)
    return () => { this.participants.delete(participant) }
  }

  async stop(
    sessionId: string,
    origin: SessionStopOrigin,
    options?: { prepare?: boolean }
  ): Promise<void> {
    const beforeTasks: Array<Promise<void>> = []
    for (const participant of [...this.participants]) {
      if (!participant.onBeforeStop) continue
      try {
        const result = participant.onBeforeStop(sessionId, origin)
        if (result) beforeTasks.push(Promise.resolve(result))
      } catch (error) {
        console.error('SessionStopCoordinator onBeforeStop error:', error)
      }
    }

    const deps = this.deps
    let agent = deps?.getAgent(sessionId)
    if (!agent && options?.prepare && deps?.prepareAgent) {
      agent = await deps.prepareAgent(sessionId)
    }

    const subagentsPromise = deps ? deps.abortSubagents(sessionId) : Promise.resolve()
    const abortPromise = agent ? agent.abort() : Promise.resolve()

    const settled = await Promise.allSettled([
      abortPromise,
      subagentsPromise,
      ...beforeTasks
    ])

    // Re-abort once after submissions settle in case a turn slipped in just before cancellation.
    if (agent) {
      await agent.abort().catch(() => {})
    }

    for (const participant of [...this.participants]) {
      if (!participant.onAfterStop) continue
      try {
        await participant.onAfterStop(sessionId, origin)
      } catch (error) {
        console.error('SessionStopCoordinator onAfterStop error:', error)
      }
    }

    // Surface unexpected non-AbortError failures from participants or agent abort.
    for (const item of settled) {
      if (item.status === 'rejected') {
        const err = item.reason
        if (err instanceof DOMException && err.name === 'AbortError') continue
        throw err
      }
    }
  }
}

export const sessionStopCoordinator = new SessionStopCoordinator()

export function stopSessionExecution(
  sessionId: string,
  origin: SessionStopOrigin,
  options?: { prepare?: boolean }
): Promise<void> {
  return sessionStopCoordinator.stop(sessionId, origin, options)
}
