import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { PiMessage, PiSessionEvent } from '../src/renderer/src/pi/types'
import type { SessionControls } from '../src/shared/api'
import { groupTurns } from '../src/renderer/src/chat/turns'

async function runFixture(name: string): Promise<void> {
  let nextId = 0
  let listener: ((event: unknown) => void) | undefined
  let branchListener: ((sessionId: string, leafId: string | null) => void) | undefined
  const frames = new Map<number, FrameRequestCallback>()
  const timers = new Map<number, () => void>()
  const api = {
    createSession: async () => ({ sessionId: 'session', cwd: '/project' }),
    promoteSession: async () => {},
    discardDraftSession: async () => {},
    closeSession: async () => {},
    selectOpenProjectWorkspace: async () => {},
    getControls: async (): Promise<SessionControls> => ({
      model: null, thinkingLevel: 'off', thinkingLevels: ['off'],
      contextUsage: null,
      followUpMessages: [], steeringMessages: []
    }),
    getDisplayTurns: async () => ({ leafId: null, turns: [] }),
    viewBranch: async (_sessionId: string, tipId: string) => ({ leafId: tipId, turns: [], startIndex: 0, totalTurns: 0 }),
    onEvent: (callback: (event: unknown) => void) => {
      listener = callback
      return () => { listener = undefined }
    },
    onSessionBranchChanged: (callback: (sessionId: string, leafId: string | null) => void) => {
      branchListener = callback
      return () => { branchListener = undefined }
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
  const drainTimers = () => {
    const callbacks = [...timers.values()]
    timers.clear()
    for (const callback of callbacks) callback()
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
      assert.deepEqual(runtime().liveMessages, [
        { ...assistant('complete'), streamEvent: { type: 'done' } }, tool('first'), tool('second')
      ])
    } else if (name === 'thinking-segments') {
      let clock = 0
      Object.defineProperty(performance, 'now', { value: () => clock })
      const snapshot = (content: Extract<PiMessage, { role: 'assistant' }>['content']) => ({
        ...assistant(''), content
      }) as Extract<PiMessage, { role: 'assistant' }>
      const first = snapshot([{ type: 'thinking', thinking: 'first thought' }])
      const second = snapshot([...first.content, { type: 'thinking', thinking: 'second thought' }])
      const turn = () => groupTurns(runtime().liveMessages, runtime().isStreaming, runtime().thinkingDurations)[0]
      const update = (type: string, contentIndex: number, message: PiMessage) => {
        emit({ type: 'message_update', message, assistantMessageEvent: { type, contentIndex } })
        flush()
      }
      emit({ type: 'agent_start' })
      emit({ type: 'message_start', message: snapshot([]) })
      update('thinking_delta', 0, first)
      assert.equal(turn().waitingForModel, false)
      assert.deepEqual(turn().process.map((item) => item.kind), ['thinking'])
      clock = 100
      update('thinking_end', 0, first)
      assert.equal(turn().waitingForModel, true)
      assert.equal(runtime().thinkingDurations['100:0'], 100)
      clock = 500
      update('thinking_start', 1, snapshot([...first.content, { type: 'thinking', thinking: '' }]))
      assert.equal(turn().waitingForModel, true)
      update('thinking_delta', 1, second)
      assert.equal(turn().waitingForModel, false)
      assert.equal(turn().process.length, 1)
      assert.equal(turn().process.some((item) => item.kind === 'thinking' && item.live), true)
      clock = 600
      update('thinking_end', 1, second)
      assert.equal(turn().waitingForModel, true)
      assert.equal(runtime().thinkingDurations['100:1'], 100)
      assert.deepEqual(turn().process, [{
        kind: 'thinking', text: 'first thought\n\nsecond thought', durationMs: 200, live: false
      }])
      emit({ type: 'message_end', message: second })
      assert.equal(turn().waitingForModel, false)
      assert.equal(turn().process.some((item) => item.kind === 'thinking' && item.live), false)
      assert.equal(first.streamEvent, undefined)
      assert.equal(second.streamEvent, undefined)
      emit({ type: 'agent_settled' })
      assert.equal(turn().streaming, false)
    } else if (name === 'nested-tools') {
      const parent = 'parent/with/slash'
      const calls = { ...assistant(''), content: [{ type: 'toolCall', id: parent, name: 'codemode', arguments: { code: 'return tools.read(...)' } }] } as PiMessage
      emit({ type: 'agent_start' })
      emit({ type: 'message_start', message: calls })
      emit({ type: 'tool_execution_start', toolCallId: `${parent}/1`, parentToolCallId: parent, toolName: 'read', args: { path: 'a' } })
      emit({ type: 'tool_execution_start', toolCallId: `${parent}/1/1`, parentToolCallId: `${parent}/1`, toolName: 'other', args: { n: 2 } })
      emit({ type: 'tool_execution_update', toolCallId: parent, partialResult: { content: [{ type: 'text', text: 'parent progress' }] } })
      emit({ type: 'tool_execution_update', toolCallId: `${parent}/1`, parentToolCallId: parent, partialResult: { content: [{ type: 'text', text: 'must not be a child result body' }] } })
      flush()
      assert.deepEqual(runtime().liveMessages, [calls])
      assert.deepEqual(Object.keys(runtime().toolUpdates), [parent])
      assert.equal(runtime().toolUpdates[parent].nestedCalls?.calls.length, 2)
      assert.equal(runtime().toolUpdates[parent].nestedCalls?.calls[0].status, 'running')
      emit({ type: 'tool_execution_end', toolCallId: `${parent}/1`, parentToolCallId: parent, toolName: 'read', durationMs: 30, isError: true, result: { content: [{ type: 'text', text: 'missing file' }] } })
      flush()
      assert.deepEqual(runtime().toolUpdates[parent].nestedCalls?.calls[0], { id: `${parent}/1`, name: 'read', arguments: { path: 'a' }, status: 'error', durationMs: 30, error: 'missing file' })
      const final = { ...tool(parent), toolName: 'codemode', nestedCalls: { calls: [{ id: `${parent}/1`, name: 'read', arguments: { path: 'a' }, status: 'error' as const, durationMs: 30, error: 'missing file' }], complete: true } }
      emit({ type: 'message_start', message: final })
      emit({ type: 'message_end', message: final })
      flush()
      assert.deepEqual(runtime().toolUpdates, {})
      const step = groupTurns(runtime().liveMessages, true)[0].process.flatMap((item) => item.kind === 'tools' ? item.tools : [])[0]
      assert.deepEqual(step.result?.nestedCalls, final.nestedCalls)
      emit({ type: 'tool_execution_end', toolCallId: `${parent}/1/1`, parentToolCallId: `${parent}/1`, toolName: 'other', isError: false })
      flush()
      assert.deepEqual(runtime().toolUpdates, {}, 'late descendants must not replace persisted parent metadata')
    } else if (name === 'tools') {
      const partial = (text: string) => ({
        content: [{ type: 'text' as const, text }], details: { progress: text }
      })
      const calls = {
        ...assistant(''),
        content: ['first', 'second'].map((id) => ({
          type: 'toolCall', id, name: 'read', arguments: { path: id }
        }))
      } as PiMessage
      const steps = () => groupTurns(runtime().liveMessages, runtime().isStreaming, {}, runtime().toolUpdates)[0]
        .process.flatMap((item) => item.kind === 'tools' ? item.tools : [])
      emit({ type: 'agent_start' })
      emit({ type: 'message_start', message: calls })
      let updates = 0
      const off = store.subscribe((state, previous) => {
        if (state.runtime.session.toolUpdates !== previous.runtime.session.toolUpdates) updates++
      })
      for (let i = 1; i <= 100; i++) {
        emit({ type: 'tool_execution_update', toolCallId: 'first', partialResult: partial(String(i)) })
        emit({ type: 'tool_execution_update', toolCallId: 'second', partialResult: partial(`second ${i}`) })
      }
      assert.equal(frames.size, 1)
      assert.equal(updates, 0)
      flush()
      assert.equal(updates, 1)
      off()
      assert.deepEqual(runtime().toolUpdates, { first: partial('100'), second: partial('second 100') })
      assert.deepEqual(runtime().liveMessages, [calls])
      assert.deepEqual(steps().map((step) => step.partialResult), [partial('100'), partial('second 100')])
      assert.ok(steps().every((step) => !step.result))

      emit({ type: 'tool_execution_update', toolCallId: 'first', partialResult: partial('stale first') })
      emit({ type: 'tool_execution_update', toolCallId: 'second', partialResult: partial('second 101') })
      emit({ type: 'message_start', message: tool('first') })
      emit({ type: 'message_end', message: tool('first') })
      assert.equal(runtime().toolUpdates.first, undefined)
      assert.equal(frames.size, 1)
      flush()
      assert.deepEqual(runtime().toolUpdates, { second: partial('second 101') })
      assert.deepEqual(steps()[0].result, tool('first'))
      assert.equal(steps()[0].partialResult, undefined)
      assert.deepEqual(steps()[1].partialResult, partial('second 101'))

      emit({ type: 'tool_execution_update', toolCallId: 'second', partialResult: partial('stale second') })
      emit({ type: 'message_end', message: { ...tool('second'), isError: true } as PiMessage })
      assert.deepEqual(runtime().toolUpdates, {})
      assert.equal(frames.size, 0)
      flush()
      assert.equal(runtime().liveMessages.length, 3)
      assert.ok(steps()[1].result?.isError)
      assert.equal(steps()[1].partialResult, undefined)

      emit({ type: 'tool_execution_update', toolCallId: 'unfinished', partialResult: partial('last output') })
      flush()
      assert.deepEqual(runtime().toolUpdates.unfinished, partial('last output'))
      emit({ type: 'tool_execution_update', toolCallId: 'unfinished', partialResult: partial('queued output') })
      emit({ type: 'agent_settled' })
      assert.deepEqual(runtime().toolUpdates, {})
      assert.equal(frames.size, 0)
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
            turns: [{ id: 'bash-row', bash: { command: 'echo ready', exitCode: 0, cancelled: false }, answer: [], compactions: [], workBlocks: [false], startedAt: 1, endedAt: 2, hasProcess: true }]
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
      emit({ type: 'tool_execution_update', toolCallId: 'old-tool', partialResult: { content: [{ type: 'text', text: 'old output' }] } })
      assert.equal(frames.size, 1)
      store.getState().closeTab('session')
      assert.equal(frames.size, 0)
      emit({ type: 'agent_start' })
      assert.equal(runtime(), undefined)
      await store.getState().newSession('/project')
      flush()
      assert.deepEqual(runtime().liveMessages, [])
      assert.deepEqual(runtime().toolUpdates, {})
      assert.equal(runtime().bashExecution, null)
    } else if (name === 'cleanup') {
      emit({ type: 'agent_settled' })
      assert.equal(timers.size, 1)
      emit({ type: 'message_start', message: assistant('') })
      emit({ type: 'message_update', message: assistant('pending') })
      emit({ type: 'tool_execution_update', toolCallId: 'tool', partialResult: { content: [{ type: 'text', text: 'pending' }] } })
      emit({ type: 'bash_execution_update', id: 'bash', delta: 'pending' })
      assert.equal(frames.size, 1)
      unsubscribe()
      assert.equal(listener, undefined)
      assert.equal(timers.size, 0)
      assert.equal(frames.size, 0)
    } else if (name === 'command-rollback') {
      const pending = { role: 'user' as const, content: '/end-review', timestamp: 300 }
      const revision = runtime().agentRunRevision
      store.getState().beginPrompt('session', pending)
      emit({ type: 'agent_start' })
      const status: PiMessage = { role: 'custom', customType: 'repair', content: 'Repair started', display: true, timestamp: 301 }
      emit({ type: 'message_start', message: status })
      emit({ type: 'tool_execution_update', toolCallId: 'repair-tool', partialResult: { content: [{ type: 'text', text: 'progress' }] } })
      flush()
      emit({ type: 'agent_end', messages: [], willRetry: false })
      emit({ type: 'compaction_start', reason: 'threshold' })
      emit({ type: 'summarization_retry_scheduled', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: 'summary retry' })
      const active = runtime()
      store.getState().rollbackPrompt('session', pending, revision)
      assert.equal(runtime().isStreaming, true)
      assert.equal(runtime().streamStartedAt, active.streamStartedAt)
      assert.equal(runtime().streamElapsedMs, null)
      assert.equal(runtime().toolUpdates, active.toolUpdates)
      const turns = groupTurns(runtime().liveMessages, true, {}, runtime().toolUpdates, runtime().liveCompactions)
      assert.deepEqual(turns[0].process.map((item) => item.kind), ['custom', 'compaction'])
      assert.equal(runtime().retryNotice, active.retryNotice)
      assert.equal(turns[0].user, undefined, 'an extension command is not shown as a user message')
      assert.equal(runtime().pendingUserMessage, false)
      emit({ type: 'message_start', message: { role: 'user', content: 'Implement findings', timestamp: 302 } })
      assert.equal(runtime().isStreaming, true)
      emit({ type: 'agent_settled' })
      assert.equal(runtime().isStreaming, false)
      const newer = { role: 'user' as const, content: 'next submission', timestamp: 400 }
      const nextRevision = runtime().agentRunRevision
      store.getState().beginPrompt('session', newer)
      const next = runtime()
      store.getState().rollbackPrompt('session', pending, revision)
      assert.equal(runtime(), next, 'old cleanup cannot remove another submission')
      store.getState().rollbackPrompt('session', newer, nextRevision)
      assert.equal(runtime().isStreaming, false)
      assert.equal(runtime().pendingUserMessage, false)
    } else if (name === 'unaccepted-end') {
      const pending = { role: 'user' as const, content: 'pending', timestamp: 300 }
      const revision = runtime().agentRunRevision
      store.getState().beginPrompt('session', pending)
      emit({ type: 'agent_start' })
      emit({ type: 'agent_end', messages: [], willRetry: false })
      assert.equal(runtime().isStreaming, true)
      emit({ type: 'agent_settled' })
      assert.equal(runtime().isStreaming, false)
      assert.equal(runtime().pendingUserMessage, true)
      const elapsed = runtime().streamElapsedMs
      store.getState().rollbackPrompt('session', pending, revision)
      assert.deepEqual(runtime().liveMessages, [])
      assert.equal(runtime().streamElapsedMs, elapsed)
    } else if (name === 'turn-end-controls') {
      let controlReads = 0
      api.getControls = async () => {
        controlReads++
        return {
          model: null, thinkingLevel: 'off', thinkingLevels: ['off'],
          contextUsage: { tokens: controlReads * 100, contextWindow: 1000, percent: controlReads * 10 },
          followUpMessages: [], steeringMessages: []
        }
      }
      emit({ type: 'agent_start' })
      emit({ type: 'turn_end', message: assistant('loop one'), toolResults: [] })
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.equal(runtime().contextUsage?.tokens, 100)
      emit({ type: 'turn_end', message: assistant('final answer'), toolResults: [] })
      emit({ type: 'agent_end', messages: [], willRetry: false })
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.equal(runtime().contextUsage?.tokens, 200)
      assert.equal(controlReads, 2)
      assert.equal(runtime().isStreaming, true)
      assert.equal(timers.size, 0)
      emit({ type: 'agent_settled' })
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.equal(runtime().contextUsage?.tokens, 300)
      assert.equal(controlReads, 3)
      assert.equal(runtime().isStreaming, false)
      assert.equal(timers.size, 1)
    } else if (name === 'retry-settlement') {
      let reads = 0
      let controlReads = 0
      api.getDisplayTurns = async () => {
        reads++
        return { leafId: null, turns: [] }
      }
      api.getControls = async () => {
        controlReads++
        return {
          model: null, thinkingLevel: 'off', thinkingLevels: ['off'],
          contextUsage: null, followUpMessages: [], steeringMessages: []
        }
      }
      emit({ type: 'queue_update', followUp: ['之后再做'], steering: ['先停一下方向'] })
      assert.deepEqual(runtime().followUpMessages, ['之后再做'])
      assert.deepEqual(runtime().steeringMessages, ['先停一下方向'])
      emit({ type: 'queue_update', followUp: ['之后再做'], steering: [] })
      assert.deepEqual(runtime().steeringMessages, [])
      emit({ type: 'agent_start' })
      const startedAt = Date.now() - 2_500
      store.setState((state) => ({
        runtime: { ...state.runtime, session: { ...state.runtime.session, streamStartedAt: startedAt } }
      }))
      emit({ type: 'message_start', message: assistant('') })
      emit({ type: 'message_update', message: assistant('failed attempt') })
      emit({ type: 'agent_end', messages: [assistant('failed attempt')], willRetry: true })
      assert.deepEqual(runtime().liveMessages, [assistant('failed attempt')])
      assert.equal(frames.size, 0)
      assert.equal(runtime().isStreaming, true)
      assert.equal(runtime().streamStartedAt, startedAt)
      assert.equal(runtime().streamElapsedMs, null)
      assert.equal(timers.size, 0)
      emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: 'network error' })
      const notice = runtime().retryNotice
      assert.equal(notice?.kind, 'request')
      assert.equal(notice?.attempt, 1)
      assert.equal(notice?.maxAttempts, 3)
      assert.equal(notice?.errorMessage, 'network error')
      assert.ok((notice?.endsAt ?? 0) > Date.now(), 'the notice counts down towards the retry')
      drainTimers()
      assert.deepEqual({ reads, controlReads }, { reads: 0, controlReads: 0 })
      emit({ type: 'agent_start' })
      assert.equal(runtime().streamStartedAt, startedAt)
      const answer = { ...assistant('final answer'), timestamp: 300 }
      emit({ type: 'message_start', message: answer })
      emit({ type: 'message_end', message: answer })
      emit({ type: 'auto_retry_end', success: true, attempt: 1 })
      assert.equal(runtime().retryNotice, null)
      emit({ type: 'agent_end', messages: [answer], willRetry: false })
      assert.equal(runtime().isStreaming, true)
      assert.equal(timers.size, 0)
      emit({ type: 'agent_settled' })
      assert.equal(runtime().isStreaming, false)
      assert.equal(runtime().streamStartedAt, null)
      assert.ok((runtime().streamElapsedMs ?? 0) >= 2_500)
      assert.equal(timers.size, 1)
      assert.deepEqual({ reads, controlReads }, { reads: 0, controlReads: 1 })
      drainTimers()
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.deepEqual({ reads, controlReads }, { reads: 1, controlReads: 1 })
    } else if (name === 'retry-notice') {
      const scheduled = { type: 'summarization_retry_scheduled', attempt: 2, maxAttempts: 3, delayMs: 4_000, errorMessage: 'summary exploded' } as PiSessionEvent
      // A payload that cannot describe a retry is not one to invent a notice from.
      emit({ type: 'auto_retry_start', attempt: 1 } as PiSessionEvent)
      assert.equal(runtime().retryNotice, null)
      emit(scheduled)
      const notice = runtime().retryNotice
      assert.equal(notice?.kind, 'summary')
      const noticeOf = () => {
        const current = runtime().retryNotice
        return current?.kind === 'summary' ? current : null
      }
      assert.equal(noticeOf()?.source, 'summary')
      assert.deepEqual(
        { attempt: notice?.attempt, maxAttempts: notice?.maxAttempts, errorMessage: notice?.errorMessage },
        { attempt: 2, maxAttempts: 3, errorMessage: 'summary exploded' }
      )
      assert.ok((notice?.endsAt ?? 0) > Date.now())
      // The attempt itself carries no budget: it sharpens the scheduled notice and starts the clock.
      emit({ type: 'summarization_retry_attempt_start', source: 'compaction', reason: 'manual' })
      assert.equal(noticeOf()?.source, 'compaction')
      assert.equal(noticeOf()?.attempt, 2)
      assert.ok((noticeOf()?.endsAt ?? 0) <= Date.now(), 'a running attempt has no countdown')
      emit({ type: 'summarization_retry_finished' })
      assert.equal(runtime().retryNotice, null)
      emit({ type: 'summarization_retry_attempt_start', source: 'branchSummary' })
      assert.equal(runtime().retryNotice, null, 'an attempt nobody scheduled stays unannounced')
      emit(scheduled)
      emit({ type: 'summarization_retry_attempt_start', source: 'branchSummary' })
      assert.equal(noticeOf()?.source, 'branchSummary')
      // Settlement, a new prompt and an extension branch change all end the session activity the
      // notice describes, so none of them may leave it behind.
      emit({ type: 'agent_settled' })
      assert.equal(runtime().retryNotice, null)
      emit(scheduled)
      store.getState().beginPrompt('session', { role: 'user', content: 'next', timestamp: 400 })
      assert.equal(runtime().retryNotice, null)
      emit(scheduled)
      branchListener?.('session', 'leaf-1')
      assert.equal(runtime().retryNotice, null)
      await new Promise((resolve) => setTimeout(resolve, 0))
    } else if (name === 'compaction') {
      let reads = 0
      let controlReads = 0
      api.getDisplayTurns = async () => {
        reads++
        return { leafId: null, turns: [] }
      }
      api.getControls = async () => {
        controlReads++
        return {
          model: null, thinkingLevel: 'off', thinkingLevels: ['off'],
          contextUsage: null, followUpMessages: [], steeringMessages: []
        }
      }
      // A failed or cancelled compaction wrote no entry, so there is nothing to re-read.
      emit({ type: 'compaction_end', reason: 'manual', result: undefined, aborted: false, willRetry: false } as PiSessionEvent)
      emit({ type: 'compaction_end', reason: 'manual', result: { tokensBefore: 1 }, aborted: true, willRetry: false } as PiSessionEvent)
      assert.equal(reads, 0)
      emit({ type: 'agent_start' })
      emit({ type: 'compaction_end', reason: 'threshold', result: { tokensBefore: 1 }, aborted: false, willRetry: false } as PiSessionEvent)
      assert.deepEqual({ reads, controlReads }, { reads: 0, controlReads: 0 })
      emit({ type: 'turn_end' })
      emit({ type: 'agent_end', messages: [], willRetry: false })
      assert.deepEqual({ reads, controlReads }, { reads: 0, controlReads: 1 })
      emit({ type: 'compaction_end', reason: 'threshold', result: { tokensBefore: 1 }, aborted: false, willRetry: false } as PiSessionEvent)
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.deepEqual({ reads, controlReads }, { reads: 0, controlReads: 1 })
      assert.equal(runtime().isStreaming, true)
      assert.equal(timers.size, 0)
      emit({ type: 'agent_settled' })
      drainTimers()
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.deepEqual({ reads, controlReads }, { reads: 1, controlReads: 2 })
      emit({ type: 'agent_start' })
      emit({ type: 'turn_end' })
      emit({ type: 'agent_end', messages: [], willRetry: true })
      emit({ type: 'compaction_end', reason: 'overflow', result: { tokensBefore: 1 }, aborted: false, willRetry: true } as PiSessionEvent)
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.deepEqual({ reads, controlReads }, { reads: 1, controlReads: 3 })
      assert.equal(runtime().isStreaming, true)
      assert.equal(timers.size, 0)
      emit({ type: 'agent_start' })
      emit({ type: 'turn_end' })
      emit({ type: 'agent_end', messages: [], willRetry: false })
      emit({ type: 'agent_settled' })
      assert.equal(timers.size, 1)
      drainTimers()
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.deepEqual({ reads, controlReads }, { reads: 2, controlReads: 5 })
      emit({ type: 'compaction_end', reason: 'manual', result: { tokensBefore: 1 }, aborted: false, willRetry: false } as PiSessionEvent)
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.deepEqual({ reads, controlReads }, { reads: 3, controlReads: 6 })
    } else if (name === 'compaction-marks') {
      // The runtime is plain data: place the prompt in the past instead of waiting for the clock.
      const backdate = (startedAt: number) =>
        store.setState((state) => ({
          runtime: {
            ...state.runtime,
            session: { ...state.runtime.session, isStreaming: true, streamStartedAt: startedAt }
          }
        }))
      // A compaction between the work and the summary: the work clock freezes where it had got to.
      backdate(Date.now() - 5_000)
      emit({ type: 'compaction_start', reason: 'threshold' } as PiSessionEvent)
      const mark = () => runtime().liveCompactions[0]
      assert.equal(runtime().liveCompactions.length, 1)
      assert.equal(mark().status, 'running')
      assert.equal(mark().reason, 'threshold')
      assert.equal(mark().endedAt, null)
      assert.ok(mark().workMsBefore >= 4_900, `froze the work clock at ${mark().workMsBefore}`)
      emit({
        type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false,
        result: { summary: 'summarized', tokensBefore: 42 }
      } as PiSessionEvent)
      assert.equal(mark().status, 'done')
      assert.equal(mark().summary, 'summarized')
      assert.equal(mark().tokensBefore, 42)
      assert.ok(mark().endedAt != null)
      // The next block of work counts on from there, with the summary's own time left out of it.
      const written = runtime().liveCompactions[0]
      emit({ type: 'compaction_start', reason: 'manual' } as PiSessionEvent)
      assert.ok(runtime().liveCompactions[1].workMsBefore >= written.workMsBefore)
      assert.ok(runtime().liveCompactions[1].workMsBefore < written.workMsBefore + 200)
      // A summary is an entry, so once history carries it the mark has nothing left to report —
      // while the compaction that is still running has nothing to be replaced by.
      emit({ type: 'agent_settled' })
      drainTimers()
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.deepEqual(runtime().liveCompactions.map((item) => item.status), ['running'])
      assert.equal(runtime().liveCompactions[0].reason, 'manual')
      emit({ type: 'compaction_end', reason: 'manual', aborted: true, willRetry: false } as PiSessionEvent)
      assert.deepEqual(runtime().liveCompactions, [])
      // One that failed never becomes an entry: it stays until the reader dismisses it.
      store.getState().beginPrompt('session', { role: 'user', content: 'again', timestamp: 400 })
      backdate(Date.now() - 1_000)
      emit({ type: 'compaction_start', reason: 'overflow' } as PiSessionEvent)
      emit({
        type: 'compaction_end', reason: 'overflow', aborted: false, willRetry: false,
        errorMessage: 'Context overflow recovery failed: boom'
      } as PiSessionEvent)
      assert.equal(mark().status, 'failed')
      assert.equal(mark().errorMessage, 'Context overflow recovery failed: boom')
      store.getState().setStreaming('session', false)
      await store.getState().hydrateTurns('session', { keepOlderTurns: true })
      assert.equal(runtime().liveCompactions.length, 1, 'a failure is not history and must not vanish')
      const failedId = mark().id
      store.getState().dropCompaction('session', failedId)
      assert.deepEqual(runtime().liveCompactions, [])
      // A cancelled summary leaves no landmark and nothing to report.
      store.getState().beginPrompt('session', { role: 'user', content: 'third', timestamp: 401 })
      emit({ type: 'compaction_start', reason: 'manual' } as PiSessionEvent)
      emit({ type: 'compaction_end', reason: 'manual', aborted: true, willRetry: false } as PiSessionEvent)
      assert.deepEqual(runtime().liveCompactions, [])
      // Between runs there is no settlement event to wait for, so the summary is read right away.
      store.getState().setStreaming('session', false)
      emit({ type: 'compaction_start', reason: 'manual' } as PiSessionEvent)
      assert.equal(mark().status, 'running')
      emit({
        type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false,
        result: { summary: 'outside the run', tokensBefore: 7 }
      } as PiSessionEvent)
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.deepEqual(runtime().liveCompactions, [])
      assert.equal(runtime().isStreaming, false)
    } else if (name === 'branch') {
      assert.equal(runtime().leafId, null)
      emit({ type: 'tool_execution_update', toolCallId: 'old-tool', partialResult: { content: [{ type: 'text', text: 'old branch' }] } })
      flush()
      assert.ok(runtime().toolUpdates['old-tool'])
      emit({ type: 'tool_execution_update', toolCallId: 'old-tool', partialResult: { content: [{ type: 'text', text: 'queued old branch' }] } })
      branchListener?.('session', 'leaf-1')
      flush()
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.equal(runtime().leafId, 'leaf-1')
      assert.deepEqual(runtime().toolUpdates, {})
      emit({ type: 'tool_execution_update', toolCallId: 'old-tool', partialResult: { content: [{ type: 'text', text: 'queued before root' }] } })
      branchListener?.('session', null)
      assert.equal(frames.size, 0)
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.equal(runtime().leafId, null)
      assert.deepEqual(runtime().toolUpdates, {})
    } else if (name === 'prompt-transition') {
      const oldUser: PiMessage = { role: 'user', content: 'old question', timestamp: 1 }
      emit({ type: 'agent_start' })
      emit({ type: 'message_start', message: oldUser })
      emit({ type: 'message_start', message: assistant('old answer') })
      emit({ type: 'agent_end', messages: [], willRetry: false })
      emit({ type: 'agent_settled' })
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
    'thinking-segments': 'thinking snapshots retain their latest stream event without mutating Pi messages',
    tools: 'tool snapshots are batched independently and final messages clear pending updates',
    'nested-tools': 'nested calls remain bounded parent metadata and replay from the SDK result, never messages',
    bash: 'command output is batched per frame and follows the active execution id',
    closed: 'queued frames and late events cannot affect a closed or reopened session',
    cleanup: 'unsubscribing cancels frames, hydration timers, and subscriptions',
    'unaccepted-end': 'agent settlement cannot acknowledge a user message that was never received',
    'command-rollback': 'command cleanup preserves newer SDK activity and removes only its own optimistic message',
    'turn-end-controls': 'turns and final settlement refresh context usage, but agent end does not',
    'retry-settlement': 'retries preserve running state and elapsed time until final settlement',
    'retry-notice': 'retry notices track the attempt Pi reports and never outlive their activity',
    'compaction-marks': 'a compaction freezes the work clock and is replaced by the entry it wrote',
    branch: 'an extension branch change rebinds the conversation to the new leaf',
    'prompt-transition': 'a new prompt preserves the previous turn until persisted history replaces it',
    compaction: 'a finished compaction re-reads its turn and refreshes the context usage'
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
