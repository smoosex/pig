import { AsyncLocalStorage } from 'node:async_hooks'
import type { BrowserWindow } from 'electron'
import type { AssistantMessage, ImageContent } from '@earendil-works/pi-ai'
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { GenerationStats } from '../../shared/api'
import { GenerationSampler } from './generation-stats'
import { stripImageHintsFromContent } from '../../shared/image-hints'
import type { PastedTextDisplayMetadata } from '../../shared/pasted-text'
import { notificationTitle } from './session-preview'

const bridged = new WeakSet<AgentSession>()
const activeRuns = new WeakSet<AgentSession>()
const activeInputs = new WeakMap<AgentSession, number>()
// Pi remains idle during async input hooks/auth checks; a host input lease covers that preflight.
export function beginSessionInput(session: AgentSession): () => void {
  activeInputs.set(session, (activeInputs.get(session) ?? 0) + 1)
  return () => {
    const remaining = (activeInputs.get(session) ?? 1) - 1
    if (remaining) activeInputs.set(session, remaining)
    else activeInputs.delete(session)
  }
}
export function isSessionRunActive(session: AgentSession): boolean {
  return activeRuns.has(session) || (activeInputs.get(session) ?? 0) > 0
}

async function notifyOnCompletion(
  sessionId: string,
  win: BrowserWindow,
  signal: AbortSignal,
  content: { title: string; reply: string }
): Promise<void> {
  const { sendCompletionNotification } = await import('../completion-notification')
  await sendCompletionNotification(sessionId, win, signal, content)
}

interface QueueUpdateBatch {
  depth: number
  followUp: string[]
  steering: string[]
  metadataChanged: boolean
  flush?: () => void
}

const queueUpdateBatches = new WeakMap<AgentSession, QueueUpdateBatch>()

export function followUpMessagesForDisplay(session: AgentSession): string[] {
  return [...(queueUpdateBatches.get(session)?.followUp ?? session.getFollowUpMessages())]
}

export function steeringMessagesForDisplay(session: AgentSession): string[] {
  return [...(queueUpdateBatches.get(session)?.steering ?? session.getSteeringMessages())]
}

export async function batchQueueUpdates<T>(
  session: AgentSession,
  update: () => Promise<T>
): Promise<T> {
  const batch = queueUpdateBatches.get(session) ?? {
    depth: 0,
    followUp: [...session.getFollowUpMessages()],
    steering: [...session.getSteeringMessages()],
    metadataChanged: false
  }
  batch.depth++
  queueUpdateBatches.set(session, batch)
  try {
    return await update()
  } finally {
    batch.depth--
    if (batch.depth === 0) {
      queueUpdateBatches.delete(session)
      batch.flush?.()
    }
  }
}

type PendingMessageMode = 'steer' | 'followUp'
type PendingMessageState = 'awaiting' | 'queued' | 'delivering' | 'started'

interface PendingUserMessage {
  sourceText: string
  acceptedText?: string
  metadata?: PastedTextDisplayMetadata
  images?: ImageContent[]
  mode?: PendingMessageMode
  state: PendingMessageState
  onStart: (deliveredText: string) => void
}

interface QueueSlot {
  text: string
  pending?: PendingUserMessage
}

interface PendingUserMessageHandle {
  cancel: () => void
  submit: <T>(task: () => Promise<T>) => Promise<T>
}

const pendingUserMessages = new WeakMap<AgentSession, PendingUserMessage[]>()
const queueSlots = new WeakMap<AgentSession, Record<PendingMessageMode, QueueSlot[]>>()
const deliveringMessages = new WeakMap<AgentSession, PendingUserMessage[]>()
const pendingSubmission = new AsyncLocalStorage<{ session: AgentSession; message: PendingUserMessage }>()

function slotsFor(session: AgentSession): Record<PendingMessageMode, QueueSlot[]> {
  const existing = queueSlots.get(session)
  if (existing) return existing
  const slots = {
    steer: [...session.getSteeringMessages()].map((text) => ({ text })),
    followUp: [...session.getFollowUpMessages()].map((text) => ({ text }))
  }
  queueSlots.set(session, slots)
  return slots
}

function removePendingEntry(session: AgentSession, pending: PendingUserMessage): void {
  const queue = pendingUserMessages.get(session)
  if (!queue) return
  const index = queue.indexOf(pending)
  if (index >= 0) queue.splice(index, 1)
  if (queue.length === 0) pendingUserMessages.delete(session)
}

export function queuePendingUserMessage(
  session: AgentSession,
  text: string,
  metadata: PastedTextDisplayMetadata | undefined,
  onStart: (deliveredText: string) => void,
  mode?: PendingMessageMode,
  images?: ImageContent[]
): PendingUserMessageHandle {
  // Capture Pi's queue before submission; the synchronous queue_update binds the appended slot.
  slotsFor(session)
  const message: PendingUserMessage = {
    sourceText: text,
    metadata,
    images,
    mode,
    state: 'awaiting',
    onStart
  }
  const queue = pendingUserMessages.get(session) ?? []
  queue.push(message)
  pendingUserMessages.set(session, queue)
  return {
    cancel: () => removePendingEntry(session, message),
    submit: (task) => pendingSubmission.run({ session, message }, task)
  }
}

