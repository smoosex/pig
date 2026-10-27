/** Per-turn token usage, summed the same way for persisted history and live turns. */
import type { TurnUsage } from './api'

export type UsageCounts = Pick<TurnUsage, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>

/**
 * Adds one model call; a message without a usage record is not a measured call. Session files
 * are only typed by assertion, so a damaged record throws instead of counting as zero tokens.
 */
export function addUsage(total: TurnUsage | undefined, value: UsageCounts | undefined): TurnUsage | undefined {
  if (value === undefined) return total
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
    if (!Number.isFinite(value[key])) throw new Error(`Invalid assistant usage: ${key} is ${String(value[key])}`)
  }
  const input = (total?.input ?? 0) + value.input
  const output = (total?.output ?? 0) + value.output
  const cacheRead = (total?.cacheRead ?? 0) + value.cacheRead
  const cacheWrite = (total?.cacheWrite ?? 0) + value.cacheWrite
  return {
    input, output, cacheRead, cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    calls: (total?.calls ?? 0) + 1
  }
}

/** Cache reads over everything sent; null when nothing was sent. */
export function cacheHitRate(usage: TurnUsage): number | null {
  const sent = usage.input + usage.cacheRead + usage.cacheWrite
  return sent > 0 ? usage.cacheRead / sent : null
}
