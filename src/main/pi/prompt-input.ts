/**
 * Normalize renderer input once for the model, JSONL metadata, and display.
 * Inline attachment offsets refer to the original prompt, before any text is composed.
 */
import {
  composePromptText,
  createInlinePastedTextDisplayMetadata,
  createInlinePastedTextMetadata,
  createPastedTextMetadata,
  isInlinePastedTextAttachments,
  stripPastedTextAttachments,
  utf8ByteLength,
  type PastedTextAttachment,
  type PastedTextAttachmentInput,
  type PastedTextDisplayMetadata,
  type PastedTextPromptAttachment
} from '../../shared/pasted-text'
import { isFileMentionAt, isFileMentionShape, rangesAreDisjoint, type FileMention } from '../../shared/file-mentions'
import { isSkillMentionAt, isSkillMentionShape, type SkillMention } from '../../shared/skill-mentions'
import { isImagePayload } from '../../shared/session-images'
import { t } from '../i18n'

/** A `data:` URL puts the payload after its comma; the session file always stores raw base64. */
function stripDataUrl(data: string): string {
  if (!data.startsWith('data:')) return data
  const comma = data.indexOf(',')
  return comma === -1 ? '' : data.slice(comma + 1)
}

export interface SessionPromptInput {
  text: unknown
  images?: unknown
  textAttachments?: unknown
  fileMentions?: unknown
  skillMentions?: unknown
  streamingBehavior?: unknown
}

function normalizeTextAttachments(value: unknown): PastedTextAttachment[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): PastedTextAttachment[] => {
    if (!item || typeof item !== 'object') return []
    const input = item as Partial<PastedTextAttachmentInput>
    if (typeof input.text !== 'string' || input.text.length === 0) return []
    return [{
      id: typeof input.id === 'string' && input.id.length > 0 ? input.id : crypto.randomUUID(),
      text: input.text,
      byteSize: utf8ByteLength(input.text),
      ...(typeof input.filename === 'string' && input.filename.length > 0 ? { filename: input.filename } : {}),
      ...(Number.isInteger(input.start) && Number.isInteger(input.end)
        ? { start: input.start, end: input.end }
        : {})
    }]
  })
}

/** Mentions are only ever produced by the composer, so a range that does not fit the text is a bug. */
function normalizeFileMentions(body: string, value: unknown, attachments: PastedTextPromptAttachment[]): FileMention[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every(isFileMentionShape)) throw new Error('Invalid file mentions')
  const mentions = value.map(({ path, start, end }) => ({ path, start, end }))
  const ranges = [...mentions, ...attachments]
  if (!mentions.every((mention) => isFileMentionAt(body, mention)) || !rangesAreDisjoint(ranges)) {
    throw new Error('File mentions do not match the prompt text')
  }
  return mentions
}

function normalizeSkillMentions(
  body: string,
  value: unknown,
  existingRanges: Array<{ start: number; end: number }>
): SkillMention[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every(isSkillMentionShape)) throw new Error('Invalid skill mentions')
  const mentions = value.map(({ name, start, end }) => ({ name, start, end }))
  if (!mentions.every((mention) => isSkillMentionAt(body, mention)) || !rangesAreDisjoint([...existingRanges, ...mentions])) {
    throw new Error('Skill mentions do not match the prompt text')
  }
  return mentions
}

export function normalizeSessionPrompt(input: SessionPromptInput) {
  const body = typeof input.text === 'string' ? input.text : ''
  const textAttachments = normalizeTextAttachments(input.textAttachments)
  const inlineAttachments = isInlinePastedTextAttachments(body, textAttachments)
    ? textAttachments
    : undefined
  // A legacy prompt appends its attachments after the body; mentions only exist beside inline ranges.
  const mentions = inlineAttachments ? normalizeFileMentions(body, input.fileMentions, inlineAttachments) : []
  const skillMentions = inlineAttachments ? normalizeSkillMentions(body, input.skillMentions, [...inlineAttachments, ...mentions]) : []
  const modelText = inlineAttachments ? body : composePromptText(body, textAttachments)
  // Pi's skill expander splits on ASCII space; insert one for delivery if the user typed directly past a leading chip.
  const leadingSkill = skillMentions.find((mention) => mention.start === 0)
  const piModelText =
    leadingSkill && modelText.length > leadingSkill.end && modelText[leadingSkill.end] !== ' '
      ? `${modelText.slice(0, leadingSkill.end)} ${modelText.slice(leadingSkill.end)}`
      : modelText
  const hasRanges = textAttachments.length > 0 || mentions.length > 0 || skillMentions.length > 0
  const metadata = hasRanges
    ? inlineAttachments
      ? createInlinePastedTextMetadata(modelText, inlineAttachments, mentions, skillMentions)
      : createPastedTextMetadata(body, textAttachments)
    : undefined
  const displayMetadata: PastedTextDisplayMetadata | undefined = hasRanges
    ? inlineAttachments
      ? createInlinePastedTextDisplayMetadata(modelText, inlineAttachments, mentions, skillMentions)
      : { body, attachments: textAttachments }
    : undefined
  const attachments = (Array.isArray(input.images) ? input.images : []).flatMap((image) => {
    const { mimeType, data } = (image ?? {}) as { mimeType?: unknown; data?: unknown }
    if (typeof data !== 'string') return []
    // The payload is validated as it will be stored, so nothing the reader cannot decode is written.
    const payload = { mimeType, data: stripDataUrl(data) }
    return isImagePayload(payload)
      ? [{ type: 'image' as const, mimeType: payload.mimeType, data: payload.data }]
      : []
  })

  const namingText = inlineAttachments ? stripPastedTextAttachments(body, inlineAttachments) : body
  return {
    modelText,
    piModelText,
    skillMentions,
    metadata,
    displayMetadata,
    images: attachments,
    namingText: namingText.trim() || (textAttachments.length > 0 ? t('naming.pastedText') : t('naming.imageOnly'))
  }
}