function assertSlotsCurrent(session: AgentSession, mode: PendingMessageMode): QueueSlot[] {
  const slots = slotsFor(session)[mode]
  const messages = mode === 'steer' ? session.getSteeringMessages() : session.getFollowUpMessages()
  if (slots.length !== messages.length || slots.some((slot, index) => slot.text !== messages[index])) {
    throw new Error(`Queued ${mode} metadata is out of sync`)
  }
  return slots
}

/** Images are absent from Pi's public queue snapshot, so queue slots retain the accepted payload. */
export function queuedUserImages(session: AgentSession, mode: PendingMessageMode): (ImageContent[] | undefined)[] {
  return assertSlotsCurrent(session, mode).map((slot) => slot.pending?.images)
}

export function updatePendingUserMessageMode(
  session: AgentSession,
  mode: PendingMessageMode,
  index: number,
  nextMode: PendingMessageMode
): void {
  const slots = assertSlotsCurrent(session, mode)
  const [slot] = slots.splice(index, 1)
  if (!slot) throw new Error('Message is no longer queued')
  if (slot.pending) slot.pending.mode = nextMode
  slotsFor(session)[nextMode].push(slot)
  const batch = queueUpdateBatches.get(session)
  if (batch) batch.metadataChanged = true
}

export function removePendingUserMessage(
  session: AgentSession,
  mode: PendingMessageMode,
  index: number
): void {
  const slots = assertSlotsCurrent(session, mode)
  const [slot] = slots.splice(index, 1)
  if (!slot) throw new Error('Message is no longer queued')
  if (slot.pending) removePendingEntry(session, slot.pending)
  const batch = queueUpdateBatches.get(session)
  if (batch) batch.metadataChanged = true
}

function reconcileSlots(previous: QueueSlot[], messages: readonly string[]): QueueSlot[] {
  const counts = new Map<string, number>()
  for (const text of messages) counts.set(text, (counts.get(text) ?? 0) + 1)
  const candidates = new Map<string, { slots: QueueSlot[]; index: number }>()
  for (const slot of previous) {
    const bucket = candidates.get(slot.text) ?? { slots: [], index: 0 }
    bucket.slots.push(slot)
    candidates.set(slot.text, bucket)
  }
  for (const [text, bucket] of candidates) {
    bucket.index = Math.max(0, bucket.slots.length - (counts.get(text) ?? 0))
  }
  return messages.map((text) => {
    const bucket = candidates.get(text)
    return bucket?.slots[bucket.index++] ?? { text }
  })
}

function acceptQueuedMessage(
  session: AgentSession,
  event: Extract<AgentSessionEvent, { type: 'queue_update' }>,
  pending: PendingUserMessage
): void {
  const mode = pending.mode
  if (!mode) throw new Error('Pi queued input without a delivery mode')
  const slots = slotsFor(session)[mode]
  const messages = mode === 'steer' ? event.steering : event.followUp
  if (
    messages.length !== slots.length + 1 ||
    slots.some((slot, index) => slot.text !== messages[index])
  ) {
    throw new Error(`Pi ${mode} queue did not append the submitted message`)
  }
  const acceptedText = messages.at(-1)
  if (acceptedText === undefined) throw new Error(`Pi ${mode} queue accepted no message`)
  pending.acceptedText = acceptedText
  pending.state = 'queued'
  slots.push({ text: acceptedText, pending })
}

function applyQueueUpdate(
  session: AgentSession,
  event: Extract<AgentSessionEvent, { type: 'queue_update' }>,
  metadataChanged: boolean
): void {
  const context = pendingSubmission.getStore()
  if (context?.session === session && context.message.state === 'awaiting') {
    acceptQueuedMessage(session, event, context.message)
  }
  const slots = slotsFor(session)
  for (const [mode, messages] of [
    ['steer', event.steering],
    ['followUp', event.followUp]
  ] as const) {
    if (metadataChanged) {
      const expected = slots[mode]
      if (expected.length !== messages.length || expected.some((slot, index) => slot.text !== messages[index])) {
        throw new Error(`Rebuilt ${mode} queue does not match its metadata`)
      }
      continue
    }
    const previous = slots[mode]
    const next = reconcileSlots(previous, messages)
    const retained = new Set(next)
    const delivering = deliveringMessages.get(session) ?? []
    for (const slot of previous) {
      if (!retained.has(slot) && slot.pending?.state === 'queued') {
        slot.pending.state = 'delivering'
        delivering.push(slot.pending)
      }
    }
    if (delivering.length > 0) deliveringMessages.set(session, delivering)
    slots[mode] = next
  }
}

