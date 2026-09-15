/**
 * URL scheme that serves images persisted in session entries.
 *
 * Turn payloads must stay small, so the display projection ships image URLs instead of base64
 * bytes; the renderer loads them like any other subresource and Chromium caches them.
 */
export const SESSION_IMAGE_SCHEME = 'pig-image'

/** `pig-image://session/<sessionId>/<entryId>/<blockIndex>` addresses one persisted image block. */
export function sessionImageUrl(sessionId: string, entryId: string, index: number): string {
  const id = encodeURIComponent(sessionId)
  const entry = encodeURIComponent(entryId)
  return `${SESSION_IMAGE_SCHEME}://session/${id}/${entry}/${index}`
}

export interface SessionImageTarget {
  sessionId: string
  entryId: string
  index: number
}

const IMAGE_MIME = /^image\/[a-z0-9.+-]+$/i

/**
 * The MIME type of an image, normalized to its parameter-free base type, or null when the value does
 * not describe an image at all. Content-type parameters are dropped because the bytes decide the
 * image format, and a stored value must not dictate a response header verbatim.
 */
export function imageMimeType(mimeType: unknown): string | null {
  if (typeof mimeType !== 'string') return null
  const base = mimeType.split(';')[0].trim().toLowerCase()
  return IMAGE_MIME.test(base) ? base : null
}

/**
 * The base64 body of a payload, or null when the value cannot decode to whole bytes.
 *
 * Padding is optional (RFC 4648 §3.2) and whitespace may wrap the value, so only a body of length
 * 4n + 1 is rejected: `QUJ` is two bytes rather than a truncated `QUJD`. What is left of the string
 * is a well-formed base64 body, which is all a decoder needs.
 */
export function base64Body(data: unknown): string | null {
  if (typeof data !== 'string') return null
  const body = data.replace(/\s+/g, '').replace(/=+$/, '')
  if (body.length === 0 || body.length % 4 === 1) return null
  return /^[A-Za-z0-9+/]+$/.test(body) ? body : null
}

/** A payload the prompt path may persist: an image type plus base64 bytes. */
export interface ImagePayload {
  mimeType: string
  data: string
}

/**
 * What the prompt path checks before persisting. Sharing this with the reader is what makes an image
 * that was written retrievable: a payload accepted here always has a body the reader can decode.
 */
export function isImagePayload(payload: unknown): payload is ImagePayload {
  if (!payload || typeof payload !== 'object') return false
  const { mimeType, data } = payload as { mimeType?: unknown; data?: unknown }
  return imageMimeType(mimeType) !== null && base64Body(data) !== null
}

/** A content block of a session entry holding an image. */
export interface ImageBlock extends ImagePayload {
  type: 'image'
}

/**
 * The cheap structural test for a stored block, without looking at the bytes. The projection runs it
 * over a whole history, where image base64 can reach tens of megabytes (scanning it costs far more
 * than the projection itself), so the bytes are judged by the reader when an image is fetched. A
 * block the reader rejects renders as a missing image, not as an error.
 */
export function isImageBlock(block: unknown): block is ImageBlock {
  if (!block || typeof block !== 'object') return false
  const { type, mimeType, data } = block as { type?: unknown; mimeType?: unknown; data?: unknown }
  return type === 'image' && imageMimeType(mimeType) !== null && typeof data === 'string' && data.length > 0
}

/** A block the protocol can serve, with its normalized type and its validated base64 body. */
export function imageBlockPayload(block: unknown): { mimeType: string; body: string } | null {
  if (!isImageBlock(block)) return null
  const body = base64Body(block.data)
  return body ? { mimeType: imageMimeType(block.mimeType) as string, body } : null
}

export function parseSessionImageUrl(url: string): SessionImageTarget | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${SESSION_IMAGE_SCHEME}:` || parsed.hostname !== 'session') return null
  const [sessionId, entryId, index, ...rest] = parsed.pathname.split('/').filter(Boolean)
  if (!sessionId || !entryId || rest.length > 0 || !/^\d+$/.test(index ?? '')) return null
  try {
    return {
      sessionId: decodeURIComponent(sessionId),
      entryId: decodeURIComponent(entryId),
      index: Number(index)
    }
  } catch {
    // Malformed escapes are impossible to decode, and callers only handle a null result.
    return null
  }
}
