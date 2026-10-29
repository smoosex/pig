/** System context can arrive hours after an answer; it must not extend the preceding work. */
export function turnTiming(
  messages: readonly { role?: unknown; timestamp?: unknown; persistedAt?: number }[],
  fallback: number
): { startedAt: number; endedAt: number } {
  const first = messages.find((message) => message.role !== 'system')
  const last = messages.findLast((message) => message.role !== 'system')
  const startedAt = typeof first?.timestamp === 'number' && Number.isFinite(first.timestamp)
    ? first.timestamp
    : first?.persistedAt ?? fallback
  const endedAt = last?.persistedAt
    ?? (typeof last?.timestamp === 'number' && Number.isFinite(last.timestamp) ? last.timestamp : startedAt)
  return { startedAt, endedAt }
}
