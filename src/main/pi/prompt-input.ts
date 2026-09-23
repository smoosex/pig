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
    metadata,
    displayMetadata,
    images: attachments,
    namingText: namingText.trim() || (textAttachments.length > 0 ? t('naming.pastedText') : t('naming.imageOnly'))
  }
}
