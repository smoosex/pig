/** Reconstructs a user entry as editable Pig input and identifies the branch point before it. */
import type { SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent'
import type { RestoredSessionPrompt } from '../../shared/api'
import { stripImageHintsFromContent } from '../../shared/image-hints'
import {
  isPastedTextMetadata,
  resolvePastedTextMetadata,
  PASTED_TEXT_CUSTOM_TYPE,
  type PastedTextMetadata
} from '../../shared/pasted-text'

export function restoreSessionUserPrompt(
  manager: SessionManager,
  entry: SessionEntry
): { parentId: string | null; prompt: RestoredSessionPrompt } {
  if (entry.type !== 'message' || entry.message.role !== 'user') {
    throw new Error(`Entry is not a user message: ${entry.id}`)
  }

  const content = stripImageHintsFromContent(entry.message.content)
  const deliveredText = typeof content === 'string'
    ? content
    : content.filter((block) => block.type === 'text').map((block) => block.text).join('')
  const images = typeof content === 'string'
    ? []
    : content.flatMap((block) => block.type === 'image'
      ? [{ mimeType: block.mimeType, data: block.data }]
      : [])

  const parent = entry.parentId ? manager.getEntry(entry.parentId) : undefined
  const pastedTextEntry = parent?.type === 'custom' && parent.customType === PASTED_TEXT_CUSTOM_TYPE
    ? parent
    : undefined
  let metadata: PastedTextMetadata | undefined
  if (pastedTextEntry) {
    if (!isPastedTextMetadata(pastedTextEntry.data)) {
      throw Object.assign(new Error(`Invalid pasted-text metadata before user message: ${entry.id}`), {
        code: 'PASTED_TEXT_METADATA_INVALID'
      })
    }
    metadata = pastedTextEntry.data
  }
  const source = metadata ? resolvePastedTextMetadata(deliveredText, metadata) : undefined
  const text = source?.text ?? deliveredText
  const textAttachments = source?.metadata.attachments.map((attachment) => ({
    id: attachment.id,
    text: text.slice(attachment.start, attachment.end),
    byteSize: attachment.byteSize,
    start: attachment.start,
    end: attachment.end,
    ...(attachment.filename ? { filename: attachment.filename } : {})
  }))
  const fileMentions = source?.metadata.version === 2 ? source.metadata.mentions : undefined

  return {
    parentId: pastedTextEntry ? pastedTextEntry.parentId : entry.parentId,
    prompt: {
      text,
      images,
      ...(textAttachments ? { textAttachments } : {}),
      ...(fileMentions?.length ? { fileMentions } : {})
    }
  }
}
