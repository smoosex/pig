import type { DisplayTurn, DisplayUser } from '../../../shared/api'
import { composePromptText, type PastedTextDisplayMetadata } from '../../../shared/pasted-text'
import { renderKeyForUser, type ProcessItem, type Turn } from './turns'

/** The persisted text a live prompt used before inline pasted-text metadata existed. */
function renderKeyContent(user: DisplayUser): string | Array<
  { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }
> {
  const text = user.textSegments || user.textAttachments.length === 0
    ? user.text
    : composePromptText(user.text, user.textAttachments)
  if (user.images.length === 0) return text
  return [
    ...(text ? [{ type: 'text' as const, text }] : []),
    ...user.images.map((image) => ({ type: 'image' as const, mimeType: image.mimeType, data: image.data }))
  ]
}

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
    renderKey: user && display.user
      ? renderKeyForUser({ timestamp: user.timestamp, content: renderKeyContent(display.user) })
      : `turn:${display.id}`
  }
}
