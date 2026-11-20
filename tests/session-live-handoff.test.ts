import { describe, expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import type { BrowserWindow } from 'electron'
import {
  createAssistantMessageEventStream,
  normalizeContext,
  type AssistantMessage
} from '@earendil-works/pi-ai'
import { SessionManager, type AgentSession, type AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import {
  bridgeEvents,
  getSessionLiveRun,
  noteSessionBranchChanged
} from '../src/main/pi/event-bridge'
import { displayWindow, managerSourceBeforeLeaf } from '../src/main/pi/session-source'
import type { OpenSessionRef, SessionControls, SessionMeta } from '../src/shared/api'
import type { PiMessage, PiSessionEvent } from '../src/renderer/src/pi/types'
import { groupTurns } from '../src/renderer/src/chat/turns'
import { runSelf } from './helpers/subprocess.ts'

function assistantMsg(timestamp: number, content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {
    role: 'assistant',
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp,
    content
  }
}

async function runRendererScenario(scenario: 'open-existing' | 'activate-cold' | 'settled-in-flight'): Promise<void> {
  let nextId = 0
  let listener: ((event: unknown) => void) | undefined
  const frames = new Map<number, FrameRequestCallback>()
  const timers = new Map<number, () => void>()

  const priorTurn = {
    id: 'turn-1',
    user: { text: '历史问题', textAttachments: [], images: [], timestamp: 1000 },
    answer: [{ type: 'text' as const, text: '历史回答' }],
    startedAt: 1000,
    endedAt: 2000,
    compactions: [], branchSummaries: [], workBlocks: [],
    hasProcess: false,
    replyEntryId: 'entry-a1',
    lastEntryId: 'entry-a1'
  }
  const settledTurn = {
    id: 'turn-2',
    user: { text: '后台任务指令', textAttachments: [], images: [], timestamp: 5000 },
    answer: [{ type: 'text' as const, text: '已改好并验证通过' }],
    startedAt: 5000,
    endedAt: 9000,
    compactions: [], branchSummaries: [], workBlocks: [],
    hasProcess: true,
    replyEntryId: 'entry-a2',
    lastEntryId: 'entry-a2'
  }

  const liveUser: PiMessage = {
    role: 'user',
    content: [{ type: 'text', text: '后台任务指令' }],
    timestamp: 5000
  }
  const liveToolAssistant = {
    ...assistantMsg(5100, [{ type: 'toolCall', id: 'tc-1', name: 'bash', arguments: { command: 'bun test' } }], 'toolUse'),
    streamEvent: { type: 'done' }
  } as unknown as PiMessage
  const liveToolResult: PiMessage = {
    role: 'toolResult',
    toolCallId: 'tc-1',
    toolName: 'bash',
    content: [{ type: 'text', text: 'all green' }],
    isError: false,
    timestamp: 5200
  }
  const liveStreamingAssistant = {
    ...assistantMsg(5300, [
      { type: 'thinking', thinking: '检查结果' },
      { type: 'text', text: '已改好' }
    ]),
    streamEvent: { type: 'text_delta', contentIndex: 1 }
  } as unknown as PiMessage

  const openResult: OpenSessionRef = {
    sessionId: 'bg-session',
    cwd: '/project/worktree',
    eventCursor: 10,
    display: {
      leafId: 'entry-a1',
      turns: [priorTurn],
      startIndex: 0,
      totalTurns: 1,
      summary: [{ id: 'turn-1', bytes: 120, hasImages: false }]
    },
    live: {
      isStreaming: true,
      streamStartedAt: Date.now() - 4000,
      messages: [liveUser, liveToolAssistant, liveToolResult, liveStreamingAssistant],
      toolUpdates: {},
      liveCompactions: [],
      retryNotice: null,
      thinkingDurations: { '5300:0': 420 }
    }
  }

  const api = {
    openSession: async () => {
      // Both events arrive before the invoke result. The first is already in that result.
      listener?.({ sessionId: 'bg-session', cursor: 10, event: { type: 'message_start', message: liveUser } })
      listener?.({ sessionId: 'bg-session', cursor: 11, event: {
        type: 'message_update',
        message: assistantMsg(5300, [{ type: 'text', text: '刚到的流式片段' }]),
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0 }
      } })
      if (scenario === 'settled-in-flight') {
        listener?.({ sessionId: 'bg-session', cursor: 12, event: { type: 'agent_settled', aborted: false } })
      }
      return structuredClone(openResult)
    },
    closeSession: async () => {},
    selectOpenProjectWorkspace: async () => {},
    getControls: async (): Promise<SessionControls> => ({
      model: null,
      thinkingLevel: 'off',
      thinkingLevels: ['off'],
      contextUsage: null,
      followUpMessages: [],
      steeringMessages: []
    }),
    getDisplayTurns: async () => ({
      leafId: 'entry-a2',
      turns: [priorTurn, settledTurn],
      startIndex: 0,
      totalTurns: 2,
      summary: [
        { id: 'turn-1', bytes: 120, hasImages: false },
        { id: 'turn-2', bytes: 140, hasImages: false }
      ]
    }),
    onEvent: (callback: (event: unknown) => void) => {
      listener = callback
      return () => { listener = undefined }
    },
    onSessionBranchChanged: () => () => {}
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
  const meta: SessionMeta = {
    id: 'bg-session',
    path: '/sessions/bg-session.jsonl',
    cwd: '/project/worktree',
    name: '[Bot] 修复任务',
    created: '2026-11-20T00:00:00.000Z',
    modified: '2026-11-20T00:01:00.000Z',
    size: 200,
    firstMessage: '后台任务指令'
  }
  const emit = (event: PiSessionEvent) => listener?.({ sessionId: 'bg-session', event })
  const flush = () => {
    const callbacks = [...frames.values()]
    frames.clear()
    for (const callback of callbacks) callback(16)
  }
  const drainTimers = async () => {
    const callbacks = [...timers.values()]
    timers.clear()
    for (const callback of callbacks) callback()
    await new Promise((resolve) => setImmediate(resolve))
  }

  try {
    if (scenario !== 'activate-cold') {
      await store.getState().openExisting(meta, 'project')
    } else {
      store.setState({
        openTabs: [{
          id: meta.id,
          cwd: meta.cwd,
          title: meta.name!,
          kind: 'project',
          loadState: 'cold',
          meta
        }]
      })
      await store.getState().activateTab(meta.id)
    }

    const rt = () => store.getState().runtime['bg-session']!
    if (scenario === 'settled-in-flight') {
      assert.equal(rt().isStreaming, false)
      await drainTimers()
      assert.deepEqual(rt().turns.map((turn) => turn.id), ['turn-1', 'turn-2'])
      assert.equal(rt().liveMessages.length, 0)
      return
    }
    assert.equal(rt().isStreaming, true)
    assert.equal(rt().turns.length, 1)
    assert.equal(rt().turns[0]?.id, 'turn-1')
    assert.equal(rt().liveMessages.length, 4)
    assert.equal(rt().thinkingDurations['5300:0'], 420)
    flush()
    assert.equal(rt().liveMessages.length, 4)
    assert.ok(JSON.stringify(rt().liveMessages.at(-1)).includes('刚到的流式片段'))

    const liveTurnsBeforeUpdate = groupTurns(rt().liveMessages, rt().isStreaming, rt().thinkingDurations, rt().toolUpdates)
    assert.equal(liveTurnsBeforeUpdate.length, 1)
    assert.equal(liveTurnsBeforeUpdate[0]?.streaming, true)
    assert.equal(liveTurnsBeforeUpdate[0]?.user?.timestamp, 5000)

    // Subsequent streaming delta updates the existing assistant message in place rather than duplicating it.
    const updatedAssistant = assistantMsg(5300, [
      { type: 'thinking', thinking: '检查结果' },
      { type: 'text', text: '已改好并验证通过' }
    ])
    emit({
      type: 'message_update',
      message: updatedAssistant as unknown as PiMessage,
      assistantMessageEvent: { type: 'text_delta', contentIndex: 1 }
    })
    flush()
    assert.equal(rt().liveMessages.length, 4)

    emit({
      type: 'message_end',
      message: {
        ...updatedAssistant,
        generation: { outputTokens: 20, durationMs: 500, measuredCalls: 1, totalCalls: 1, models: ['claude-sonnet-4-5'] }
      } as unknown as PiMessage
    })
    emit({ type: 'agent_end', messages: [] })
    emit({ type: 'agent_settled', aborted: false })
    assert.equal(rt().isStreaming, false)
    assert.equal((rt().streamElapsedMs ?? 0) >= 3500, true)

    await drainTimers()
    assert.equal(rt().turns.length, 2)
    assert.equal(rt().liveMessages.length, 0)
    assert.equal(rt().generationByTurnId['turn-2']?.outputTokens, 20)
    assert.equal((rt().elapsedByTurnId['turn-2'] ?? 0) >= 3500, true)
  } finally {
    unsubscribe()
  }
}

const scenario = process.env.PIG_TEST_CHILD
if (scenario === 'open-existing' || scenario === 'activate-cold' || scenario === 'settled-in-flight') {
  await runRendererScenario(scenario)
  process.exit(0)
}

describe('live session handoff on mid-run open', () => {
  test('event-bridge captures active run messages, tool updates, thinking durations, compactions, and retries until settlement', async () => {
    let clock = 100
    let leafId: string | null = 'leaf-before-run'
    const listeners = new Set<(event: AgentSessionEvent) => void>()
    const emit = (event: AgentSessionEvent) => {
      for (const listener of listeners) listener(event)
    }
    const session = {
      sessionName: '后台任务',
      sessionManager: {
        getEntries: () => [],
        getLeafId: () => leafId
      },
      agent: { streamFunction: createAssistantMessageEventStream },
      subscribe(listener: (event: AgentSessionEvent) => void) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      getFollowUpMessages: () => [],
      getSteeringMessages: () => []
    } as unknown as AgentSession
    const win = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: () => {} }
    } as unknown as BrowserWindow

    const unsubscribe = bridgeEvents(session, 'live-1', win, async () => {}, () => clock)
    try {
      expect(getSessionLiveRun(session)).toBeNull()

      emit({ type: 'agent_start' })
      leafId = 'leaf-user-msg'
      emit({
        type: 'message_start',
        message: { role: 'user', content: [{ type: 'text', text: '跑一下测试' }], timestamp: 1000 }
      })
      emit({
        type: 'message_end',
        message: { role: 'user', content: [{ type: 'text', text: '跑一下测试' }], timestamp: 1000 }
      })

      const stream = await session.agent.streamFunction(
        {} as Parameters<typeof session.agent.streamFunction>[0],
        normalizeContext({ messages: [] })
      )
      const assistantStart = assistantMsg(1100, [], 'toolUse')
      emit({ type: 'message_start', message: assistantStart })
      clock = 200
      emit({
        type: 'message_update',
        message: assistantMsg(1100, [{ type: 'thinking', thinking: '先运行单测' }], 'toolUse'),
        assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 }
      } as unknown as AgentSessionEvent)
      clock = 650
      emit({
        type: 'message_update',
        message: assistantMsg(1100, [{ type: 'thinking', thinking: '先运行单测' }], 'toolUse'),
        assistantMessageEvent: { type: 'thinking_end', contentIndex: 0 }
      } as unknown as AgentSessionEvent)
      const assistantWithCall = assistantMsg(
        1100,
        [
          { type: 'thinking', thinking: '先运行单测' },
          { type: 'toolCall', id: 'call-1', name: 'codemode', arguments: { code: '1+1' } }
        ],
        'toolUse'
      )
      stream.end(assistantWithCall)
      await stream.result()
      emit({ type: 'message_end', message: assistantWithCall })

      emit({
        type: 'tool_execution_update',
        toolCallId: 'call-1',
        toolName: 'codemode',
        args: { code: '1+1' },
        partialResult: { content: [{ type: 'text', text: 'running...' }] }
      } as unknown as AgentSessionEvent)
      emit({
        type: 'tool_execution_start',
        parentToolCallId: 'call-1',
        toolCallId: 'call-1/1',
        toolName: 'bash',
        args: { command: 'bun test' }
      } as unknown as AgentSessionEvent)
      emit({
        type: 'auto_retry_start',
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1500,
        errorMessage: 'rate limited'
      } as unknown as AgentSessionEvent)
      // SDK continue() starts another attempt inside the same unsettled run.
      emit({ type: 'agent_start' })
      emit({
        type: 'compaction_start',
        reason: 'threshold'
      } as unknown as AgentSessionEvent)

      const snap = getSessionLiveRun(session)
      expect(snap).not.toBeNull()
      expect(snap!.baseLeafId).toBe('leaf-before-run')
      expect(snap!.live.isStreaming).toBe(true)
      expect(snap!.live.messages).toHaveLength(2)
      expect(snap!.live.thinkingDurations['1100:0']).toBe(450)
      expect((snap!.live.toolUpdates['call-1'] as { nestedCalls?: { calls: Array<{ id: string }> } })?.nestedCalls?.calls[0]?.id).toBe('call-1/1')
      expect(snap!.live.retryNotice?.kind).toBe('request')
      expect(snap!.live.liveCompactions).toHaveLength(1)
      expect(snap!.live.liveCompactions[0]?.status).toBe('running')

      // Snapshot must stay immutable after subsequent events.
      emit({
        type: 'message_start',
        message: {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'codemode',
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
          timestamp: 1200
        }
      })
      expect(snap!.live.messages).toHaveLength(2)
      expect(getSessionLiveRun(session)!.live.toolUpdates['call-1']).toBeUndefined()

      // Mid-run tree navigation resets the base leaf and drops stale pre-navigation live state.
      leafId = 'leaf-other-branch'
      noteSessionBranchChanged(session)
      const afterNav = getSessionLiveRun(session)
      expect(afterNav?.baseLeafId).toBe('leaf-other-branch')
      expect(afterNav?.live.messages).toHaveLength(0)

      emit({ type: 'agent_settled', aborted: false } as unknown as AgentSessionEvent)
      expect(getSessionLiveRun(session)).toBeNull()
    } finally {
      unsubscribe()
    }
  })

  test('managerSourceBeforeLeaf isolates pre-run history from entries written during the active run', () => {
    const manager = SessionManager.inMemory('/project')
    const emptyBefore = managerSourceBeforeLeaf(manager, null)
    expect(emptyBefore).not.toBeNull()
    expect(displayWindow(emptyBefore!).turns).toHaveLength(0)

    manager.appendMessage({ role: 'user', content: [{ type: 'text', text: '第一轮' }], timestamp: 100 })
    const leafAfterTurn1 = manager.appendMessage(assistantMsg(200, [{ type: 'text', text: '第一轮答复' }]))

    // Active run appends a second turn to SessionManager while still streaming.
    manager.appendMessage({ role: 'user', content: [{ type: 'text', text: '第二轮运行中' }], timestamp: 300 })
    manager.appendMessage(assistantMsg(400, [{ type: 'toolCall', id: 'tc-2', name: 'read', arguments: { path: 'a.ts' } }], 'toolUse'))

    const preRun = managerSourceBeforeLeaf(manager, leafAfterTurn1)
    expect(preRun).not.toBeNull()
    const window = displayWindow(preRun!)
    expect(window.leafId).toBe(leafAfterTurn1)
    expect(window.turns).toHaveLength(1)
    expect(window.turns[0]?.user?.text).toBe('第一轮')

    expect(managerSourceBeforeLeaf(manager, 'missing-leaf')).toBeNull()
  })

  test('openExisting hydrates a mid-run streaming session without splitting turns or losing live state', async () => {
    const result = await runSelf(fileURLToPath(import.meta.url), [], { env: { PIG_TEST_CHILD: 'open-existing' } })
    expect(result.exitCode, result.stderr).toBe(0)
  })

  test('activateTab hydrates a cold tab backed by a mid-run streaming session', async () => {
    const result = await runSelf(fileURLToPath(import.meta.url), [], { env: { PIG_TEST_CHILD: 'activate-cold' } })
    expect(result.exitCode, result.stderr).toBe(0)
  })

  test('settlement delivered before the open reply does not leave a ghost stream', async () => {
    const result = await runSelf(fileURLToPath(import.meta.url), [], { env: { PIG_TEST_CHILD: 'settled-in-flight' } })
    expect(result.exitCode, result.stderr).toBe(0)
  })
})
