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
}

export type PastedTextMetadata = PastedTextLegacyMetadata | PastedTextInlineMetadata

export type PastedTextDisplaySegment =
  | { type: 'text'; text: string }
  | { type: 'attachment'; attachment: PastedTextAttachment }

export interface PastedTextDisplayMetadata {
  body: string
  attachments: PastedTextAttachment[]
  segments?: PastedTextDisplaySegment[]
}

export function pastedTextLineCount(text: string): number {
  return text.split(/\r\n|\r|\n/).length
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
  attachments: PastedTextPromptAttachment[]
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
    }))
  }
}

export function createInlinePastedTextDisplayMetadata(
  content: string,
  attachments: PastedTextPromptAttachment[]
): PastedTextDisplayMetadata {
  const sorted = [...attachments].sort((a, b) => a.start - b.start)
  const segments: PastedTextDisplaySegment[] = []
  let cursor = 0
  for (const attachment of sorted) {
    if (attachment.start > cursor) segments.push({ type: 'text', text: content.slice(cursor, attachment.start) })
    segments.push({
      type: 'attachment',
      attachment: {
        id: attachment.id,
        text: content.slice(attachment.start, attachment.end),
        byteSize: attachment.byteSize,
        ...(attachment.filename ? { filename: attachment.filename } : {})
      }
    })
    cursor = attachment.end
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

export function isPastedTextMetadata(value: unknown): value is PastedTextMetadata {
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
  return metadata.attachments.every((attachment) => {
    if (attachment.start < cursor || attachment.end > contentLength) return false
    cursor = attachment.end
    return true
  })
}
