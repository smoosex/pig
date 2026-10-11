import { describe, expect, test } from 'bun:test'
import type { BrowserWindow } from 'electron'
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import {
  batchQueueUpdates,
  bridgeEvents,
  followUpMessagesForDisplay,
  steeringMessagesForDisplay,
  queuePendingUserMessage
} from '../src/main/pi/event-bridge'
import { reconcileFollowUpRows } from '../src/renderer/src/chat/follow-ups'

function fixture(
  initial: string[] = ['第一条', '第二条', '第三条'],
  now: () => number = () => performance.now()
) {
  let followUp = [...initial]
  let steering = ['已有插话']
  let destroyed = false
  const listeners = new Set<(event: AgentSessionEvent) => void>()
  const events: AgentSessionEvent[] = []
  const notifications: string[] = []
  const emit = (event: AgentSessionEvent) => {
    for (const listener of listeners) listener(event)
  }
  const emitQueue = () => emit({ type: 'queue_update', steering: [...steering], followUp: [...followUp] })
  const session = {
    subscribe(listener: (event: AgentSessionEvent) => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getFollowUpMessages: () => followUp,
    getSteeringMessages: () => steering,
    clearQueue() {
      const previous = { steering: [...steering], followUp: [...followUp] }
      steering = []
      followUp = []
      emitQueue()
      return previous
    },
    async steer(text: string) {
      steering.push(text)
      emitQueue()
    },
    async followUp(text: string) {
      followUp.push(text)
      emitQueue()
    }
  } as unknown as AgentSession
  const win = {
    isDestroyed: () => destroyed,
    webContents: {
      isDestroyed: () => destroyed,
      send(_channel: string, payload: { event: AgentSessionEvent }) {
        events.push(payload.event)
      }
    }
  } as unknown as BrowserWindow
  const unsubscribe = bridgeEvents(session, 'test-session', win, async (sessionId) => {
    notifications.push(sessionId)
  }, now)
  return { session, events, notifications, emit, unsubscribe, destroy: () => { destroyed = true } }
}

function assistantEnd(stopReason: 'stop' | 'length' | 'error' | 'aborted'): AgentSessionEvent {
  return { type: 'message_end', message: { role: 'assistant', stopReason } } as AgentSessionEvent
}

describe('completion notifications', () => {
  test('waits until the entire run settles and sends at most once', () => {
    const state = fixture()
    state.emit({ type: 'agent_start' })
    state.emit(assistantEnd('stop'))
    state.emit({ type: 'agent_end', messages: [], willRetry: false })
    expect(state.notifications).toEqual([])
    state.emit({ type: 'agent_settled', aborted: false })
    state.emit({ type: 'agent_settled', aborted: false })
    expect(state.notifications).toEqual(['test-session'])
    state.emit({ type: 'agent_start' })
    state.emit(assistantEnd('stop'))
    state.emit({ type: 'agent_settled', aborted: false })
    expect(state.notifications).toHaveLength(2)
    state.unsubscribe()
  })

  test('notifies when the final reply reaches the output token limit', () => {
    const state = fixture()
    state.emit({ type: 'agent_start' })
    state.emit(assistantEnd('length'))
    state.emit({ type: 'agent_settled', aborted: false })
    expect(state.notifications).toEqual(['test-session'])
    state.unsubscribe()
  })

  test('does not notify when cancellation follows a successful assistant reply', () => {
    const state = fixture()
    state.emit({ type: 'agent_start' })
    state.emit(assistantEnd('stop'))
    state.emit({ type: 'agent_settled', aborted: true })
    expect(state.notifications).toEqual([])
    expect(state.events.at(-1)).toEqual({ type: 'agent_settled', aborted: true })
    state.unsubscribe()
  })

  test('ignores retries, aborted or failed answers, and runs with no reply', () => {
    const state = fixture()
    state.emit({ type: 'agent_settled', aborted: false })
    state.emit({ type: 'agent_start' })
    state.emit({ type: 'agent_settled', aborted: false })
    state.emit({ type: 'agent_start' })
    state.emit(assistantEnd('error'))
    state.emit({ type: 'agent_end', messages: [], willRetry: true })
    state.emit({ type: 'agent_start' })
    state.emit(assistantEnd('aborted'))
    state.emit({ type: 'agent_settled', aborted: true })
    expect(state.notifications).toEqual([])
    state.emit({ type: 'agent_start' })
    state.emit(assistantEnd('error'))
    state.emit({ type: 'agent_end', messages: [], willRetry: true })
    state.emit({ type: 'agent_start' })
    state.emit(assistantEnd('stop'))
    state.emit({ type: 'agent_settled', aborted: false })
    expect(state.notifications).toEqual(['test-session'])
    state.unsubscribe()
  })

  test('never notifies after the bridge closes', () => {
    const state = fixture()
    state.emit({ type: 'agent_start' })
    state.emit(assistantEnd('stop'))
    state.unsubscribe()
    state.emit({ type: 'agent_settled', aborted: false })
    expect(state.notifications).toEqual([])
  })
})

test('assistant output carries provider usage measured over active decoding time', () => {
  const timestamps = [100, 600]
  const state = fixture([], () => timestamps.shift()!)
  const message = {
    role: 'assistant' as const,
    timestamp: 10,
    api: 'test',
    provider: 'test',
    model: 'test',
    stopReason: 'toolUse' as const,
    content: [],
    usage: {
      input: 10, output: 25, cacheRead: 0, cacheWrite: 0, totalTokens: 35,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    }
  }
  state.emit({ type: 'message_start', message } as AgentSessionEvent)
  state.emit({
    type: 'message_update', message,
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hello', partial: message }
  } as AgentSessionEvent)
  state.emit({
    type: 'message_update', message,
    assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 1, delta: '{"path":"x"}', partial: message }
  } as AgentSessionEvent)
  state.emit({ type: 'message_end', message } as AgentSessionEvent)

  expect(state.events.at(-1)).toMatchObject({
    type: 'message_end',
    message: { generation: { outputTokens: 25, durationMs: 500 } }
  })
  expect(message).not.toHaveProperty('generation')
  state.unsubscribe()
})

