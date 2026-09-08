import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { sessionManagerFor } from './session-registry'

export type DisplayAnswer =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }

export interface DisplayUser {
  text: string
  images: { mimeType: string; data: string }[]
}

export interface DisplayTurn {
  id: string
  user?: DisplayUser
  answer: DisplayAnswer[]
  errorMessage?: string
  startedAt: number
  endedAt: number
  hasProcess: boolean
}

export interface DisplayTurnsResult {
  leafId: string | null
  turns: DisplayTurn[]
}

type PathMessage = { id: string; message: Record<string, unknown>; persistedAt: number }

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

function pathMessages(sessionId: string): PathMessage[] {
  const items: PathMessage[] = []
  for (const raw of sessionManagerFor(sessionId).getBranch()) {
    const entry = raw as SessionEntry
    if (isHidden(entry.type)) continue
    const fallback = entryTimestamp(entry)
    if (entry.type === 'message') {
      items.push({
        id: entry.id,
        persistedAt: fallback,
        message: withTimestamp(entry.message as unknown as Record<string, unknown>, fallback)
      })
      continue
    }
    if (entry.type === 'custom_message') {
      if (entry.display === false) continue
      items.push({
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
      })
      continue
    }
    if (entry.type === 'compaction') {
      items.push({
        id: entry.id,
        persistedAt: fallback,
        message: {
          role: 'compactionSummary',
          summary: entry.summary,
          tokensBefore: entry.tokensBefore,
          timestamp: fallback
        }
      })
      continue
    }
    if (entry.type === 'branch_summary') {
      items.push({
        id: entry.id,
        persistedAt: fallback,
        message: {
          role: 'branchSummary',
          summary: entry.summary,
          fromId: entry.fromId,
          timestamp: fallback
        }
      })
    }
  }
  return items
}

function groupPath(items: PathMessage[]): PathMessage[][] {
  const groups: PathMessage[][] = []
  let current: PathMessage[] = []
  for (const item of items) {
    if (item.message.role === 'user') {
      if (current.length > 0) groups.push(current)
      current = [item]
    } else {
      current.push(item)
    }
  }
  if (current.length > 0) groups.push(current)
  return groups
}

function displayUser(message: Record<string, unknown>): DisplayUser | undefined {
  if (message.role !== 'user') return undefined
  const content = message.content
  if (typeof content === 'string') return { text: content, images: [] }
  if (!Array.isArray(content)) return { text: '', images: [] }
  const text: string[] = []
  const images: DisplayUser['images'] = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') text.push(block.text)
    if (
      block?.type === 'image' &&
      typeof block.mimeType === 'string' &&
      typeof block.data === 'string'
    ) {
      images.push({ mimeType: block.mimeType, data: block.data })
    }
  }
  return { text: text.join(''), images }
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
  const userMsg = messages[0]?.role === 'user' ? messages[0] : undefined
  const rest = userMsg ? messages.slice(1) : messages
  const user = userMsg ? displayUser(userMsg) : undefined

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

export function getDisplayTurns(sessionId: string): DisplayTurnsResult {
  const sessionManager = sessionManagerFor(sessionId)
  const turns = groupPath(pathMessages(sessionId)).map((chunk) => ({
    id: chunk[0].id,
    ...summarizeChunk(chunk)
  }))
  return { leafId: sessionManager.getLeafId(), turns }
}

export function getTurnMessages(sessionId: string, turnId: string): unknown[] {
  const chunk = groupPath(pathMessages(sessionId)).find(
    (group) => group[0].id === turnId || group.some((item) => item.id === turnId)
  )
  if (!chunk) throw new Error(`Turn not found: ${turnId}`)
  return chunk.map((item) => ({ ...item.message, persistedAt: item.persistedAt }))
}
