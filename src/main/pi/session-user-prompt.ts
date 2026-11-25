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
import { formatExpandedSkillPreview, parseExpandedSkillPrompt, skillMentionText } from '../../shared/skill-mentions'

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
  const expandedLegacySkill = !source ? parseExpandedSkillPrompt(deliveredText) : null
  const text = source?.text ?? (expandedLegacySkill ? formatExpandedSkillPreview(expandedLegacySkill) : deliveredText)
  const textAttachments = source?.metadata.attachments.map((attachment) => ({
    id: attachment.id,
    text: text.slice(attachment.start, attachment.end),
    byteSize: attachment.byteSize,
    start: attachment.start,
    end: attachment.end,
    ...(attachment.filename ? { filename: attachment.filename } : {})
  }))
  const fileMentions = source?.metadata.version === 2 ? source.metadata.mentions : undefined
  const skillMentions = source?.metadata.version === 2
    ? source.metadata.skillMentions
    : expandedLegacySkill
      ? [{ name: expandedLegacySkill.name, start: 0, end: skillMentionText(expandedLegacySkill.name).length }]
      : undefined

  return {
    parentId: pastedTextEntry ? pastedTextEntry.parentId : entry.parentId,
    prompt: {
      text,
      images,
      ...(textAttachments ? { textAttachments } : {}),
      ...(fileMentions?.length ? { fileMentions } : {}),
      ...(skillMentions?.length ? { skillMentions } : {})
    }
  }
}
