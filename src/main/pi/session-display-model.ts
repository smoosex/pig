import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type { DisplayAnswer, DisplayTurn, DisplayUser } from '../../shared/api'
import {
  createInlinePastedTextDisplayMetadata,
  isPastedTextMetadata,
  pastedTextFingerprint,
  PASTED_TEXT_CUSTOM_TYPE,
  type PastedTextMetadata,
  type PastedTextPromptAttachment
} from '../../shared/pasted-text'

export type { DisplayAnswer, DisplayTurn, DisplayUser } from '../../shared/api'

type PathMessage = {
  id: string
  message: Record<string, unknown>
  persistedAt: number
  pastedText?: PastedTextMetadata
}

function isHidden(type: string): boolean {
  return (
    type === 'label' ||
    type === 'custom' ||
    type === 'model_change' ||
    type === 'thinking_level_change' ||
    type === 'session_info'
  )
}

function entryTimestamp(entry: SessionEntry): number {
  const value = Date.parse(entry.timestamp)
  return Number.isNaN(value) ? 0 : value
}

function withTimestamp(message: Record<string, unknown>, fallback: number): Record<string, unknown> {
  if (typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)) return message
  return { ...message, timestamp: fallback }
}

function* pathMessages(entries: SessionEntry[]): Generator<PathMessage> {
  let pendingPastedText: PastedTextMetadata | undefined
  for (const raw of entries) {
    const entry = raw as SessionEntry
    if (entry.type === 'custom' && entry.customType === PASTED_TEXT_CUSTOM_TYPE) {
      pendingPastedText = isPastedTextMetadata(entry.data) ? entry.data : undefined
      continue
    }
    const fallback = entryTimestamp(entry)
    if (entry.type === 'message') {
      const message = withTimestamp(entry.message as unknown as Record<string, unknown>, fallback)
      const pastedText = message.role === 'user' ? pendingPastedText : undefined
      pendingPastedText = undefined
      yield { id: entry.id, persistedAt: fallback, message, pastedText }
      continue
    }
    if (pendingPastedText) pendingPastedText = undefined
    if (isHidden(entry.type)) continue
    if (entry.type === 'custom_message') {
      if (entry.display === false) continue
      yield {
        id: entry.id,
        persistedAt: fallback,
        message: {
          role: 'custom',
          customType: entry.customType,
          content: entry.content,
          display: entry.display,
          details: entry.details,
          timestamp: fallback
        }
      }
      continue
    }
    if (entry.type === 'compaction') {
      yield {
        id: entry.id,
        persistedAt: fallback,
        message: {
          role: 'compactionSummary',
          summary: entry.summary,
          tokensBefore: entry.tokensBefore,
          timestamp: fallback
        }
      }
      continue
    }
    if (entry.type === 'branch_summary') {
      yield {
        id: entry.id,
        persistedAt: fallback,
        message: {
          role: 'branchSummary',
          summary: entry.summary,
          fromId: entry.fromId,
          timestamp: fallback
        }
      }
    }
  }
}

function* groupPath(items: Iterable<PathMessage>): Generator<PathMessage[]> {
  let current: PathMessage[] = []
  for (const item of items) {
    if (item.message.role === 'user') {
      if (current.length > 0) yield current
      current = [item]
    } else {
      current.push(item)
    }
  }
  if (current.length > 0) yield current
}

function displayUser(
  message: Record<string, unknown>,
  pastedText?: PastedTextMetadata
): DisplayUser | undefined {
  if (message.role !== 'user') return undefined
  const content = message.content
  const images: DisplayUser['images'] = []
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text as string)
        .join('')
      : ''
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block?.type === 'image' &&
        typeof block.mimeType === 'string' &&
        typeof block.data === 'string'
      ) {
        images.push({ mimeType: block.mimeType, data: block.data })
      }
    }
  }
  if (
    pastedText &&
    text.length === pastedText.contentLength &&
    pastedTextFingerprint(text) === pastedText.contentHash &&
    pastedText.attachments.every((attachment) => attachment.end <= text.length)
  ) {
    const attachments: PastedTextPromptAttachment[] = pastedText.attachments.map((attachment) => ({
      id: attachment.id,
      text: text.slice(attachment.start, attachment.end),
      byteSize: attachment.byteSize,
      start: attachment.start,
      end: attachment.end,
      ...(attachment.filename ? { filename: attachment.filename } : {})
    }))
    if (pastedText.version === 2) {
      const display = createInlinePastedTextDisplayMetadata(text, attachments)
      return {
        text,
        images,
        textAttachments: display.attachments,
        textSegments: display.segments
      }
    }
    return {
      text: text.slice(0, pastedText.bodyLength),
      images,
      textAttachments: attachments.map(({ id, text: attachmentText, byteSize, filename }) => ({
        id,
        text: attachmentText,
        byteSize,
        ...(filename ? { filename } : {})
      }))
    }
  }
  return { text, images, textAttachments: [] }
}

