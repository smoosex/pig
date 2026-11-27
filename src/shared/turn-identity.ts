import { composePromptText, type PastedTextDisplayMetadata } from './pasted-text'

/** Shared identity for a live user prompt and its persisted display turn. */
export function userTurnRenderKey(user: {
  timestamp: number
  content: unknown
  pastedText?: PastedTextDisplayMetadata
}): string {
  const blocks = Array.isArray(user.content) ? user.content : []
  // Persisted turns resolve transformed prompts (such as expanded skills) back to their source
  // input, so a live message carrying display metadata hashes that same source text.
  const text = user.pastedText
    ? user.pastedText.segments || user.pastedText.attachments.length === 0
      ? user.pastedText.body
      : composePromptText(user.pastedText.body, user.pastedText.attachments)
    : typeof user.content === 'string'
      ? user.content
      : blocks.filter(block => block.type === 'text').map(block => block.text).join('')
  const imageCount = blocks.filter(block => block.type === 'image').length
  const value = JSON.stringify([text.slice(0, 256), imageCount])
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `user:${user.timestamp}:${(hash >>> 0).toString(36)}`
}
