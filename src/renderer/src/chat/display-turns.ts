import type { DisplayTurn } from '../../../shared/api'
import type { PastedTextDisplayMetadata } from '../../../shared/pasted-text'
import { renderKeyForUser, type ProcessItem, type Turn } from './turns'

/** Rebuild a renderable turn from the persisted DTO without changing Pi message semantics. */
export function toTurn(display: DisplayTurn, process: ProcessItem[], workedMs?: number): Turn {
  const user = display.user
    ? {
        role: 'user' as const,
        content: display.user.images.length > 0
          ? [
              ...(display.user.text ? [{ type: 'text' as const, text: display.user.text }] : []),
              ...display.user.images.map((image) => ({
                type: 'image' as const,
                mimeType: image.mimeType,
                data: image.data
              }))
            ]
          : display.user.text,
        timestamp: display.userTimestamp ?? display.startedAt,
        pastedText: {
          body: display.user.text,
          attachments: display.user.textAttachments,
          ...(display.user.textSegments ? { segments: display.user.textSegments } : {})
        } satisfies PastedTextDisplayMetadata
      }
    : undefined

  return {
    id: display.id,
    user,
    process,
    answer: display.answer.map((block) =>
      block.type === 'text'
        ? block
        : {
            type: 'image' as const,
            image: { type: 'image', mimeType: block.mimeType, data: block.data }
          }
    ),
    errorMessage: display.errorMessage,
    startedAt: display.startedAt,
    endedAt: display.endedAt,
    streaming: false,
    hasProcess: display.hasProcess,
    workedMs,
    renderKey: user ? renderKeyForUser(user) : `turn:${display.id}`
  }
}