export function bridgeEvents(
  session: AgentSession,
  sessionId: string,
  win: BrowserWindow,
  notify: typeof notifyOnCompletion = notifyOnCompletion,
  now: () => number = () => performance.now()
): () => void {
  if (bridged.has(session)) return () => {}
  bridged.add(session)

  let subscribed = true
  let runActive = false
  let lastAnswerSucceeded = false
  let lastReply = ''
  const sampled = new WeakMap<AssistantMessage, GenerationStats>()
  const streamFunction = session.agent.streamFunction
  // Session events reach this bridge only after awaited extension hooks, so they would skew both
  // ends of the window. Time each response where its provider pushes events instead.
  const timedStreamFunction: typeof streamFunction = async (...args) => {
    const stream = await streamFunction(...args)
    const sampler = new GenerationSampler()
    const push = stream.push.bind(stream)
    stream.push = (event) => {
      if (event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'toolcall_delta') {
        sampler.record(event.type, event.delta, now())
      }
      push(event)
    }
    const result = stream.result().then((message) => {
      sampled.set(message, sampler.finish(message, now()))
      return message
    })
    // Keep this the result awaited by the SDK, so any rejection still propagates to the caller.
    stream.result = () => result
    return stream
  }
  session.agent.streamFunction = timedStreamFunction
  const lifetime = new AbortController()
  const forward = (event: AgentSessionEvent, metadataChanged = false) => {
    if (!subscribed) return
    if (event.type === 'queue_update') applyQueueUpdate(session, event, metadataChanged)
    if (event.type === 'agent_start') {
      activeRuns.add(session)
      runActive = true
      lastAnswerSucceeded = false
      lastReply = ''
    }
    let generation: GenerationStats | undefined
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      lastAnswerSucceeded = event.message.stopReason === 'stop' || event.message.stopReason === 'length'
      lastReply = event.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
      // A message that never came from a stream (a failed request) still counts as an unmeasured call.
      generation = sampled.get(event.message) ?? new GenerationSampler().finish(event.message, undefined)
    }
    let metadata: PastedTextDisplayMetadata | undefined
    const message = 'message' in event ? event.message : undefined
    const displayContent = message?.role === 'user' ? stripImageHintsFromContent(message.content) : undefined
    if (message?.role === 'user' && displayContent !== undefined) {
      if (event.type === 'message_start') {
        const messageText = typeof displayContent === 'string'
          ? displayContent
          : displayContent
            .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
            .map((block) => block.text)
            .join('')
        const context = pendingSubmission.getStore()
        const direct = context?.session === session && context.message.state === 'awaiting'
          ? context.message : undefined
        if (direct) {
          direct.acceptedText = messageText
          direct.state = 'started'
          direct.onStart(messageText)
          metadata = direct.metadata
        } else {
          const delivering = deliveringMessages.get(session) ?? []
          const index = delivering.findIndex((item) => item.acceptedText === messageText)
          if (index < 0 && delivering.length > 0) {
            throw new Error(`Delivered user message did not match queued metadata: ${messageText}`)
          }
          if (index >= 0) {
            const pending = delivering.splice(index, 1)[0]!
            if (delivering.length === 0) deliveringMessages.delete(session)
            pending.state = 'started'
            pending.onStart(messageText)
            metadata = pending.metadata
          }
        }
      } else if (event.type === 'message_end') {
        const queue = pendingUserMessages.get(session)
        const pending = queue?.find((item) => item.state === 'started')
        if (pending) {
          metadata = pending.metadata
          removePendingEntry(session, pending)
        }
      }
    }
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    let enriched: object = event
    if (event.type === 'message_end' && message?.role === 'assistant' && generation) {
      enriched = { ...event, message: { ...message, generation } }
    } else if (
      (event.type === 'message_start' || event.type === 'message_end') &&
      message?.role === 'user' &&
      (metadata || displayContent !== message.content)
    ) {
      enriched = {
        ...event,
        message: {
          ...message,
          content: displayContent,
          ...(metadata ? { pastedText: metadata } : {})
        }
      }
    }
    win.webContents.send('pi:event', { sessionId, event: enriched })
    if (event.type === 'agent_settled') {
      activeRuns.delete(session)
      if (runActive && lastAnswerSucceeded && !event.aborted) {
        void notify(sessionId, win, lifetime.signal, { title: notificationTitle(session), reply: lastReply }).catch((error: unknown) => {
          console.error('Could not send completion notification:', error)
        })
      }
      runActive = false
      lastAnswerSucceeded = false
    }
  }

  const unsubscribe = session.subscribe((event) => {
    const batch = event.type === 'queue_update' ? queueUpdateBatches.get(session) : undefined
    if (batch) {
      batch.flush = () => forward(event, batch.metadataChanged)
      return
    }
    forward(event)
  })
  return () => {
    subscribed = false
    lifetime.abort()
    unsubscribe()
    if (session.agent.streamFunction === timedStreamFunction) session.agent.streamFunction = streamFunction
    bridged.delete(session)
  }
}
