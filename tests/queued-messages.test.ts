import { expect, test } from 'bun:test'
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { ImageContent } from '@earendil-works/pi-ai'
import type { BrowserWindow } from 'electron'
import { bridgeEvents, queuePendingUserMessage } from '../src/main/pi/event-bridge'
import { updateFollowUpMessage } from '../src/main/pi/session-actions'

function fixture() {
  let steering: string[] = []
  let followUp: string[] = []
  const listeners = new Set<(event: AgentSessionEvent) => void>()
  const events: AgentSessionEvent[] = []
  const calls: Array<{ mode: 'steer' | 'followUp'; text: string; images?: ImageContent[] }> = []
  const emit = (event: AgentSessionEvent) => { for (const listener of listeners) listener(event) }
  const emitQueue = () => emit({ type: 'queue_update', steering: [...steering], followUp: [...followUp] })
  const session = {
    subscribe(listener: (event: AgentSessionEvent) => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSteeringMessages: () => steering,
    getFollowUpMessages: () => followUp,
    clearQueue() {
      const queues = { steering, followUp }
      steering = []
      followUp = []
      emitQueue()
      return queues
    },
    async steer(text: string, images?: ImageContent[]) {
      steering.push(text)
      calls.push({ mode: 'steer', text, images })
      emitQueue()
      return 'queued' as const
    },
    async followUp(text: string, images?: ImageContent[]) {
      followUp.push(text)
      calls.push({ mode: 'followUp', text, images })
      emitQueue()
      return 'queued' as const
    }
  } as unknown as AgentSession
  bridgeEvents(session, 'session', {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: (_channel: string, payload: { event: AgentSessionEvent }) => events.push(payload.event) }
  } as unknown as BrowserWindow)
  const enqueue = async (mode: 'steer' | 'followUp', text: string, images?: ImageContent[], onStart = () => {}) => {
    const pending = queuePendingUserMessage(session, text, undefined, onStart, mode, images)
    await pending.submit(() => session[mode](text, images))
  }
  const dequeue = (mode: 'steer' | 'followUp') => {
    const text = (mode === 'steer' ? steering : followUp).shift()!
    emitQueue()
    return text
  }
  const emitUser = (text: string) => {
    const message = { role: 'user' as const, content: text, timestamp: 1 }
    emit({ type: 'message_start', message })
    emit({ type: 'message_end', message })
  }
  const deliver = (mode: 'steer' | 'followUp') => emitUser(dequeue(mode))
  return { session, enqueue, dequeue, emitUser, deliver, events, calls }
}

const image = (data: string): ImageContent => ({ type: 'image', mimeType: 'image/png', data })

test('editing a steering message returns its images and preserves both remaining queues', async () => {
  const { session, enqueue, events, calls } = fixture()
  await enqueue('steer', '先做这个', [image('first')])
  await enqueue('steer', '撤回编辑', [image('edit')])
  await enqueue('followUp', '稍后处理', [image('later')])
  events.length = 0
  const result = await updateFollowUpMessage(session, 1, 'edit', 'steer')
  expect(result).toEqual({ text: '撤回编辑', images: [{ mimeType: 'image/png', data: 'edit' }] })
  expect(session.getSteeringMessages()).toEqual(['先做这个'])
  expect(session.getFollowUpMessages()).toEqual(['稍后处理'])
  expect(calls.slice(-2)).toEqual([
    { mode: 'steer', text: '先做这个', images: [image('first')] },
    { mode: 'followUp', text: '稍后处理', images: [image('later')] }
  ])
  expect(events).toEqual([{ type: 'queue_update', steering: ['先做这个'], followUp: ['稍后处理'] }])
})

test('promotion keeps the selected duplicate payload and its metadata delivery order', async () => {
  const { session, enqueue, deliver, calls } = fixture()
  const started: string[] = []
  await enqueue('followUp', '相同文字', [image('A')], () => started.push('A'))
  await enqueue('followUp', '相同文字', [image('B')], () => started.push('B'))
  await updateFollowUpMessage(session, 1, 'steer')
  expect(calls.slice(-2)).toEqual([
    { mode: 'steer', text: '相同文字', images: [image('B')] },
    { mode: 'followUp', text: '相同文字', images: [image('A')] }
  ])
  deliver('steer')
  expect(started).toEqual(['B'])
  deliver('followUp')
  expect(started).toEqual(['B', 'A'])
})

test('direct steering with duplicate text takes priority over a queued follow-up', async () => {
  const { enqueue, deliver } = fixture()
  const started: string[] = []
  await enqueue('followUp', '相同文字', undefined, () => started.push('follow-up'))
  await enqueue('steer', '相同文字', undefined, () => started.push('steer'))
  deliver('steer')
  deliver('followUp')
  expect(started).toEqual(['steer', 'follow-up'])
})

test('a new identical steer cannot capture metadata from a message already entering delivery', async () => {
  const { enqueue, dequeue, emitUser } = fixture()
  const started: string[] = []
  await enqueue('steer', '相同文字', [image('first')], () => started.push('first'))
  const first = dequeue('steer')
  await enqueue('steer', '相同文字', [image('second')], () => started.push('second'))
  emitUser(first)
  expect(started).toEqual(['first'])
  emitUser(dequeue('steer'))
  expect(started).toEqual(['first', 'second'])
})

test('withdrawing a transformed skill prompt restores its images with the accepted text', async () => {
  const { session, calls } = fixture()
  const images = [image('skill-image')]
  const pending = queuePendingUserMessage(session, '/skill:review', undefined, () => {}, 'steer', images)
  await pending.submit(() => session.steer('Expanded review instructions', images))
  const result = await updateFollowUpMessage(session, 0, 'edit', 'steer')
  expect(result).toEqual({
    text: 'Expanded review instructions',
    images: [{ mimeType: 'image/png', data: 'skill-image' }]
  })
  expect(calls[0]).toEqual({ mode: 'steer', text: 'Expanded review instructions', images })
})

test('dismissing a steering message leaves follow-ups alone and stale actions cannot rebuild the queue', async () => {
  const { session, enqueue, events } = fixture()
  await enqueue('steer', '删除')
  await enqueue('followUp', '保留')
  await updateFollowUpMessage(session, 0, 'dismiss', 'steer')
  expect(session.getSteeringMessages()).toEqual([])
  expect(session.getFollowUpMessages()).toEqual(['保留'])
  const count = events.length
  await expect(updateFollowUpMessage(session, 0, 'edit', 'steer')).rejects.toThrow('Message is no longer queued')
  expect(events).toHaveLength(count)
})
