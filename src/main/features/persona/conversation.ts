/* Project only completed visible exchanges; tools, thinking and hidden custom messages never enter the observer. */
import type { ExtensionContext, ProjectedSessionEntry, SessionEntry } from '@earendil-works/pi-coding-agent'
import { stripImageHintsFromContent } from '../../../shared/image-hints'
import { isPastedTextMetadata, PASTED_TEXT_CUSTOM_TYPE, resolvePastedTextMetadata } from '../../../shared/pasted-text'
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

export function completedMoodRounds(
  entries: readonly ProjectedSessionEntry[],
  manager: Pick<ExtensionContext['sessionManager'], 'getEntry'>,
): MoodObserverRound[] {
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
