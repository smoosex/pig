/**
 * Converts the editor document into Pi's prompt text and pasted-text ranges.
 * Attachment offsets use the same UTF-16 string indices as the shared protocol;
 * serialization must add real newlines before calculating the next range.
 */
import type { JSONContent } from '@tiptap/core'
import { createInlinePastedTextDisplayMetadata, isInlinePastedTextAttachments, normalizeNewlines, utf8ByteLength, type PastedTextAttachmentInput, type PastedTextPromptAttachment } from '../../../../shared/pasted-text'
import type { PigUserMessage } from '../../pi/types'

export const EMPTY_COMPOSER: SerializedComposer = { text: '', attachments: [] }

export function textToComposerDocument(text: string): JSONContent {
  return {
    type: 'doc',
    content: normalizeNewlines(text).split('\n').map((line) =>
      line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' }
    )
  }
}

export function restoredPromptToComposerDocument(
  text: string,
  attachments: PastedTextAttachmentInput[] = []
): JSONContent {
  const normalizedText = normalizeNewlines(text)
  if (attachments.length === 0) return textToComposerDocument(normalizedText)
  const normalized = attachments.map((attachment) => ({
    ...attachment,
    start: attachment.start,
    end: attachment.end,
    byteSize: attachment.byteSize ?? utf8ByteLength(attachment.text)
  })).sort((left, right) => (left.start ?? -1) - (right.start ?? -1))
  if (!isInlinePastedTextAttachments(normalizedText, normalized)) {
    throw new Error('Invalid restored pasted-text attachment ranges')
  }

  const paragraphs: JSONContent[] = [{ type: 'paragraph' }]
  const appendText = (value: string) => {
    value.split('\n').forEach((part, index) => {
      if (index > 0) paragraphs.push({ type: 'paragraph' })
      if (!part) return
      const paragraph = paragraphs[paragraphs.length - 1]
      paragraph.content = [...(paragraph.content ?? []), { type: 'text', text: part }]
    })
  }
  let cursor = 0
  for (const attachment of normalized) {
    appendText(normalizedText.slice(cursor, attachment.start))
    const paragraph = paragraphs[paragraphs.length - 1]
    paragraph.content = [...(paragraph.content ?? []), {
      type: 'pastedText',
      attrs: {
        id: attachment.id,
        text: attachment.text,
        byteSize: attachment.byteSize,
        ...(attachment.filename ? { filename: attachment.filename } : {})
      }
    }]
    cursor = attachment.end
  }
  appendText(normalizedText.slice(cursor))
  return { type: 'doc', content: paragraphs }
}

export type SerializedComposer = {
  text: string
  attachments: PastedTextPromptAttachment[]
}

export function composerUserMessage(
  text: string,
  images: Array<{ mimeType: string; data: string }>,
  attachments: PastedTextPromptAttachment[]
): PigUserMessage {
  const imageBlocks = images.map((image) => ({
    type: 'image' as const,
    mimeType: image.mimeType,
    data: image.data
  }))
  const content =
    imageBlocks.length > 0
      ? [...(text ? [{ type: 'text' as const, text }] : []), ...imageBlocks]
      : text
  return {
    role: 'user',
    content,
    timestamp: Date.now(),
    ...(attachments.length > 0
      ? { pastedText: createInlinePastedTextDisplayMetadata(text, attachments) }
      : {})
  }
}

export function serializeComposerDocument(json: JSONContent): SerializedComposer {
  let text = ''
  const attachments: PastedTextPromptAttachment[] = []

  const append = (node: JSONContent) => {
    if (node.type === 'text') {
      text += node.text ?? ''
      return
    }
    if (node.type === 'hardBreak') {
      text += '\n'
      return
    }
    if (node.type === 'pastedText') {
      const attrs = node.attrs ?? {}
      const pastedText = String(attrs.text ?? '')
      const start = text.length
      text += pastedText
      attachments.push({
        id: String(attrs.id ?? crypto.randomUUID()),
        text: pastedText,
        byteSize: Number(attrs.byteSize) || utf8ByteLength(pastedText),
        start,
        end: text.length,
        ...(attrs.filename ? { filename: String(attrs.filename) } : {})
      })
      return
    }
    for (const child of node.content ?? []) append(child)
  }

  for (const [index, node] of (json.content ?? []).entries()) {
    if (index > 0) text += '\n'
    append(node)
  }
  return { text, attachments }
}
