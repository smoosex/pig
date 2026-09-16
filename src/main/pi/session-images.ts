/**
 * Decode one image block out of a persisted session entry.
 *
 * Turn payloads carry `pig-image` URLs instead of base64 bytes, so the protocol handler resolves
 * the bytes here on demand.
 */
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import {
  imageBlockPayload,
  parseSessionImageUrl
} from '../../shared/session-images'
import { UnsupportedSessionFile } from './session-jsonl'

export interface SessionImage {
  data: Buffer
  mimeType: string
}

function entryContent(entry: SessionEntry): unknown[] | undefined {
  if (entry.type === 'message') {
    const content = (entry.message as { content?: unknown }).content
    return Array.isArray(content) ? content : undefined
  }
  if (entry.type === 'custom_message') return Array.isArray(entry.content) ? entry.content : undefined
  return undefined
}

/**
 * Decode the image block at `index`, ignoring anything that is not a servable image block: the shared
 * rule already rejected what the writer would have refused, so this only has to decode.
 *
 * The session image bytes are decoded here, on demand, and never travel with a turn.
 */
export function sessionImageFromEntry(
  entry: SessionEntry | undefined,
  index: number
): SessionImage | null {
  const content = entry ? entryContent(entry) : undefined
  const payload = imageBlockPayload(content?.[index])
  if (!payload) return null
  const data = Buffer.from(payload.body, 'base64')
  return data.length > 0 ? { data, mimeType: payload.mimeType } : null
}

export interface SessionEntryLookup {
  (sessionId: string, entryId: string): Promise<SessionEntry | undefined>
}

export async function sessionImageResponse(url: string, lookup: SessionEntryLookup): Promise<Response> {
  const target = parseSessionImageUrl(url)
  if (!target) return new Response(null, { status: 404 })
  let entry: SessionEntry | undefined
  try {
    entry = await lookup(target.sessionId, target.entryId)
  } catch (error) {
    // A file this reader cannot vouch for is an image it cannot serve: the entry is as good as gone.
    // Anything else is a bug and is left for Electron to report.
    if (error instanceof UnsupportedSessionFile) return new Response(null, { status: 404 })
    throw error
  }
  const image = sessionImageFromEntry(entry, target.index)
  if (!image) return new Response(null, { status: 404 })
  return new Response(new Uint8Array(image.data), {
    headers: {
      'content-type': image.mimeType,
      // Session entries are append-only: one URL always maps to the same bytes.
      'cache-control': 'private, max-age=31536000, immutable'
    }
  })
}
