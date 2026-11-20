/**
 * Pure projection helpers for Bot timeline items, hidden reminder stripping, and peek bubble previews.
 */
import { stat } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import type { BotAttachmentItem, BotPeekMessage, BotTimelineItem } from '../../shared/bot'

const HIDDEN_BLOCK_RE = /<(?:system_reminder|host_notice)>[\s\S]*?<\/(?:system_reminder|host_notice)>/gi

/** Ensure hidden host reminders never leak into visible timeline text. */
export function stripHiddenBotTags(text: string): string {
  return text.replace(HIDDEN_BLOCK_RE, '').trim()
}

export async function resolveBotAttachments(paths: readonly string[]): Promise<BotAttachmentItem[]> {
  const results: BotAttachmentItem[] = []
  for (const raw of paths.slice(0, 10)) {
    const trimmed = raw.trim()
    if (!trimmed || !isAbsolute(trimmed)) {
      throw new Error(`Attachment path must be an absolute local path: ${raw}`)
    }
    try {
      const info = await stat(trimmed)
      if (!info.isFile()) throw new Error(`Attachment path is not a file: ${trimmed}`)
      results.push({ path: trimmed, name: basename(trimmed), exists: true, size: info.size })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Attachment file does not exist: ${trimmed}`)
      }
      throw error
    }
  }
  return results
}

export function projectTimelineItemToPeek(
  item: Extract<BotTimelineItem, { kind: 'assistant' | 'system_fallback' }>,
  meta?: { statusBadge?: string; projectName?: string; taskId?: string }
): BotPeekMessage {
  const rawText = item.kind === 'assistant' ? item.content : item.text
  const cleaned = stripHiddenBotTags(rawText).replace(/\s+/g, ' ').trim()
  return {
    id: item.id,
    kind: item.kind === 'assistant' && item.messageType === 'delivery' ? 'delivery' : 'message',
    text: cleaned.slice(0, 240),
    ...(meta?.statusBadge ? { statusBadge: meta.statusBadge } : {}),
    ...(meta?.projectName ? { projectName: meta.projectName } : {}),
    ...(meta?.taskId ? { taskId: meta.taskId } : {}),
    createdAt: item.createdAt
  }
}
