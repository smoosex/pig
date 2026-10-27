import type { DisplayTurn, DisplayUser, GenerationStats } from '../../../shared/api'
import { composePromptText, type PastedTextDisplayMetadata } from '../../../shared/pasted-text'
import type { PigImageContent } from '../pi/types'
import { renderKeyForUser, type ProcessItem, type Turn } from './turns'

/** The persisted text a live prompt used before inline pasted-text metadata existed. */
function renderKeyContent(user: DisplayUser): string | Array<{ type: 'text'; text: string } | PigImageContent> {
  const text = user.textSegments || user.textAttachments.length === 0
    ? user.text
    : composePromptText(user.text, user.textAttachments)
  if (user.images.length === 0) return text
  return [
    ...(text ? [{ type: 'text' as const, text }] : []),
    ...user.images.map((image) => ({ type: 'image' as const, mimeType: image.mimeType, url: image.url }))
  ]
}

export function renderKeyForDisplayTurn(display: DisplayTurn): string {
  if (!display.user) return `turn:${display.id}`
  return renderKeyForUser({
    timestamp: display.userTimestamp ?? display.startedAt,
    content: renderKeyContent(display.user)
  })
}

export function toTurn(
  display: DisplayTurn,
  process: ProcessItem[],
  workedMs?: number,
  generation?: GenerationStats
): Turn {
  const user = display.user
    ? {
        role: 'user' as const,
        content: display.user.images.length > 0
          ? [
              ...(display.user.text ? [{ type: 'text' as const, text: display.user.text }] : []),
              ...display.user.images.map((image) => ({
                type: 'image' as const,
                mimeType: image.mimeType,
                url: image.url
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
    bash: display.bash,
    process,
    compactions: display.compactions.map((landmark) => ({ kind: 'compaction' as const, ...landmark })),
    branchSummaries: display.branchSummaries,
    workBlocks: display.workBlocks,
    answer: display.answer.map((block) =>
      block.type === 'text'
        ? block
        : {
            type: 'image' as const,
            image: { type: 'image' as const, mimeType: block.mimeType, url: block.url }
          }
    ),
    errorMessage: display.errorMessage,
    startedAt: display.startedAt,
    endedAt: display.endedAt,
    streaming: false,
    waitingForModel: false,
    hasProcess: display.hasProcess,
    workedMs,
    generation,
    ...(display.usage ? { usage: display.usage } : {}),
    lastEntryId: display.lastEntryId,
    renderKey: renderKeyForDisplayTurn(display)
  }
}
