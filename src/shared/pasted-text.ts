import { isFileMentionAt, isFileMentionShape, rangesAreDisjoint, type FileMention } from './file-mentions'

export const PASTED_TEXT_CUSTOM_TYPE = 'pig.pasted-text'
export const PASTED_TEXT_MAX_CHARS = 2000
export const PASTED_TEXT_MAX_LINES = 20

export interface PastedTextAttachmentInput {
  id: string
  text: string
  filename?: string
  byteSize?: number
  start?: number
  end?: number
}

export interface PastedTextAttachment {
  id: string
  text: string
  byteSize: number
  filename?: string
}

export interface PastedTextPromptAttachment extends PastedTextAttachment {
  start: number
  end: number
}

export interface PastedTextMetadataAttachment {
  id: string
  start: number
  end: number
  byteSize: number
  filename?: string
}

export interface PastedTextLegacyMetadata {
  version: 1
  bodyLength: number
  contentLength: number
  contentHash: string
  attachments: PastedTextMetadataAttachment[]
}

export interface PastedTextInlineMetadata {
  version: 2
  contentLength: number
  contentHash: string
  attachments: PastedTextMetadataAttachment[]
  /** Optional so entries written before file chips existed stay valid. */
  mentions?: FileMention[]
}

export type PastedTextInputMetadata = PastedTextLegacyMetadata | PastedTextInlineMetadata

/** The delivered prompt may be expanded or replaced; ranges still belong to the original input. */
export interface PastedTextTransformedMetadata {
  version: 3
  contentLength: number
  contentHash: string
  source: { text: string; metadata: PastedTextInputMetadata }
}

export type PastedTextMetadata = PastedTextInputMetadata | PastedTextTransformedMetadata

export type PastedTextDisplaySegment =
  | { type: 'text'; text: string }
  | { type: 'attachment'; attachment: PastedTextAttachment }
  | { type: 'file'; path: string; text: string }

export interface PastedTextDisplayMetadata {
  body: string
  attachments: PastedTextAttachment[]
  segments?: PastedTextDisplaySegment[]
}

export function pastedTextLineCount(text: string): number {
  return normalizeNewlines(text).split('\n').length
}

/** Clipboard text arrives with CRLF or a lone CR; the editor and the prompt protocol only hold LF. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

export function isLongPastedText(text: string): boolean {
  return Array.from(text).length > PASTED_TEXT_MAX_CHARS || pastedTextLineCount(text) > PASTED_TEXT_MAX_LINES
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

export function formatPastedTextSize(byteSize: number): string {
  if (byteSize < 1024) return `${byteSize} B`
  if (byteSize < 1024 * 1024) {
    const value = byteSize / 1024
    return `${value >= 100 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} KB`
  }
  const value = byteSize / (1024 * 1024)
  return `${value >= 100 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} MB`
}

export function createPastedTextFilename(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('-') + '_' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('-')
  return `pasted_text_${stamp}.txt`
}

export function composePromptText(
  body: string,
  attachments: PastedTextAttachmentInput[]
): string {
  return [body, ...attachments.map((attachment) => attachment.text)]
    .filter((part) => part.length > 0)
    .join('\n\n')
}

export function pastedTextFingerprint(text: string): string {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

export function createPastedTextDeliveryMetadata(
  sourceText: string,
  metadata: PastedTextInputMetadata,
  deliveredText: string
): PastedTextMetadata {
  return sourceText === deliveredText ? metadata : {
    version: 3,
    contentLength: deliveredText.length,
    contentHash: pastedTextFingerprint(deliveredText),
    source: { text: sourceText, metadata }
  }
}

/** Verifies both the persisted message binding and the source whose attachment ranges we restore. */
export function resolvePastedTextMetadata(
  deliveredText: string,
  metadata: PastedTextMetadata
): { text: string; metadata: PastedTextInputMetadata } {
  const source = metadata.version === 3 ? metadata.source : { text: deliveredText, metadata }
  if (
    deliveredText.length !== metadata.contentLength ||
    pastedTextFingerprint(deliveredText) !== metadata.contentHash ||
    (metadata.version === 3 && (
      source.text.length !== source.metadata.contentLength ||
      pastedTextFingerprint(source.text) !== source.metadata.contentHash
    )) ||
    source.metadata.attachments.some((attachment) => attachment.end > source.text.length) ||
    (source.metadata.version === 2 &&
      !(source.metadata.mentions ?? []).every((mention) => isFileMentionAt(source.text, mention)))
  ) {
    throw Object.assign(new Error('Pasted-text metadata does not match its user message or source input'), {
      code: 'PASTED_TEXT_METADATA_MISMATCH'
    })
  }
  return source
}

export function createPastedTextMetadata(
  body: string,
  attachments: PastedTextAttachment[]
): PastedTextLegacyMetadata {
  let offset = body.length
  const metadataAttachments = attachments.map((attachment) => {
    if (offset > 0) offset += 2
    const start = offset
    offset += attachment.text.length
    return {
      id: attachment.id,
      start,
      end: offset,
      byteSize: attachment.byteSize,
      ...(attachment.filename ? { filename: attachment.filename } : {})
    }
  })
  return {
    version: 1,
    bodyLength: body.length,
    contentLength: offset,
    contentHash: pastedTextFingerprint(composePromptText(body, attachments)),
    attachments: metadataAttachments
  }
}

