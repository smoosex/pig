/**
 * Converts the editor document into Pi's prompt text and pasted-text ranges.
 * Attachment offsets use the same UTF-16 string indices as the shared protocol;
 * serialization must add real newlines before calculating the next range.
 */
import type { JSONContent } from '@tiptap/core'
import { createInlinePastedTextDisplayMetadata, utf8ByteLength, type PastedTextPromptAttachment } from '../../../../shared/pasted-text'
import type { PigUserMessage } from '../../pi/types'

export const EMPTY_COMPOSER: SerializedComposer = { text: '', attachments: [] }

export function textToComposerDocument(text: string): JSONContent {
  return {
    type: 'doc',
    content: text.split('\n').map((line) =>
      line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' }
    )
  }
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
