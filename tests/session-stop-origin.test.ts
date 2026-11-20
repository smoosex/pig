import { describe, expect, test } from 'bun:test'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { SessionTaskTracker } from '../src/main/pi/session-agent-tasks'
import { SessionStopCoordinator } from '../src/main/pi/session-stop'
import type { SessionAgentTask } from '../src/shared/session-agent'

function makeFakeAgent() {
  const listeners = new Set<(event: { type: string; aborted?: boolean }) => void>()
  const entries: unknown[] = []
  let abortCalls = 0
  const agent = {
    sessionManager: {
      getEntries: () => entries
    },
    subscribe(fn: (event: { type: string; aborted?: boolean }) => void) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    async abort() {
      abortCalls++
    },
    emit(event: { type: string; aborted?: boolean }) {
      for (const fn of [...listeners]) fn(event)
    },
    pushAssistant(text: string, stopReason = 'stop') {
      entries.push({
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text }], stopReason }
      })
    },
    get abortCalls() { return abortCalls }
  }
  return agent
}

describe('unified session stop coordination and stopOrigin propagation', () => {
  test('propagates user stopOrigin on running task and prevents late normal stop from flipping status to completed', async () => {
    const agent = makeFakeAgent()
    let busy = true
    const tracker = new SessionTaskTracker({
      current: () => agent as unknown as AgentSession,
      children: () => [],
      pendingChildren: () => false,
      busy: () => busy
    })
    const coordinator = new SessionStopCoordinator()
    coordinator.setRuntimeDeps({
      getAgent: () => agent,
      abortSubagents: async () => {}
    })
    coordinator.registerParticipant({
      onBeforeStop: (sessionId, origin) => tracker.markStopping(sessionId, origin)
    })

    const finished: SessionAgentTask[] = []
    tracker.subscribeFinished((snapshot) => finished.push(snapshot))

    const taskId = tracker.start('caller-1', 'sess-1', agent as unknown as AgentSession, () => {})
    tracker.submitted(taskId, Promise.resolve())

    await coordinator.stop('sess-1', 'user')
    // Simulate a late assistant message arriving with normal stopReason after abort.
    agent.pushAssistant('late output', 'stop')
    agent.emit({ type: 'agent_settled', aborted: false })
    busy = false

    await new Promise((r) => setTimeout(r, 120))

    expect(finished).toHaveLength(1)
    expect(finished[0].status).toBe('aborted')
    expect(finished[0].stopOrigin).toBe('user')
    expect(agent.abortCalls).toBeGreaterThanOrEqual(2)
    tracker.dispose()
  })

  test('invalidates preflight submission synchronously and waits for submission and subagents before onAfterStop', async () => {
    const agent = makeFakeAgent()
    const order: string[] = []
    let releaseSubagent!: () => void
    let releaseSubmission!: () => void

    const tracker = new SessionTaskTracker({
      current: () => agent as unknown as AgentSession,
      children: () => [],
      pendingChildren: () => false,
      busy: () => false
    })
    const coordinator = new SessionStopCoordinator()
    coordinator.setRuntimeDeps({
      getAgent: () => agent,
      abortSubagents: async () => {
        order.push('subagents:start')
        await new Promise<void>((resolve) => { releaseSubagent = resolve })
        order.push('subagents:done')
      }
    })
    coordinator.registerParticipant({
      onBeforeStop: (sessionId, origin) => {
        order.push(`before:${origin}`)
        return tracker.markStopping(sessionId, origin)
      },
      onAfterStop: (_sessionId, origin) => {
        order.push(`after:${origin}`)
      }
    })

    const taskId = tracker.start('caller-1', 'sess-2', agent as unknown as AgentSession, () => {})
    const preflight = new Promise<void>((resolve, reject) => {
      releaseSubmission = () => {
        try {
          tracker.assertSubmissionActive(taskId)
          resolve()
        } catch (err) {
          reject(err)
        }
      }
    })
    tracker.submitted(taskId, preflight)

    const stopping = coordinator.stop('sess-2', 'worktree_deleted')
    // Submission abort must be synchronously active immediately after stop() starts.
    expect(() => tracker.assertSubmissionActive(taskId)).toThrow()

    releaseSubmission()
    releaseSubagent()
    await stopping

    expect(order).toEqual(['before:worktree_deleted', 'subagents:start', 'subagents:done', 'after:worktree_deleted'])
    await new Promise((r) => setTimeout(r, 100))
    expect(tracker.status('caller-1', taskId)).toMatchObject({
      status: 'aborted',
      stopOrigin: 'worktree_deleted'
    })
    tracker.dispose()
  })

  test('preserves the first explicit stopOrigin when duplicate stops race', async () => {
    const agent = makeFakeAgent()
    const tracker = new SessionTaskTracker({
      current: () => agent as unknown as AgentSession,
      children: () => [],
      pendingChildren: () => false,
      busy: () => false
    })
    const taskId = tracker.start('caller-1', 'sess-3', agent as unknown as AgentSession, () => {})
    tracker.submitted(taskId, Promise.resolve())

    await tracker.markStopping('sess-3', 'user')
    await tracker.markStopping('sess-3', 'session_closed')
    await new Promise((r) => setTimeout(r, 100))

    expect(tracker.status('caller-1', taskId)).toMatchObject({
      status: 'aborted',
      stopOrigin: 'user'
    })
    tracker.dispose()
  })
})