function lastToolCallIndex(content: unknown): number {
  if (!Array.isArray(content)) return -1
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i]?.type === 'toolCall') return i
  }
  return -1
}

function asAnswer(block: {
  type?: string
  text?: string
  mimeType?: string
  data?: string
}): DisplayAnswer | null {
  if (block.type === 'text' && block.text) return { type: 'text', text: block.text }
  if (block.type === 'image' && block.mimeType && block.data) {
    return { type: 'image', mimeType: block.mimeType, data: block.data }
  }
  return null
}

function summarizeChunk(chunk: PathMessage[]): Omit<DisplayTurn, 'id'> {
  const messages = chunk.map((item) => item.message)
  const userEntry = chunk[0]
  const userMsg = messages[0]?.role === 'user' ? messages[0] : undefined
  const rest = userMsg ? messages.slice(1) : messages
  const user = userMsg ? displayUser(userMsg, userEntry.pastedText) : undefined

  let lastAssistant = -1
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].role === 'assistant') lastAssistant = i
  }

  let hasProcess = false
  let answer: DisplayAnswer[] = []
  let errorMessage: string | undefined

  rest.forEach((message, i) => {
    if (message.role === 'assistant') {
      const isLast = i === lastAssistant
      const trailingIsAnswer = isLast && rest.slice(i + 1).every((item) => item.role !== 'toolResult')
      const splitAt = lastToolCallIndex(message.content)
      const splitTrailing = isLast && splitAt >= 0
      const content = Array.isArray(message.content) ? message.content : []
      const blocks: DisplayAnswer[] = []
      const pulled: DisplayAnswer[] = []

      content.forEach((block: Record<string, unknown>, index: number) => {
        const toAnswer = splitTrailing && trailingIsAnswer && index > splitAt
        if (block.type === 'thinking') {
          if (typeof block.thinking === 'string' && block.thinking) hasProcess = true
          return
        }
        if (block.type === 'toolCall') {
          hasProcess = true
          return
        }
        const item = asAnswer(block)
        if (!item) return
        if (toAnswer) blocks.push(item)
        else pulled.push(item)
      })

      if (isLast && (trailingIsAnswer || splitAt < 0)) {
        if (blocks.length > 0) answer = blocks
        else if (!splitTrailing) answer = pulled
        else if (pulled.length > 0) hasProcess = true
      } else if (pulled.length > 0 || blocks.length > 0 || !isLast) {
        hasProcess = true
      }

      if (typeof message.errorMessage === 'string' && message.errorMessage) {
        errorMessage = message.errorMessage
      }
      return
    }
    if (
      message.role === 'toolResult' ||
      message.role === 'bashExecution' ||
      message.role === 'custom' ||
      message.role === 'branchSummary' ||
      message.role === 'compactionSummary'
    ) {
      hasProcess = true
    }
  })

  const timeOf = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined
  const startedAt =
    timeOf(rest[0]?.timestamp) ?? timeOf(userMsg?.timestamp) ?? chunk[userMsg ? 1 : 0]?.persistedAt ?? 0
  const endedAt = chunk[chunk.length - 1]?.persistedAt ?? startedAt

  return { user, answer, errorMessage, startedAt, endedAt, hasProcess }
}

export function displayTurnsFromEntries(entries: SessionEntry[]): DisplayTurn[] {
  return Array.from(groupPath(pathMessages(entries)), (chunk) => ({
    id: chunk[0].id,
    ...summarizeChunk(chunk)
  }))
}

export function turnMessagesFromEntries(entries: SessionEntry[], turnId: string): unknown[] {
  // A disclosure needs one turn; stop projecting history at that turn's boundary.
  for (const group of groupPath(pathMessages(entries))) {
    if (group.some((item) => item.id === turnId)) {
      return group.map((item) => ({ ...item.message, persistedAt: item.persistedAt }))
    }
  }
  throw new Error(`Turn not found: ${turnId}`)
}
