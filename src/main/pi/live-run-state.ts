/**
 * Mirrors an active AgentSession run in main so a renderer tab opened mid-run can hydrate the
 * in-flight turn (messages, live tool updates, compactions, retry notices, thinking timings)
 * seamlessly instead of splitting persisted entries from subsequent stream events.
 */
import type { LiveCompaction, RetryNotice, SessionLiveState } from '../../shared/api'
import { nestedCallsForEvent, type LiveNestedCalls } from '../../shared/nested-tools'

interface LiveMessage {
  role: string
  timestamp: number
  toolCallId?: string
  content?: unknown
  [key: string]: unknown
}

interface ToolPartialSnapshot {
  content: unknown[]
  details?: unknown
  nestedCalls?: LiveNestedCalls
}

interface ThinkingSpan {
  messageTimestamp: number
  contentIndex: number
  startedAt: number
}

function isLiveMessage(value: unknown): value is LiveMessage {
  if (!value || typeof value !== 'object') return false
  const record = value as { role?: unknown; timestamp?: unknown }
  return typeof record.role === 'string' && typeof record.timestamp === 'number'
}

function sameMessage(left: LiveMessage, right: LiveMessage): boolean {
  if (left.role !== right.role || left.timestamp !== right.timestamp) return false
  return left.role !== 'toolResult' ||
    (right.role === 'toolResult' && left.toolCallId === right.toolCallId)
}

function assistantStreamEvent(event: Record<string, unknown>): { type: string; contentIndex: number } | null {
  const value = event.assistantMessageEvent
  if (!value || typeof value !== 'object') return null
  const nested = value as { type?: unknown; contentIndex?: unknown }
  if (
    typeof nested.type !== 'string' ||
    typeof nested.contentIndex !== 'number' ||
    !Number.isInteger(nested.contentIndex) ||
    nested.contentIndex < 0
  ) return null
  return { type: nested.type, contentIndex: nested.contentIndex }
}

function summaryFields(result: unknown): { summary?: string; tokensBefore?: number } {
  if (typeof result !== 'object' || result === null) return {}
  const record = result as Record<string, unknown>
  return {
    ...(typeof record.summary === 'string' ? { summary: record.summary } : {}),
    ...(typeof record.tokensBefore === 'number' ? { tokensBefore: record.tokensBefore } : {})
  }
}

function thinkingKey(messageTimestamp: number, contentIndex: number): string {
  return `${messageTimestamp}:${contentIndex}`
}

export class LiveRunTracker {
  private baseLeafId: string | null
  private readonly streamStartedAt: number
  private messages: LiveMessage[] = []
  private toolUpdates: Record<string, ToolPartialSnapshot> = {}
  private liveCompactions: LiveCompaction[] = []
  private retryNotice: RetryNotice | null = null
  private thinkingDurations: Record<string, number> = {}
  private readonly thinkingStarts = new Map<string, ThinkingSpan>()
  private readonly thinkingCompleted = new Set<string>()

  constructor(baseLeafId: string | null, streamStartedAt: number) {
    this.baseLeafId = baseLeafId
    this.streamStartedAt = streamStartedAt
  }

  noteBranchChanged(leafId: string | null): void {
    this.baseLeafId = leafId
    this.messages = []
    this.toolUpdates = {}
    this.liveCompactions = []
    this.retryNotice = null
    this.thinkingDurations = {}
    this.thinkingStarts.clear()
    this.thinkingCompleted.clear()
  }

