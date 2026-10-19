/** Shared user-content previews for session lists, notification titles and naming input. */
import { stripImageHintsFromContent } from '../../shared/image-hints'

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
