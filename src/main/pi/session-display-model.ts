import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type {
  DisplayAnswer,
  DisplayCompaction,
  DisplayImage,
  DisplayTurn,
  DisplayUser
} from '../../shared/api'
import { stripImageHintsFromContent } from '../../shared/image-hints'
import { imageMimeType, isImageBlock, sessionImageUrl, type ImageBlock } from '../../shared/session-images'
import {
  createInlinePastedTextDisplayMetadata,
  isPastedTextMetadata,
  pastedTextFingerprint,
  PASTED_TEXT_CUSTOM_TYPE,
  type PastedTextMetadata,
  type PastedTextPromptAttachment
} from '../../shared/pasted-text'

export type { DisplayAnswer, DisplayCompaction, DisplayTurn, DisplayUser } from '../../shared/api'

type PathMessage = {
  id: string
  message: Record<string, unknown>
  persistedAt: number
  pastedText?: PastedTextMetadata
}

/**
 * Entry types the projection never shows. The byte reader shares this list: turn boundaries must
 * count the same rows the projection groups, or a window's turn arithmetic drifts from its turns.
 */
export function isHiddenEntryType(type: string): boolean {
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
    if (isHiddenEntryType(entry.type)) continue
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
    if (item.message.role === 'user' || item.message.role === 'bashExecution') {
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
  sessionId: string,
  entryId: string,
  pastedText?: PastedTextMetadata
): DisplayUser | undefined {
  if (message.role !== 'user') return undefined
  const content = stripImageHintsFromContent(message.content)
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
    content.forEach((block, index) => {
      const image = isImageBlock(block) ? displayImage(sessionId, entryId, index, block) : null
      if (image) images.push(image)
    })
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

function asAnswer(
  block: Record<string, unknown>,
  sessionId: string,
  entryId: string,
  index: number
): DisplayAnswer | null {
  if (block.type === 'text' && block.text) return { type: 'text', text: block.text as string }
  const image = isImageBlock(block) ? displayImage(sessionId, entryId, index, block) : null
  return image ? { type: 'image', ...image } : null
}

/**
 * The URL the protocol will answer with, paired with the type it will serve: content-type
 * parameters are dropped there, so the display has to report the same type.
 */
function displayImage(
  sessionId: string,
  entryId: string,
  index: number,
  block: ImageBlock
): DisplayImage | null {
  const mimeType = imageMimeType(block.mimeType)
  return mimeType ? { mimeType, url: sessionImageUrl(sessionId, entryId, index) } : null
}

function summarizeChunk(chunk: PathMessage[], sessionId: string): Omit<DisplayTurn, 'id'> {
  const userEntry = chunk[0]
  const userMsg = userEntry.message.role === 'user' ? userEntry.message : undefined
  const rest = userMsg ? chunk.slice(1) : chunk
  const user = userMsg ? displayUser(userMsg, sessionId, userEntry.id, userEntry.pastedText) : undefined
  const bash = userEntry.message.role === 'bashExecution'
    ? {
        command: String(userEntry.message.command ?? ''),
        exitCode: typeof userEntry.message.exitCode === 'number' ? userEntry.message.exitCode : undefined,
        cancelled: userEntry.message.cancelled === true
      }
    : undefined

  let lastAssistant = -1
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].message.role === 'assistant') lastAssistant = i
  }

  let hasProcess = false
  let answer: DisplayAnswer[] = []
  const compactions: DisplayCompaction[] = []
  let errorMessage: string | undefined

  rest.forEach((entry, i) => {
    const message = entry.message
    if (message.role === 'assistant') {
      const isLast = i === lastAssistant
      const trailingIsAnswer =
        isLast && rest.slice(i + 1).every((item) => item.message.role !== 'toolResult')
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
        const item = asAnswer(block, sessionId, entry.id, index)
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

      // Pi keeps a failed attempt in raw history while a retry continues past it. Only the last
      // assistant message is still the turn's outcome, so an answer that recovered has no error.
      errorMessage =
        typeof message.errorMessage === 'string' && message.errorMessage ? message.errorMessage : undefined
      return
    }
    if (
      message.role === 'toolResult' ||
      message.role === 'bashExecution' ||
      message.role === 'custom' ||
      message.role === 'branchSummary'
    ) {
      hasProcess = true
    }
    if (message.role === 'compactionSummary') {
      compactions.push({
        text: typeof message.summary === 'string' ? message.summary : '',
        tokensBefore: typeof message.tokensBefore === 'number' ? message.tokensBefore : 0,
        // Position, not the turn's state: an overflow error earlier in the chunk is followed by a
        // retried answer, and that compaction still belongs inside the work.
        afterAnswer: i > lastAssistant
      })
    }
  })

  const timeOf = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined
  const startedAt =
    timeOf(rest[0]?.message.timestamp) ?? timeOf(userMsg?.timestamp) ?? chunk[userMsg ? 1 : 0]?.persistedAt ?? 0
  const endedAt = chunk[chunk.length - 1]?.persistedAt ?? startedAt

  return {
    user,
    bash,
    userTimestamp: typeof userMsg?.timestamp === 'number' ? userMsg.timestamp : undefined,
    answer,
    compactions,
    errorMessage,
    startedAt,
    endedAt,
    hasProcess
  }
}

export function displayTurnsFromEntries(sessionId: string, entries: SessionEntry[]): DisplayTurn[] {
  return Array.from(groupPath(pathMessages(entries)), (chunk) => ({
    id: chunk[0].id,
    ...summarizeChunk(chunk, sessionId)
  }))
}

function messagesOfGroup(group: PathMessage[]): unknown[] {
  return group.map((item) => withoutImages({
    ...item.message,
    ...(item.message.role === 'user'
      ? { content: stripImageHintsFromContent(item.message.content) }
      : {}),
    persistedAt: item.persistedAt
  }))
}

export function turnMessagesByIdFromEntries(entries: SessionEntry[]): Map<string, unknown[]> {
  const messagesById = new Map<string, unknown[]>()
  for (const group of groupPath(pathMessages(entries))) {
    const messages = messagesOfGroup(group)
    for (const item of group) messagesById.set(item.id, messages)
  }
  return messagesById
}

export function turnMessagesFromEntries(entries: SessionEntry[], turnId: string): unknown[] {
  // A disclosure needs one turn; stop projecting history at that turn's boundary.
  for (const group of groupPath(pathMessages(entries))) {
    if (group.some((item) => item.id === turnId)) return messagesOfGroup(group)
  }
  throw new Error(`Turn not found: ${turnId}`)
}

/** The process panel renders text only, so image bytes never travel with a disclosure. */
function withoutImages(message: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(message.content)) return message
  const content = message.content.filter((block) => !isImageBlock(block))
  return content.length === message.content.length ? message : { ...message, content }
}