  record(rawEvent: object, nowMs: number, perfNowMs: number): void {
    const event = rawEvent as Record<string, unknown>
    const type = typeof event.type === 'string' ? event.type : ''
    switch (type) {
      case 'message_start': {
        if (!isLiveMessage(event.message)) break
        const message = event.message
        if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
          delete this.toolUpdates[message.toolCallId]
        }
        this.messages.push(structuredClone(message))
        break
      }
      case 'message_update': {
        if (!isLiveMessage(event.message)) break
        const message = event.message
        const streamEvent = assistantStreamEvent(event)
        this.recordThinking(message, streamEvent, perfNowMs)
        const next: LiveMessage = message.role === 'assistant' && streamEvent
          ? { ...structuredClone(message), streamEvent }
          : structuredClone(message)
        this.upsertMessage(next)
        break
      }
      case 'message_end': {
        if (!isLiveMessage(event.message)) break
        const message = event.message
        if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
          delete this.toolUpdates[message.toolCallId]
        }
        if (message.role === 'assistant') {
          this.finishThinkingMessage(message.timestamp, perfNowMs)
        }
        const next: LiveMessage = message.role === 'assistant'
          ? { ...structuredClone(message), streamEvent: { type: 'done' } }
          : structuredClone(message)
        this.upsertMessage(next)
        break
      }
      case 'tool_execution_start':
      case 'tool_execution_end': {
        if (typeof event.parentToolCallId !== 'string') break
        const parentToolCallId = event.parentToolCallId
        const parent = this.messages
          .flatMap((message) => {
            if (message.role !== 'assistant' || !Array.isArray(message.content)) return []
            return message.content.filter(
              (item): item is { type: 'toolCall'; id: string } =>
                Boolean(item) && typeof item === 'object' &&
                (item as { type?: unknown }).type === 'toolCall' &&
                typeof (item as { id?: unknown }).id === 'string'
            )
          })
          .sort((a, b) => b.id.length - a.id.length)
          .find((call) => call.id === parentToolCallId || parentToolCallId.startsWith(`${call.id}/`))
        if (!parent || this.messages.some((msg) => msg.role === 'toolResult' && msg.toolCallId === parent.id)) break
        const existing = this.toolUpdates[parent.id] ?? { content: [] }
        const nestedCalls = nestedCallsForEvent(existing.nestedCalls, {
          type,
          toolCallId: typeof event.toolCallId === 'string' ? event.toolCallId : undefined,
          toolName: typeof event.toolName === 'string' ? event.toolName : undefined,
          durationMs: typeof event.durationMs === 'number' ? event.durationMs : undefined,
          args: event.args,
          result: event.result,
          isError: event.isError === true
        })
        if (nestedCalls) {
          this.toolUpdates[parent.id] = { ...existing, nestedCalls }
        }
        break
      }
      case 'tool_execution_update': {
        const partial = event.partialResult as ToolPartialSnapshot | undefined
        if (!event.parentToolCallId && typeof event.toolCallId === 'string' && partial && Array.isArray(partial.content)) {
          const nestedCalls = partial.nestedCalls ?? this.toolUpdates[event.toolCallId]?.nestedCalls
          const cloned = structuredClone(partial)
          this.toolUpdates[event.toolCallId] = nestedCalls ? { ...cloned, nestedCalls } : cloned
        }
        break
      }
      case 'agent_end': {
        this.finishAllThinking(perfNowMs)
        break
      }
      case 'auto_retry_start': {
        if (
          typeof event.attempt === 'number' &&
          typeof event.maxAttempts === 'number' &&
          typeof event.errorMessage === 'string'
        ) {
          this.retryNotice = {
            kind: 'request',
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            errorMessage: event.errorMessage,
            endsAt: nowMs + (typeof event.delayMs === 'number' ? Math.max(0, event.delayMs) : 0)
          }
        }
        break
      }
      case 'auto_retry_end':
      case 'summarization_retry_finished': {
        this.retryNotice = null
        break
      }
      case 'summarization_retry_scheduled': {
        if (
          typeof event.attempt === 'number' &&
          typeof event.maxAttempts === 'number' &&
          typeof event.errorMessage === 'string'
        ) {
          this.retryNotice = {
            kind: 'summary',
            source: 'summary',
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            errorMessage: event.errorMessage,
            endsAt: nowMs + (typeof event.delayMs === 'number' ? Math.max(0, event.delayMs) : 0)
          }
        }
        break
      }
      case 'summarization_retry_attempt_start': {
        if (this.retryNotice?.kind !== 'summary') break
        this.retryNotice = {
          ...this.retryNotice,
          source: event.source === 'branchSummary'
            ? 'branchSummary'
            : event.source === 'compaction' ? 'compaction' : this.retryNotice.source,
          endsAt: nowMs
        }
        break
      }
      case 'compaction_start': {
        const reason = event.reason as string | undefined
        if (reason !== 'manual' && reason !== 'memory' && reason !== 'threshold' && reason !== 'overflow') break
        const summarized = this.liveCompactions.reduce(
          (sum, mark) => sum + (mark.endedAt == null ? 0 : mark.endedAt - mark.startedAt),
          0
        )
        this.liveCompactions.push({
          id: `compaction:${nowMs}`,
          reason,
          startedAt: nowMs,
          afterMessageCount: this.messages.length,
          workMsBefore: Math.max(0, nowMs - this.streamStartedAt - summarized),
          endedAt: null,
          status: 'running'
        })
        break
      }
      case 'compaction_end': {
        const index = this.liveCompactions.findLastIndex((item) => item.status === 'running')
        if (index < 0) break
        if (event.aborted === true) {
          this.liveCompactions.splice(index, 1)
          break
        }
        const mark = this.liveCompactions[index]!
        this.liveCompactions[index] = event.result != null
          ? { ...mark, status: 'done', endedAt: nowMs, ...summaryFields(event.result) }
          : {
              ...mark,
              status: 'failed',
              endedAt: nowMs,
              errorMessage: typeof event.errorMessage === 'string' ? event.errorMessage : ''
            }
        break
      }
      default:
        break
    }
  }

  snapshot(): { baseLeafId: string | null; live: SessionLiveState } {
    return {
      baseLeafId: this.baseLeafId,
      live: {
        isStreaming: true,
        streamStartedAt: this.streamStartedAt,
        messages: structuredClone(this.messages),
        toolUpdates: structuredClone(this.toolUpdates),
        liveCompactions: structuredClone(this.liveCompactions),
        retryNotice: this.retryNotice ? { ...this.retryNotice } : null,
        thinkingDurations: { ...this.thinkingDurations }
      }
    }
  }

  private upsertMessage(message: LiveMessage): void {
    const index = this.messages.findLastIndex((item) => sameMessage(item, message))
    if (index === -1) this.messages.push(message)
    else this.messages[index] = message
  }

  private recordThinking(
    message: LiveMessage,
    streamEvent: { type: string; contentIndex: number } | null,
    perfNowMs: number
  ): void {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return
    const timestamp = message.timestamp
    const content = message.content as Array<{ type?: unknown; thinking?: unknown }>
    content.forEach((block, contentIndex) => {
      if (!block || block.type !== 'thinking') return
      const key = thinkingKey(timestamp, contentIndex)
      if (this.thinkingCompleted.has(key)) return
      const live =
        streamEvent != null &&
        streamEvent.contentIndex === contentIndex &&
        (streamEvent.type === 'thinking_start' || streamEvent.type === 'thinking_delta')
      if (!this.thinkingStarts.has(key) && (live || Boolean(block.thinking))) {
        this.thinkingStarts.set(key, { messageTimestamp: timestamp, contentIndex, startedAt: perfNowMs })
      }
      const closed = streamEvent?.type === 'thinking_end' && streamEvent.contentIndex === contentIndex
      const followed = content.slice(contentIndex + 1).some((item) => item?.type !== 'thinking')
      if (!closed && !followed) return
      const entry = this.thinkingStarts.get(key)
      if (!entry) return
      this.thinkingStarts.delete(key)
      this.finishThinking(entry, perfNowMs)
    })
  }

  private finishThinking(entry: ThinkingSpan, endedAt: number): void {
    const key = thinkingKey(entry.messageTimestamp, entry.contentIndex)
    this.thinkingCompleted.add(key)
    if (this.thinkingDurations[key] == null) {
      this.thinkingDurations[key] = Math.max(0, endedAt - entry.startedAt)
    }
  }

  private finishThinkingMessage(messageTimestamp: number, endedAt: number): void {
    for (const [key, entry] of this.thinkingStarts) {
      if (entry.messageTimestamp !== messageTimestamp) continue
      this.thinkingStarts.delete(key)
      this.finishThinking(entry, endedAt)
    }
  }

  private finishAllThinking(endedAt: number): void {
    for (const [key, entry] of this.thinkingStarts) {
      this.thinkingStarts.delete(key)
      this.finishThinking(entry, endedAt)
    }
    this.thinkingCompleted.clear()
  }
}