test('live image messages hide the SDK note without changing the message given to pi', async () => {
  const state = fixture([])
  state.session.clearQueue()
  const hint = '[Image: original 2992x1868, displayed at 2000x1249. Multiply coordinates by 1.50 to map to original image.]'
  const text = `看图\n\n${hint}`
  const content = [{ type: 'text', text }, { type: 'image', mimeType: 'image/png', data: 'QUJD' }]
  const started: string[] = []
  const pending = queuePendingUserMessage(state.session, '看图', undefined, () => started.push('image'), 'steer')
  await pending.submit(() => state.session.steer('看图'))
  state.session.clearQueue()
  const message = { role: 'user', content, timestamp: 1 }

  state.emit({ type: 'message_start', message } as AgentSessionEvent)
  state.emit({ type: 'message_end', message } as AgentSessionEvent)

  expect(started).toEqual(['image'])
  expect(state.events.filter((event) => event.type === 'message_start' || event.type === 'message_end')).toMatchObject([
    { type: 'message_start', message: { content: [{ type: 'text', text: '看图' }, content[1]] } },
    { type: 'message_end', message: { content: [{ type: 'text', text: '看图' }, content[1]] } }
  ])
  expect(content[0].text).toBe(text)
  state.unsubscribe()
})

test('a directly started prompt binds metadata without passing through a queue', async () => {
  const state = fixture([])
  state.session.clearQueue()
  const started: string[] = []
  const pending = queuePendingUserMessage(state.session, 'source command', undefined, () => started.push('started'))
  await pending.submit(async () => {
    const message = { role: 'user' as const, content: 'expanded prompt', timestamp: 1 }
    state.emit({ type: 'message_start', message } as AgentSessionEvent)
    state.emit({ type: 'message_end', message } as AgentSessionEvent)
  })
  expect(started).toEqual(['started'])
  state.unsubscribe()
})

