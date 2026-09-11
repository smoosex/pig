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
  type PastedTextDisplayMetadata
} from '../../shared/pasted-text'

export interface SessionPromptInput {
  text: unknown
  images?: unknown
  textAttachments?: unknown
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

export function normalizeSessionPrompt(input: SessionPromptInput) {
  const body = typeof input.text === 'string' ? input.text : ''
  const textAttachments = normalizeTextAttachments(input.textAttachments)
  const inlineAttachments = textAttachments.length > 0 && isInlinePastedTextAttachments(body, textAttachments)
    ? textAttachments
    : undefined
  const modelText = inlineAttachments ? body : composePromptText(body, textAttachments)
  const metadata = textAttachments.length > 0
    ? inlineAttachments
      ? createInlinePastedTextMetadata(modelText, inlineAttachments)
      : createPastedTextMetadata(body, textAttachments)
    : undefined
  const displayMetadata: PastedTextDisplayMetadata | undefined = textAttachments.length > 0
    ? inlineAttachments
      ? createInlinePastedTextDisplayMetadata(modelText, inlineAttachments)
      : { body, attachments: textAttachments }
    : undefined
  const attachments = (Array.isArray(input.images) ? input.images : [])
    .filter(
      (image) =>
        typeof image?.mimeType === 'string' &&
        image.mimeType.startsWith('image/') &&
        typeof image?.data === 'string' &&
        image.data.length > 0
    )
    .map((image) => ({
      type: 'image' as const,
      mimeType: image.mimeType,
      data: image.data.includes(',') ? image.data.slice(image.data.indexOf(',') + 1) : image.data
    }))

  const namingText = inlineAttachments ? stripPastedTextAttachments(body, inlineAttachments) : body
  return {
    modelText,
    metadata,
    displayMetadata,
    images: attachments,
    namingText: namingText.trim() || (textAttachments.length > 0 ? 'Pasted text' : '用户仅发送了图片，未附文字。')
  }
}
