/** Shared user-content previews for session lists, notification titles and naming input. */
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { stripImageHintsFromContent } from '../../shared/image-hints'
import { t } from '../i18n'

export function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: string; text?: string } => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('')
}

export function hasImage(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  return content.some((block) => block?.type === 'image')
}

/** Image-only previews stay a flag so each consumer translates them in the current language. */
export function previewText(content: unknown): { text: string; image: boolean } {
  const text = contentText(stripImageHintsFromContent(content)).trim()
  if (text) return { text: text.slice(0, 500), image: false }
  return { text: '', image: hasImage(content) }
}

export function notificationTitle(session: Pick<AgentSession, 'sessionName' | 'sessionManager'>): string {
  if (session.sessionName?.trim()) return session.sessionName
  let image = false
  for (const entry of session.sessionManager.getEntries()) {
    if (entry.type !== 'message' || entry.message.role !== 'user') continue
    const preview = previewText(entry.message.content)
    if (preview.text) return preview.text
    image ||= preview.image
  }
  return t(image ? 'sessions.imagePreview' : 'sessions.newTitle')
}