describe('batched queue updates', () => {
  for (const action of ['steer', 'dismiss', 'edit'] as const) {
    for (const repeated of [false, true]) {
      test(`${action} only removes its target row (${repeated ? 'duplicate' : 'unique'} text)`, async () => {
        const messages = repeated ? ['again', 'again', 'again'] : ['第一条', '第二条', '第三条']
        const { session, events } = fixture(messages)
        const rawSnapshots: Array<readonly string[]> = []
        session.subscribe((event) => {
          if (event.type === 'queue_update') rawSnapshots.push(event.followUp)
        })
        let sequence = 0
        const createId = () => String(++sequence)
        const originalRows = reconcileFollowUpRows([], messages, createId)

        await batchQueueUpdates(session, async () => {
          const { steering } = session.clearQueue()
          for (const text of steering) await session.steer(text)
          if (action === 'steer') await session.steer(messages[1])
          await session.followUp(messages[0])
          await session.followUp(messages[2])
        })

        expect(rawSnapshots[0]).toEqual([])
        expect(rawSnapshots.length).toBeGreaterThan(1)
        expect(events).toEqual([{
          type: 'queue_update',
          steering: action === 'steer' ? ['已有插话', messages[1]] : ['已有插话'],
          followUp: [messages[0], messages[2]]
        }])
        let rows = originalRows
        const exitedIds: string[] = []
        for (const event of events) {
          if (event.type !== 'queue_update') continue
          const next = reconcileFollowUpRows(rows, event.followUp, createId, originalRows[1].id)
          exitedIds.push(...rows.filter((row) => !next.includes(row)).map((row) => row.id))
          rows = next
        }
        expect(exitedIds).toEqual([originalRows[1].id])
        expect(rows[0]).toBe(originalRows[0])
        expect(rows[1]).toBe(originalRows[2])
      })
    }
  }

  test('controls keep the committed queue while reconstruction is in progress', async () => {
    const { session } = fixture()
    await batchQueueUpdates(session, async () => {
      session.clearQueue()
      expect(followUpMessagesForDisplay(session)).toEqual(['第一条', '第二条', '第三条'])
      expect(steeringMessagesForDisplay(session)).toEqual(['已有插话'])
      await session.followUp('第一条')
      expect(followUpMessagesForDisplay(session)).toEqual(['第一条', '第二条', '第三条'])
      const snapshot = followUpMessagesForDisplay(session)
      snapshot.length = 0
      expect(followUpMessagesForDisplay(session)).toHaveLength(3)
    })
    expect(followUpMessagesForDisplay(session)).toEqual(['第一条'])
    expect(steeringMessagesForDisplay(session)).toEqual([])
  })

  test('normal delivery and non-queue events still publish immediately', async () => {
    const { session, events, emit } = fixture()
    emit({ type: 'queue_update', steering: [], followUp: ['第二条', '第三条'] })
    expect(events).toHaveLength(1)
    await batchQueueUpdates(session, async () => {
      session.clearQueue()
      emit({ type: 'agent_start' })
      expect(events.map((event) => event.type)).toEqual(['queue_update', 'agent_start'])
      await session.followUp('第三条')
    })
    expect(events.at(-1)).toMatchObject({ type: 'queue_update', followUp: ['第三条'] })
  })

  test('failed reconstruction publishes the actual queue and releases the batch', async () => {
    const { session, events } = fixture()
    await expect(batchQueueUpdates(session, async () => {
      session.clearQueue()
      await session.followUp('保留消息')
      throw new Error('requeue failed')
    })).rejects.toThrow('requeue failed')
    expect(events).toEqual([{ type: 'queue_update', steering: [], followUp: ['保留消息'] }])
    expect(followUpMessagesForDisplay(session)).toEqual(['保留消息'])
    await session.followUp('新消息')
    expect(events.at(-1)).toMatchObject({ followUp: ['保留消息', '新消息'] })
  })

  test('nested batches publish once and do not block another session', async () => {
    const first = fixture()
    const second = fixture([])
    await batchQueueUpdates(first.session, async () => {
      first.session.clearQueue()
      await batchQueueUpdates(first.session, () => first.session.followUp('第一条'))
      expect(first.events).toEqual([])
      await second.session.followUp('另一个会话')
      expect(second.events).toHaveLength(1)
      await first.session.followUp('第二条')
    })
    expect(first.events).toEqual([{ type: 'queue_update', steering: [], followUp: ['第一条', '第二条'] }])
  })

  for (const cleanup of ['unsubscribe', 'destroy'] as const) {
    test(`does not flush to a closed bridge after ${cleanup}`, async () => {
      const state = fixture()
      await batchQueueUpdates(state.session, async () => {
        state.session.clearQueue()
        state[cleanup]()
      })
      expect(state.events).toEqual([])
    })
  }
})
