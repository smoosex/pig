/**
 * Converts the editor document into Pi's prompt text and pasted-text ranges.
 * Attachment offsets use the same UTF-16 string indices as the shared protocol;
 * serialization must add real newlines before calculating the next range.
 */
import type { JSONContent } from '@tiptap/core'
import { createInlinePastedTextDisplayMetadata, isInlinePastedTextAttachments, normalizeNewlines, utf8ByteLength, type PastedTextAttachmentInput, type PastedTextPromptAttachment } from '../../../../shared/pasted-text'
import { fileMentionText, isFileMentionAt, type FileMention } from '../../../../shared/file-mentions'
import type { PigUserMessage } from '../../pi/types'
import { tabMentionText, type TabMention } from './tab-mentions'

export const EMPTY_COMPOSER: SerializedComposer = { text: '', attachments: [], mentions: [] }

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
  attachments: PastedTextAttachmentInput[] = [],
  mentions: FileMention[] = []
): JSONContent {
  const normalizedText = normalizeNewlines(text)
  if (attachments.length === 0 && mentions.length === 0) return textToComposerDocument(normalizedText)
  const normalized = attachments.map((attachment) => ({
    ...attachment,
    start: attachment.start,
    end: attachment.end,
    byteSize: attachment.byteSize ?? utf8ByteLength(attachment.text)
  })).sort((left, right) => (left.start ?? -1) - (right.start ?? -1))
  if (!isInlinePastedTextAttachments(normalizedText, normalized)) {
    throw new Error('Invalid restored pasted-text attachment ranges')
  }
  if (!mentions.every((mention) => isFileMentionAt(normalizedText, mention))) {
    throw new Error('Invalid restored file mention ranges')
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
  const ranges = [
    ...normalized.map((attachment) => ({ start: attachment.start!, end: attachment.end!, node: {
      type: 'pastedText',
      attrs: {
        id: attachment.id,
        text: attachment.text,
        byteSize: attachment.byteSize,
        ...(attachment.filename ? { filename: attachment.filename } : {})
      }
    } })),
    ...mentions.map((mention) => ({ start: mention.start, end: mention.end, node: {
      type: 'fileMention',
      attrs: { path: mention.path }
    } }))
  ].sort((left, right) => left.start - right.start)
  let cursor = 0
  for (const range of ranges) {
    appendText(normalizedText.slice(cursor, range.start))
    const paragraph = paragraphs[paragraphs.length - 1]
    paragraph.content = [...(paragraph.content ?? []), range.node]
    cursor = range.end
  }
  appendText(normalizedText.slice(cursor))
  return { type: 'doc', content: paragraphs }
}

export type SerializedComposer = {
  text: string
  attachments: PastedTextPromptAttachment[]
  mentions: FileMention[]
}

/**
 * Trims surrounding whitespace the way a plain prompt is trimmed, shifting the ranges with it. Whitespace
 * a range owns (a pasted block that starts with indentation) stays, so no range is cut.
 */
export function trimComposer(serialized: SerializedComposer): SerializedComposer {
  const { text, attachments, mentions } = serialized
  const ranges = [...attachments, ...mentions]
  const leading = Math.min(text.length - text.trimStart().length, ...ranges.map((range) => range.start))
  const end = Math.max(text.trimEnd().length, ...ranges.map((range) => range.end))
  if (leading === 0 && end === text.length) return serialized
  return {
    text: text.slice(leading, Math.max(leading, end)),
    attachments: attachments.map((attachment) => ({ ...attachment, start: attachment.start - leading, end: attachment.end - leading })),
    mentions: mentions.map((mention) => ({ ...mention, start: mention.start - leading, end: mention.end - leading }))
  }
}

export function composerUserMessage(
  text: string,
  images: Array<{ mimeType: string; data: string }>,
  attachments: PastedTextPromptAttachment[],
  mentions: FileMention[] = []
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
    ...(attachments.length > 0 || mentions.length > 0
      ? { pastedText: createInlinePastedTextDisplayMetadata(text, attachments, mentions) }
      : {})
  }
}

export function serializeComposerDocument(json: JSONContent): SerializedComposer {
  let text = ''
  const attachments: PastedTextPromptAttachment[] = []
  const mentions: FileMention[] = []

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
    if (node.type === 'tabMention') {
      text += tabMentionText(node.attrs as TabMention)
      return
    }
    if (node.type === 'fileMention') {
      const path = String(node.attrs?.path ?? '')
      const start = text.length
      text += fileMentionText(path)
      mentions.push({ path, start, end: text.length })
      return
    }
    for (const child of node.content ?? []) append(child)
  }

  for (const [index, node] of (json.content ?? []).entries()) {
    if (index > 0) text += '\n'
    append(node)
  }
  return { text, attachments, mentions }
}
