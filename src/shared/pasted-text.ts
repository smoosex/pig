export const PASTED_TEXT_CUSTOM_TYPE = 'pig.pasted-text'
export const PASTED_TEXT_MAX_CHARS = 2000
export const PASTED_TEXT_MAX_LINES = 20

export interface PastedTextAttachmentInput {
  id: string
  text: string
}

export interface PastedTextAttachment extends PastedTextAttachmentInput {
  byteSize: number
}

export interface PastedTextMetadataAttachment {
  id: string
  start: number
  end: number
  byteSize: number
}

export interface PastedTextMetadata {
  version: 1
  bodyLength: number
  contentLength: number
  contentHash: string
  attachments: PastedTextMetadataAttachment[]
}

export interface PastedTextDisplayMetadata {
  body: string
  attachments: PastedTextAttachment[]
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
): PastedTextMetadata {
  let offset = body.length
  const metadataAttachments = attachments.map((attachment) => {
    if (offset > 0) offset += 2
    const start = offset
    offset += attachment.text.length
    return {
      id: attachment.id,
      start,
      end: offset,
      byteSize: attachment.byteSize
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

export function isPastedTextMetadata(value: unknown): value is PastedTextMetadata {
  if (!value || typeof value !== 'object') return false
  const metadata = value as {
    version?: unknown
    bodyLength?: unknown
    contentLength?: unknown
    contentHash?: unknown
    attachments?: unknown
  }
  const bodyLength = metadata.bodyLength
  const contentLength = metadata.contentLength
  if (
    metadata.version !== 1 ||
    typeof bodyLength !== 'number' ||
    !Number.isInteger(bodyLength) ||
    bodyLength < 0 ||
    typeof contentLength !== 'number' ||
    !Number.isInteger(contentLength) ||
    contentLength < bodyLength ||
    typeof metadata.contentHash !== 'string' ||
    metadata.contentHash.length === 0 ||
    !Array.isArray(metadata.attachments)
  ) {
    return false
  }
  return metadata.attachments.every((attachment) => {
    if (!attachment || typeof attachment !== 'object') return false
    const item = attachment as { id?: unknown; start?: unknown; end?: unknown; byteSize?: unknown }
    return (
      typeof item.id === 'string' &&
      item.id.length > 0 &&
      typeof item.start === 'number' &&
      Number.isInteger(item.start) &&
      item.start >= bodyLength &&
      typeof item.end === 'number' &&
      Number.isInteger(item.end) &&
      item.end >= item.start &&
      item.end <= contentLength &&
      typeof item.byteSize === 'number' &&
      Number.isFinite(item.byteSize) &&
      item.byteSize >= 0
    )
  })
}
