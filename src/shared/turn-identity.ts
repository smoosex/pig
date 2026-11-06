/** Shared identity for a live user prompt and its persisted display turn. */
export function userTurnRenderKey(user: { timestamp: number; content: unknown }): string {
  const blocks = Array.isArray(user.content) ? user.content : []
  const text = typeof user.content === 'string' ? user.content
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
