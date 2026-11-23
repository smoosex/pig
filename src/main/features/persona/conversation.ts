/* Project only completed visible exchanges; tools, thinking and hidden custom messages never enter the observer. */
import type { ExtensionContext, ProjectedSessionEntry, SessionEntry } from '@earendil-works/pi-coding-agent'
import { stripImageHintsFromContent } from '../../../shared/image-hints'
import { isPastedTextMetadata, PASTED_TEXT_CUSTOM_TYPE, resolvePastedTextMetadata } from '../../../shared/pasted-text'
import { stripHiddenBotTags } from '../../bot/projection'
import type { MoodObserverRound } from './observer'

type Content = string | readonly { type: string; text?: string }[]
function text(content: Content, separator = ''): string {
  return typeof content === 'string' ? content : content.filter(block => block.type === 'text').map(block => block.text ?? '').join(separator)
}

function userText(entry: SessionEntry, delivered: string, manager: Pick<ExtensionContext['sessionManager'], 'getEntry'>): string {
  const parent = entry.parentId ? manager.getEntry(entry.parentId) : undefined
  if (parent?.type !== 'custom' || parent.customType !== PASTED_TEXT_CUSTOM_TYPE) return delivered
  if (!isPastedTextMetadata(parent.data)) throw new Error('Invalid pasted-text metadata for mood observer')
  // Context edits own their projected replacement; original attachment ranges cannot be applied to it.
  if (entry.type !== 'message' || entry.message.role !== 'user' || text(stripImageHintsFromContent(entry.message.content)) !== delivered) return delivered
  const source = resolvePastedTextMetadata(delivered, parent.data)
  let result = ''
  let cursor = 0
  for (const attachment of [...source.metadata.attachments].sort((a, b) => a.start - b.start)) {
    result += source.text.slice(cursor, attachment.start) + '\n[Pasted attachment omitted]\n'
    cursor = attachment.end
  }
  return result + source.text.slice(cursor)
}

function isBotSession(
  entries: readonly ProjectedSessionEntry[],
  manager: { getSessionId?: () => string },
): boolean {
  if (manager.getSessionId?.().startsWith('bot-')) return true
  return entries.some(({ messages }) => messages.some(message =>
    (message.role === 'system' && (message as { sections?: Record<string, unknown> }).sections?.bot !== undefined) ||
    (message.role === 'assistant' && message.content.some(block => block.type === 'toolCall' && block.name === 'send_message'))
  ))
}

export function completedMoodRounds(
  entries: readonly ProjectedSessionEntry[],
  manager: Pick<ExtensionContext['sessionManager'], 'getEntry'> & { getSessionId?: () => string },
): MoodObserverRound[] {
  if (isBotSession(entries, manager)) {
    return completedBotMoodRounds(entries, manager)
  }
  const rounds: MoodObserverRound[] = []
  let users: { id: string; user: string }[] = []
  for (const { sourceEntry, messages } of entries) {
    for (const message of messages) {
      if (message.role === 'user') {
        const delivered = text(stripImageHintsFromContent(message.content))
        users.push({ id: sourceEntry.id, user: userText(sourceEntry, delivered, manager) })
      } else if (message.role === 'assistant' && (message.stopReason === 'aborted' || message.stopReason === 'error')) {
        // The user's words still count as evidence; the missing reply is marked, never paired with a later one.
        const assistant = message.stopReason === 'aborted' ? '[Reply interrupted by the user]' : '[Reply failed]'
        for (const user of users) rounds.push({ ...user, assistant })
        users = []
      } else if (message.role === 'assistant' && message.stopReason === 'stop' && !message.content.some(block => block.type === 'toolCall')) {
        const assistant = text(message.content, '\n')
        if (!assistant.trim()) continue
        for (const user of users) rounds.push({ ...user, assistant })
        users = []
      }
    }
  }
  return rounds
}

/**
 * In the Bot main session, plain assistant text is private internal reasoning and `send_message` tool calls
 * are the sole user-visible channel. Pair clean user inputs only with settled `send_message` bubbles.
 */
function completedBotMoodRounds(
  entries: readonly ProjectedSessionEntry[],
  manager: Pick<ExtensionContext['sessionManager'], 'getEntry'>,
): MoodObserverRound[] {
  const rounds: MoodObserverRound[] = []
  let users: { id: string; user: string }[] = []
  const pendingSendCalls = new Map<string, string>()
  let visibleReplies: string[] = []
  let waitingReprompt = false
  let reprompted = false

  const resetTurn = () => {
    users = []
    visibleReplies = []
    pendingSendCalls.clear()
    waitingReprompt = false
    reprompted = false
  }

  for (const { sourceEntry, messages } of entries) {
    for (const message of messages) {
      if (message.role === 'user') {
        const delivered = text(stripImageHintsFromContent(message.content))
        const cleaned = stripHiddenBotTags(userText(sourceEntry, delivered, manager))
        if (!cleaned) {
          if (users.length > 0 && waitingReprompt) {
            reprompted = true
          } else {
            visibleReplies = []
            pendingSendCalls.clear()
          }
          continue
        }
        if (users.length > 0) {
          if (visibleReplies.length > 0) {
            const assistant = visibleReplies.join('\n\n')
            for (const user of users) rounds.push({ ...user, assistant })
            resetTurn()
          } else if (waitingReprompt) {
            for (const user of users) rounds.push({ ...user, assistant: '[Reply failed]' })
            resetTurn()
          }
        }
        users.push({ id: sourceEntry.id, user: cleaned })
      } else if (message.role === 'assistant') {
        for (const block of message.content) {
          if (block.type === 'toolCall' && block.name === 'send_message' && typeof block.id === 'string') {
            const rawContent = block.arguments && typeof block.arguments === 'object'
              ? (block.arguments as { content?: unknown }).content
              : undefined
            if (typeof rawContent === 'string') {
              const cleanedReply = stripHiddenBotTags(rawContent)
              if (cleanedReply) pendingSendCalls.set(block.id, cleanedReply)
            }
          }
        }
        if (message.stopReason === 'aborted' || message.stopReason === 'error') {
          if (users.length > 0) {
            const assistant = visibleReplies.length > 0
              ? visibleReplies.join('\n\n')
              : (message.stopReason === 'aborted' ? '[Reply interrupted by the user]' : '[Reply failed]')
            for (const user of users) rounds.push({ ...user, assistant })
          }
          resetTurn()
        } else if (message.stopReason === 'stop' && !message.content.some(block => block.type === 'toolCall')) {
          if (users.length === 0) {
            resetTurn()
          } else if (visibleReplies.length > 0) {
            const assistant = visibleReplies.join('\n\n')
            for (const user of users) rounds.push({ ...user, assistant })
            resetTurn()
          } else if (reprompted) {
            for (const user of users) rounds.push({ ...user, assistant: '[Reply failed]' })
            resetTurn()
          } else {
            waitingReprompt = true
          }
        }
      } else if (message.role === 'toolResult' && message.toolName === 'send_message') {
        const content = pendingSendCalls.get(message.toolCallId)
        pendingSendCalls.delete(message.toolCallId)
        if (content && !message.isError && users.length > 0) {
          visibleReplies.push(content)
        }
      }
    }
  }
  return rounds
}
