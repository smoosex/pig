import type { BrowserWindow } from 'electron'
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { stripImageHintsFromContent } from '../../shared/image-hints'
import type { PastedTextDisplayMetadata } from '../../shared/pasted-text'

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

async function notifyOnCompletion(sessionId: string, win: BrowserWindow, signal: AbortSignal): Promise<void> {
  const { sendCompletionNotification } = await import('../completion-notification')
  await sendCompletionNotification(sessionId, win, signal)
}

interface QueueUpdateBatch {
  depth: number
  followUp: string[]
  flush?: () => void
}

const queueUpdateBatches = new WeakMap<AgentSession, QueueUpdateBatch>()

export function followUpMessagesForDisplay(session: AgentSession): string[] {
  return [...(queueUpdateBatches.get(session)?.followUp ?? session.getFollowUpMessages())]
}

export async function batchQueueUpdates<T>(
  session: AgentSession,
  update: () => Promise<T>
): Promise<T> {
  const batch = queueUpdateBatches.get(session) ?? {
    depth: 0,
    followUp: [...session.getFollowUpMessages()]
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

interface PendingUserMessage {
  text: string
  metadata?: PastedTextDisplayMetadata
  mode?: PendingMessageMode
  started: boolean
  onStart: () => void
}

const pendingUserMessages = new WeakMap<AgentSession, PendingUserMessage[]>()

export function queuePendingUserMessage(
  session: AgentSession,
  text: string,
  metadata: PastedTextDisplayMetadata | undefined,
  onStart: () => void,
  mode?: PendingMessageMode
): () => void {
  const entry: PendingUserMessage = { text, metadata, mode, started: false, onStart }
  const queue = pendingUserMessages.get(session) ?? []
  queue.push(entry)
  pendingUserMessages.set(session, queue)
  return () => {
    const current = pendingUserMessages.get(session)
    if (!current) return
    const index = current.indexOf(entry)
    if (index < 0) return
    current.splice(index, 1)
    if (current.length === 0) pendingUserMessages.delete(session)
  }
}

export function updatePendingUserMessageMode(
  session: AgentSession,
  mode: PendingMessageMode,
  index: number,
  nextMode: PendingMessageMode
): void {
  const queue = pendingUserMessages.get(session)
  if (!queue) return
  const pending = queue.filter((item) => !item.started && item.mode === mode)[index]
  if (pending) pending.mode = nextMode
}

export function removePendingUserMessage(
  session: AgentSession,
  mode: PendingMessageMode,
  index: number
): void {
  const queue = pendingUserMessages.get(session)
  if (!queue) return
  const pending = queue.filter((item) => !item.started && item.mode === mode)[index]
  if (!pending) return
  const pendingIndex = queue.indexOf(pending)
  queue.splice(pendingIndex, 1)
  if (queue.length === 0) pendingUserMessages.delete(session)
}

export function bridgeEvents(
  session: AgentSession,
  sessionId: string,
  win: BrowserWindow,
  notify: typeof notifyOnCompletion = notifyOnCompletion
): () => void {
  if (bridged.has(session)) return () => {}
  bridged.add(session)

  let subscribed = true
  let runActive = false
  let lastAnswerSucceeded = false
  const lifetime = new AbortController()
  const forward = (event: AgentSessionEvent) => {
    if (!subscribed) return
    if (event.type === 'agent_start') {
      activeRuns.add(session)
      runActive = true
      lastAnswerSucceeded = false
    } else if (event.type === 'message_end' && event.message.role === 'assistant') {
      lastAnswerSucceeded = event.message.stopReason === 'stop' || event.message.stopReason === 'length'
    }
    let metadata: PastedTextDisplayMetadata | undefined
    const message = 'message' in event ? event.message : undefined
    const displayContent = message?.role === 'user' ? stripImageHintsFromContent(message.content) : undefined
    const queue = pendingUserMessages.get(session)
    if (queue && message?.role === 'user' && displayContent !== undefined) {
      if (event.type === 'message_start') {
        const messageText = typeof displayContent === 'string'
          ? displayContent
          : displayContent
            .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
            .map((block) => block.text)
            .join('')
        const pending =
          queue.find((item) => !item.started && item.text === messageText) ??
          queue.find((item) => !item.started)
        if (pending) {
          pending.started = true
          pending.onStart()
          metadata = pending.metadata
        }
      } else if (event.type === 'message_end') {
        const index = queue.findIndex((item) => item.started)
        if (index >= 0) {
          metadata = queue[index].metadata
          queue.splice(index, 1)
          if (queue.length === 0) pendingUserMessages.delete(session)
        }
      }
    }
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    const enriched =
      (event.type === 'message_start' || event.type === 'message_end') &&
      message?.role === 'user' &&
      (metadata || displayContent !== message.content)
        ? {
            ...event,
            message: {
              ...message,
              content: displayContent,
              ...(metadata ? { pastedText: metadata } : {})
            }
          }
        : event
    win.webContents.send('pi:event', { sessionId, event: enriched })
    if (event.type === 'agent_settled') {
      activeRuns.delete(session)
      if (runActive && lastAnswerSucceeded && !event.aborted) {
        void notify(sessionId, win, lifetime.signal).catch((error: unknown) => {
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
      batch.flush = () => forward(event)
      return
    }
    forward(event)
  })
  return () => {
    subscribed = false
    lifetime.abort()
    unsubscribe()
    bridged.delete(session)
  }
}