export function createInlinePastedTextMetadata(
  content: string,
  attachments: PastedTextPromptAttachment[],
  mentions: FileMention[] = []
): PastedTextInlineMetadata {
  return {
    version: 2,
    contentLength: content.length,
    contentHash: pastedTextFingerprint(content),
    attachments: attachments.map(({ id, start, end, byteSize, filename }) => ({
      id,
      start,
      end,
      byteSize,
      ...(filename ? { filename } : {})
    })),
    ...(mentions.length > 0
      ? { mentions: [...mentions].sort((a, b) => a.start - b.start).map(({ path, start, end }) => ({ path, start, end })) }
      : {})
  }
}

export function createInlinePastedTextDisplayMetadata(
  content: string,
  attachments: PastedTextPromptAttachment[],
  mentions: FileMention[] = []
): PastedTextDisplayMetadata {
  const sorted = [...attachments].sort((a, b) => a.start - b.start)
  const ranges = [
    ...sorted.map((attachment) => ({ start: attachment.start, end: attachment.end, attachment })),
    ...mentions.map((mention) => ({ start: mention.start, end: mention.end, mention }))
  ].sort((a, b) => a.start - b.start)
  const segments: PastedTextDisplaySegment[] = []
  let cursor = 0
  for (const range of ranges) {
    if (range.start > cursor) segments.push({ type: 'text', text: content.slice(cursor, range.start) })
    const text = content.slice(range.start, range.end)
    if ('mention' in range) {
      segments.push({ type: 'file', path: range.mention.path, text })
    } else {
      segments.push({
        type: 'attachment',
        attachment: {
          id: range.attachment.id,
          text,
          byteSize: range.attachment.byteSize,
          ...(range.attachment.filename ? { filename: range.attachment.filename } : {})
        }
      })
    }
    cursor = range.end
  }
  if (cursor < content.length) segments.push({ type: 'text', text: content.slice(cursor) })
  return {
    body: content,
    attachments: sorted.map(({ id, text, byteSize, filename }) => ({
      id,
      text,
      byteSize,
      ...(filename ? { filename } : {})
    })),
    segments
  }
}

export function stripPastedTextAttachments(
  content: string,
  attachments: PastedTextPromptAttachment[]
): string {
  let cursor = 0
  let result = ''
  for (const attachment of [...attachments].sort((a, b) => a.start - b.start)) {
    result += content.slice(cursor, attachment.start)
    cursor = attachment.end
  }
  return result + content.slice(cursor)
}

export function isInlinePastedTextAttachments(
  content: string,
  attachments: PastedTextAttachment[]
): attachments is PastedTextPromptAttachment[] {
  let cursor = -1
  return attachments.every((attachment) => {
    const start = (attachment as PastedTextPromptAttachment).start
    const end = (attachment as PastedTextPromptAttachment).end
    if (!Number.isInteger(start) || !Number.isInteger(end)) return false
    if (start < 0 || end <= start || end > content.length || start < cursor) return false
    if (content.slice(start, end) !== attachment.text) return false
    cursor = end
    return true
  })
}

function isMetadataAttachment(value: unknown): value is PastedTextMetadataAttachment {
  if (!value || typeof value !== 'object') return false
  const item = value as {
    id?: unknown
    start?: unknown
    end?: unknown
    byteSize?: unknown
    filename?: unknown
  }
  return (
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    typeof item.start === 'number' &&
    Number.isInteger(item.start) &&
    item.start >= 0 &&
    typeof item.end === 'number' &&
    Number.isInteger(item.end) &&
    item.end >= item.start &&
    typeof item.byteSize === 'number' &&
    Number.isFinite(item.byteSize) &&
    item.byteSize >= 0 &&
    (item.filename === undefined || (typeof item.filename === 'string' && item.filename.length > 0))
  )
}

function isPastedTextInputMetadata(value: unknown): value is PastedTextInputMetadata {
  if (!value || typeof value !== 'object') return false
  const metadata = value as {
    version?: unknown
    bodyLength?: unknown
    contentLength?: unknown
    contentHash?: unknown
    attachments?: unknown
  }
  const contentLength = metadata.contentLength
  if (
    typeof contentLength !== 'number' ||
    !Number.isInteger(contentLength) ||
    contentLength < 0 ||
    typeof metadata.contentHash !== 'string' ||
    metadata.contentHash.length === 0 ||
    !Array.isArray(metadata.attachments) ||
    !metadata.attachments.every(isMetadataAttachment)
  ) return false

  if (metadata.version === 1) {
    return (
      typeof metadata.bodyLength === 'number' &&
      Number.isInteger(metadata.bodyLength) &&
      metadata.bodyLength >= 0 &&
      metadata.bodyLength <= contentLength
    )
  }
  if (metadata.version !== 2) return false
  let cursor = -1
  const attachmentsOrdered = metadata.attachments.every((attachment) => {
    if (attachment.start < cursor || attachment.end > contentLength) return false
    cursor = attachment.end
    return true
  })
  const mentions = (metadata as { mentions?: unknown }).mentions
  if (mentions === undefined) return attachmentsOrdered
  return attachmentsOrdered &&
    Array.isArray(mentions) &&
    mentions.every((mention) => isFileMentionShape(mention) && mention.end <= contentLength) &&
    rangesAreDisjoint([...metadata.attachments, ...mentions])
}

export function isPastedTextMetadata(value: unknown): value is PastedTextMetadata {
  if (isPastedTextInputMetadata(value)) return true
  if (!value || typeof value !== 'object') return false
  const metadata = value as Partial<PastedTextTransformedMetadata>
  return metadata.version === 3 &&
    Number.isInteger(metadata.contentLength) && metadata.contentLength! >= 0 &&
    typeof metadata.contentHash === 'string' && metadata.contentHash.length > 0 &&
    Boolean(metadata.source) && typeof metadata.source?.text === 'string' &&
    isPastedTextInputMetadata(metadata.source.metadata)
}
