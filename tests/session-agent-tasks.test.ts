/** Task tracking uses only persisted entries and lifecycle events, never a model runtime. */
import { afterEach, expect, mock, test } from 'bun:test'
import type { AgentSession, AgentSessionEvent, SessionEntry } from '@earendil-works/pi-coding-agent'
import type { SubagentInfo, TurnUsage } from '../src/shared/api'
import { SessionTaskTracker } from '../src/main/pi/session-agent-tasks'
import { assertSessionControlAvailable, reserveSessionControl } from '../src/main/pi/session-control-lock'

const trackers: SessionTaskTracker[] = []
afterEach(() => { for (const tracker of trackers.splice(0)) tracker.dispose() })

function fakeAgent() {
  const entries: SessionEntry[] = []
  const listeners = new Set<(event: AgentSessionEvent) => void>()
  const abort = mock(async () => {})
  // The tracker consumes only these members; accidentally starting a real session is impossible.
  const agent = {
    sessionManager: { getEntries: () => entries },
    subscribe: (listener: (event: AgentSessionEvent) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    abort,
  } as unknown as AgentSession
  return { agent, entries, listeners, abort, emit: (event: AgentSessionEvent) => {
    for (const listener of listeners) listener(event)
  } }
}

function assistant(text: string, stopReason = 'stop', input = 10, output = 6, cost = 0.25): SessionEntry {
  return {
    type: 'message', id: crypto.randomUUID(), parentId: null, timestamp: new Date().toISOString(),
    message: {
      role: 'assistant', content: [{ type: 'text', text }], api: 'openai-responses',
      provider: 'fake', model: 'fake', timestamp: 1, stopReason,
      usage: {
        input, output, cacheRead: 2, cacheWrite: 1,
        // Reasoning is already included in output, and provider totals are not an extra bucket.
        reasoning: 4, totalTokens: input + output + 3,
        cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
      },
    },
  } as SessionEntry
}

function child(id: string, usage?: TurnUsage, cost = 0): SubagentInfo {
  return {
    id, parentSessionId: 'target', toolCallId: id, title: id, prompt: '', background: true,
    status: 'running', createdAt: 1, turns: usage?.calls ?? 0, maxTurns: 0,
    turnTools: [], toolCounts: {}, editedFiles: [], usage, cost,
  }
}

function fixture(initialChildren: SubagentInfo[] = [], history: SessionEntry[] = []) {
  const fake = fakeAgent()
  fake.entries.push(...history)
  const state = { current: fake.agent as AgentSession | undefined, children: initialChildren, pending: false, busy: true, approval: false }
  const lease = reserveSessionControl('target')
  const release = mock(lease.release)
  const tracker = new SessionTaskTracker({
    current: () => state.current, children: () => state.children,
    pendingChildren: () => state.pending, busy: () => state.busy,
    waitingApproval: () => state.approval,
  })
  trackers.push(tracker)
  const taskId = tracker.start('caller', 'target', fake.agent, release)
  return { ...fake, tracker, taskId, state, release,
    status: () => tracker.status('caller', taskId),
    wait: (timeout = 1000, signal?: AbortSignal) => tracker.wait('caller', taskId, timeout, signal),
    settle: (aborted = false) => {
      state.busy = false
      fake.emit({ type: 'agent_settled', aborted })
    },
  }
}

async function stillRunning(f: ReturnType<typeof fixture>) {
  const result = await f.wait(80)
  expect(result.timedOut).toBe(true)
  expect(result.task.status).toBe('running')
  expect(f.release).not.toHaveBeenCalled()
  expect(() => assertSessionControlAvailable('target')).toThrow()
}

test('wait returns an approval blocker immediately without ending the task or releasing its lease', async () => {
  const f = fixture()
  f.state.approval = true
  const result = await f.wait(120000)
  expect(result.timedOut).toBe(false)
  expect(result.task.status).toBe('running')
  expect(result.task.blockedBy).toBe('approval')
  expect(f.release).not.toHaveBeenCalled()
  f.state.approval = false
  expect(f.status().blockedBy).toBeUndefined()
  f.tracker.submitted(f.taskId, Promise.resolve())
  f.entries.push(assistant('approved'))
  f.settle()
  expect((await f.wait()).task.status).toBe('completed')
})

test('first parent settle waits through child execution, final write and pending report; report continuation finishes the task', async () => {
  const f = fixture()
  f.tracker.submitted(f.taskId, Promise.resolve())
  f.entries.push(assistant('delegated'))
  f.state.children = [child('background')]
  f.state.pending = true
  f.settle()
  await stillRunning(f)

  f.state.children[0]!.status = 'completed'
  // Child completion alone does not mean its final index write/report has been delivered.
  await stillRunning(f)
  f.state.children[0]!.usage = { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, total: 5, calls: 1 }
  f.state.children[0]!.turns = 1
  f.state.children[0]!.cost = 0.1
  await stillRunning(f)

  f.state.pending = false
  f.state.busy = true
  f.emit({ type: 'agent_start' })
  await stillRunning(f)
  f.entries.push(assistant('final report'))
  f.settle()
  const result = await f.wait()
  expect(result.timedOut).toBe(false)
  expect(result.task).toMatchObject({ status: 'completed', reply: 'final report', children: 1, usageIncomplete: true })
  expect(f.release).toHaveBeenCalledTimes(1)
  expect(f.listeners.size).toBe(0)
  expect(() => assertSessionControlAvailable('target')).not.toThrow()
})

test('wait timeout and cancellation leave the target running and its lease held', async () => {
  const f = fixture()
  f.tracker.submitted(f.taskId, Promise.resolve())
  await stillRunning(f)
  const controller = new AbortController()
  const reason = new Error('caller stopped waiting')
  const waiting = f.wait(1000, controller.signal)
  controller.abort(reason)
  await expect(waiting).rejects.toBe(reason)
  expect(f.status().status).toBe('running')
  expect(f.abort).not.toHaveBeenCalled()
  expect(f.release).not.toHaveBeenCalled()
  expect(() => assertSessionControlAvailable('target')).toThrow()
  f.entries.push(assistant('completed independently'))
  f.settle()
  expect((await f.wait()).task.status).toBe('completed')
  expect(f.abort).not.toHaveBeenCalled()
})

for (const reason of ['error', 'aborted', 'length']) {
  test(`parent stopReason=${reason} is not a successful task`, async () => {
    const f = fixture()
    f.tracker.submitted(f.taskId, Promise.resolve())
    f.entries.push(assistant('partial', reason))
    f.settle(reason === 'aborted')
    const { task } = await f.wait()
    expect(task.status).toBe(reason === 'aborted' ? 'aborted' : 'failed')
    if (reason !== 'aborted') expect(task.error).toContain(reason)
    expect(f.release).toHaveBeenCalledTimes(1)
  })
}

test('stopping waits for preflight and classifies cancellation without a settle event', async () => {
  const f = fixture()
  f.state.busy = false
  const blocked = Promise.withResolvers<void>()
  const work = blocked.promise.then(() => f.tracker.assertSubmissionActive(f.taskId))
  f.tracker.submitted(f.taskId, work)
  let stopped = false
  const stopping = f.tracker.markStopping('target').then(() => { stopped = true })
  await stillRunning(f)
  expect(stopped).toBe(false)
  expect(() => f.tracker.assertSubmissionActive(f.taskId)).toThrow(DOMException)
  blocked.resolve()
  await stopping
  expect((await f.wait()).task.status).toBe('aborted')
  expect(f.release).toHaveBeenCalledTimes(1)
})

test('stopping does not swallow an unexpected preflight failure', async () => {
  const f = fixture()
  f.state.busy = false
  const blocked = Promise.withResolvers<void>()
  f.tracker.submitted(f.taskId, blocked.promise)
  const stopping = f.tracker.markStopping('target')
  const failed = new Error('input hook failed')
  blocked.reject(failed)
  await expect(stopping).rejects.toBe(failed)
})

test('rejected submission cannot be masked by a successful assistant reply', async () => {
  const f = fixture()
  f.tracker.submitted(f.taskId, Promise.reject(new Error('prompt failed')))
  f.entries.push(assistant('not proof of success'))
  f.settle()
  expect((await f.wait()).task).toMatchObject({ status: 'failed', error: 'prompt failed' })
})

test('settled aborted event wins even if the last message says stop', async () => {
  const f = fixture()
  f.tracker.submitted(f.taskId, Promise.resolve())
  f.entries.push(assistant('last reply'))
  f.settle(true)
  expect((await f.wait()).task.status).toBe('aborted')
})

for (const replacement of ['closed', 'replaced'] as const) {
  test(`target ${replacement} aborts the task and releases the lease even with pending work`, async () => {
    const f = fixture()
    f.tracker.submitted(f.taskId, new Promise<void>(() => {}))
    f.state.pending = true
    f.state.current = replacement === 'closed' ? undefined : fakeAgent().agent
    const { task } = await f.wait()
    expect(task.status).toBe('aborted')
    expect(task.error).toContain('closed or replaced')
    expect(f.release).toHaveBeenCalledTimes(1)
    expect(f.listeners.size).toBe(0)
    expect(() => assertSessionControlAvailable('target')).not.toThrow()
    const next = reserveSessionControl('target')
    next.release()
  })
}

test('usage sums parent calls and child deltas without historical baseline or double-counted reasoning', async () => {
  const baseline = { input: 100, output: 60, cacheRead: 20, cacheWrite: 10, total: 190, calls: 4 }
  const historical = child('historical', baseline, 10)
  const resumed = child('resumed', { ...baseline }, 10)
  const f = fixture([historical, resumed], [assistant('historical parent', 'stop', 1000, 600, 100)])
  f.tracker.submitted(f.taskId, Promise.resolve())
  f.entries.push(assistant('first', 'stop', 10, 6), assistant('second', 'stop', 20, 8))
  // Update in place to prove the baseline is a snapshot, not a live usage reference.
  Object.assign(resumed.usage!, { input: 105, output: 63, cacheRead: 21, total: 199, calls: 5 })
  resumed.turns++
  resumed.cost = 10.5
  f.state.children.push(child('new', { input: 7, output: 4, cacheRead: 0, cacheWrite: 2, total: 13, calls: 1 }, 0.75))
  f.settle()
  const { task } = await f.wait()
  expect(task.usage).toEqual({ input: 42, output: 21, cacheRead: 5, cacheWrite: 4, total: 72, calls: 4 })
  expect(task.cost).toBe(1.75)
  expect(task.children).toBe(2)
  expect(task.usageIncomplete).toBe(true)
})

test('child usage preserves its model-call count rather than counting one call per child', async () => {
  const f = fixture()
  f.tracker.submitted(f.taskId, Promise.resolve())
  f.entries.push(assistant('parent'))
  f.state.children.push(child('multi-turn', {
    input: 20, output: 12, cacheRead: 4, cacheWrite: 2, total: 38, calls: 2,
  }, 0.5))
  f.settle()
  const { task } = await f.wait()
  expect(task.usage).toEqual({ input: 30, output: 18, cacheRead: 6, cacheWrite: 3, total: 57, calls: 3 })
})

test('task status and wait are caller-scoped and status returns a detached snapshot', async () => {
  const f = fixture()
  f.tracker.submitted(f.taskId, Promise.resolve())
  expect(() => f.tracker.status('intruder', f.taskId)).toThrow('belongs to this session')
  await expect(f.tracker.wait('intruder', f.taskId, 1)).rejects.toThrow('belongs to this session')
  expect(() => f.tracker.status('caller', 'missing')).toThrow('belongs to this session')
  const snapshot = f.status()
  snapshot.status = 'completed'
  snapshot.reply = 'tampered'
  expect(f.status()).toMatchObject({ status: 'running', reply: '' })
  f.entries.push(assistant('real reply'))
  f.settle()
  expect((await f.wait()).task.status).toBe('completed')
  expect(() => f.tracker.status('intruder', f.taskId)).toThrow('belongs to this session')
  await expect(f.tracker.wait('intruder', f.taskId, 1)).rejects.toThrow('belongs to this session')
})
