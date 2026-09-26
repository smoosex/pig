import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { PiMessage, PiSessionEvent } from '../src/renderer/src/pi/types'

async function runFixture(name: string): Promise<void> {
  let nextId = 0
  let listener: ((event: unknown) => void) | undefined
  const frames = new Map<number, FrameRequestCallback>()
  const timers = new Map<number, () => void>()
  const api = {
    createSession: async () => ({ sessionId: 'session', cwd: '/project' }),
    promoteSession: async () => {},
    discardDraftSession: async () => {},
    closeSession: async () => {},
    selectOpenProjectWorkspace: async () => {},
    getControls: async () => ({
      model: null, models: [], thinkingLevel: 'off', thinkingLevels: ['off'],
      contextUsage: null,
      followUpMessages: []
    }),
    getDisplayTurns: async () => ({ leafId: null, turns: [] }),
    onEvent: (callback: (event: unknown) => void) => {
      listener = callback
      return () => { listener = undefined }
    }
  }
  Object.assign(globalThis, {
    window: {
      api,
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        const id = ++nextId
        frames.set(id, callback)
        return id
      },
      cancelAnimationFrame: (id: number) => frames.delete(id),
      setTimeout: (callback: () => void) => {
        const id = ++nextId
        timers.set(id, callback)
        return id
      },
      clearTimeout: (id: number) => timers.delete(id)
    }
  })
  const { useSessionsStore: store } = await import('../src/renderer/src/stores/sessions')
  const { subscribeSessionEvents } = await import('../src/renderer/src/chat/session-events')
  const unsubscribe = subscribeSessionEvents()
  await store.getState().newSession('/project')
  const runtime = () => store.getState().runtime.session
  const emit = (event: PiSessionEvent) => listener?.({ sessionId: 'session', event })
  const assistant = (text: string): PiMessage => ({
    role: 'assistant', timestamp: 100, content: [{ type: 'text', text }]
  } as PiMessage)
  const tool = (id: string): PiMessage => ({
    role: 'toolResult', timestamp: 200, toolName: 'read', toolCallId: id,
    content: [{ type: 'text', text: id }], isError: false
  })
  const flush = () => {
    const callbacks = [...frames.values()]
    frames.clear()
    for (const callback of callbacks) callback(16)
  }

  try {
    if (name === 'burst') {
      emit({ type: 'message_start', message: assistant('') })
      let updates = 0
      const off = store.subscribe((state, previous) => {
        if (state.runtime.session.liveMessages !== previous.runtime.session.liveMessages) updates++
      })
      for (let i = 1; i <= 100; i++) emit({ type: 'message_update', message: assistant(String(i)) })
      assert.equal(frames.size, 1)
      assert.equal(updates, 0)
      flush()
      assert.equal(updates, 1)
      assert.deepEqual(runtime().liveMessages[0], assistant('100'))
      off()
    } else if (name === 'boundaries') {
      emit({ type: 'message_start', message: assistant('') })
      emit({ type: 'message_update', message: assistant('partial') })
      emit({ type: 'message_start', message: tool('first') })
      emit({ type: 'message_end', message: tool('first') })
      emit({ type: 'message_start', message: tool('second') })
      emit({ type: 'message_end', message: tool('second') })
      assert.deepEqual(runtime().liveMessages, [assistant('partial'), tool('first'), tool('second')])
      emit({ type: 'message_update', message: assistant('late partial') })
      emit({ type: 'message_end', message: assistant('complete') })
      flush()
      assert.deepEqual(runtime().liveMessages, [assistant('complete'), tool('first'), tool('second')])
    } else if (name === 'bash') {
      store.getState().beginBash('session', 'run-1', 'echo ready')
      let updates = 0
      const off = store.subscribe((state, previous) => {
        if (state.runtime.session.bashExecution !== previous.runtime.session.bashExecution) updates++
      })
      for (let i = 0; i < 100; i++) emit({ type: 'bash_execution_update', id: 'run-1', delta: 'x' })
      assert.equal(frames.size, 1)
      assert.equal(updates, 0)
      assert.equal(runtime().bashExecution?.message.output, '')
      flush()
      assert.equal(updates, 1)
      assert.equal(runtime().bashExecution?.message.output, 'x'.repeat(100))
      // Output of a different execution must not be reordered into the pending batch.
      emit({ type: 'bash_execution_update', id: 'old-run', delta: 'ignored' })
      emit({ type: 'bash_execution_update', id: 'run-1', delta: 'tail' })
      flush()
      assert.equal(runtime().bashExecution?.message.output, `${'x'.repeat(100)}tail`)
      off()
      store.getState().endBash('session', 'run-1')
      emit({ type: 'bash_execution_update', id: 'run-1', delta: 'late' })
      flush()
      assert.equal(runtime().bashExecution, null)

      // A hidden window stops frames, so the pending batch is tailed before it reaches the store.
      store.getState().beginBash('session', 'run-2', 'yes')
      emit({ type: 'bash_execution_update', id: 'run-2', delta: 'a'.repeat(70_000) })
      emit({ type: 'bash_execution_update', id: 'run-2', delta: 'tail' })
      flush()
      const long = runtime().bashExecution?.message.output ?? ''
      assert.equal(long.length, 64 * 1024)
      assert.ok(long.startsWith('a'))
      assert.ok(long.endsWith('tail'))
      store.getState().endBash('session', 'run-2')
      emit({ type: 'bash_execution_update', id: 'run-2', delta: 'late' })
      flush()
      assert.equal(runtime().bashExecution, null)
      store.getState().beginBash('session', 'run-2', 'echo ready')
      store.setState((state) => ({
        runtime: {
          ...state.runtime,
          session: {
            ...state.runtime.session,
            turns: [{ id: 'bash-row', bash: { command: 'echo ready', exitCode: 0, cancelled: false }, answer: [], startedAt: 1, endedAt: 2, hasProcess: true }]
          }
        }
      }))
      store.getState().endBash('session', 'run-2', { output: 'ready', exitCode: 0, cancelled: false, truncated: false }, 'bash-row')
      assert.deepEqual(runtime().turns[0].bash, { command: 'echo ready', exitCode: 0, cancelled: false })
      assert.equal(runtime().processByTurnId['bash-row'][0].kind, 'bash')
    } else if (name === 'closed') {
      emit({ type: 'message_start', message: assistant('') })
      emit({ type: 'message_update', message: assistant('old') })
      store.getState().beginBash('session', 'run-1', 'echo ready')
      emit({ type: 'bash_execution_update', id: 'run-1', delta: 'ready' })
      assert.equal(frames.size, 1)
      store.getState().closeTab('session')
      assert.equal(frames.size, 0)
      emit({ type: 'agent_start' })
      assert.equal(runtime(), undefined)
      await store.getState().newSession('/project')
      flush()
      assert.deepEqual(runtime().liveMessages, [])
      assert.equal(runtime().bashExecution, null)
    } else if (name === 'cleanup') {
      emit({ type: 'agent_end' })
      assert.equal(timers.size, 1)
      emit({ type: 'message_start', message: assistant('') })
      emit({ type: 'message_update', message: assistant('pending') })
      assert.equal(frames.size, 1)
      unsubscribe()
      assert.equal(listener, undefined)
      assert.equal(timers.size, 0)
      assert.equal(frames.size, 0)
    } else if (name === 'unaccepted-end') {
      store.getState().beginPrompt('session', { role: 'user', content: 'pending', timestamp: 300 })
      emit({ type: 'agent_start' })
      emit({ type: 'agent_end' })
      assert.equal(runtime().pendingUserMessage, true)
      store.getState().rollbackPrompt('session')
      assert.deepEqual(runtime().liveMessages, [])
    } else if (name === 'prompt-transition') {
      const oldUser: PiMessage = { role: 'user', content: 'old question', timestamp: 1 }
      emit({ type: 'agent_start' })
      emit({ type: 'message_start', message: oldUser })
      emit({ type: 'message_start', message: assistant('old answer') })
      emit({ type: 'agent_end' })
      assert.equal(timers.size, 1)
      store.getState().beginPrompt('session', { role: 'user', content: 'optimistic', timestamp: 300 })
      emit({ type: 'agent_start' })
      emit({ type: 'message_start', message: { role: 'user', content: 'accepted', timestamp: 301 } })
      assert.equal(timers.size, 0)
      assert.equal(runtime().pendingUserMessage, false)
      assert.deepEqual(runtime().liveMessages.map((message) => message.timestamp), [1, 100, 301])
    } else {
      throw new Error(`Unknown fixture: ${name}`)
    }
  } finally {
    unsubscribe()
  }
}

if (process.argv[2] === '--renderer-events-fixture') {
  await runFixture(process.argv[3])
} else {
  const cases = {
    burst: '100 token snapshots produce one state update per animation frame',
    boundaries: 'message boundaries preserve queued updates and distinct tool results',
    bash: 'command output is batched per frame and follows the active execution id',
    closed: 'queued frames and late events cannot affect a closed or reopened session',
    cleanup: 'unsubscribing cancels frames, hydration timers, and subscriptions',
    'unaccepted-end': 'agent end cannot acknowledge a user message that was never received',
    'prompt-transition': 'a new prompt preserves the previous turn until persisted history replaces it'
  }
  for (const [name, description] of Object.entries(cases)) {
    test(`renderer events: ${description}`, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--renderer-events-fixture', name], {
        stdout: 'pipe', stderr: 'pipe'
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
      ])
      assert.equal(code, 0, stdout + stderr)
    })
  }
}
