import type { PromptStreamingBehavior } from '../ipc/api'

export interface FollowUpRow {
  id: string
  text: string
}

export function followUpRowsMatch(rows: readonly FollowUpRow[], messages: readonly string[]): boolean {
  return rows.length === messages.length && rows.every((row, index) => row.text === messages[index])
}

export function reconcileFollowUpRows(
  previous: FollowUpRow[],
  messages: readonly string[],
  createId: () => string,
  removedId?: string
): FollowUpRow[] {
  if (followUpRowsMatch(previous, messages)) return previous
  const counts = new Map<string, number>()
  for (const text of messages) counts.set(text, (counts.get(text) ?? 0) + 1)

  const candidates = new Map<string, { rows: FollowUpRow[]; index: number }>()
  for (const row of previous) {
    if (row.id === removedId) continue
    const bucket = candidates.get(row.text) ?? { rows: [], index: 0 }
    bucket.rows.push(row)
    candidates.set(row.text, bucket)
  }
  for (const [text, bucket] of candidates) {
    bucket.index = Math.max(0, bucket.rows.length - (counts.get(text) ?? 0))
  }

  const next = messages.map((text) => {
    const bucket = candidates.get(text)
    return bucket?.rows[bucket.index++] ?? { id: createId(), text }
  })
  return next.length === previous.length && next.every((row, index) => row === previous[index])
    ? previous
    : next
}

export interface QueuedMessageRow extends FollowUpRow {
  mode: PromptStreamingBehavior
}

export interface QueueRowChange {
  removedId?: string
  promotedId?: string
}

export function queuedRowsMatch(rows: readonly QueuedMessageRow[], steering: readonly string[], followUp: readonly string[]): boolean {
  return rows.length === steering.length + followUp.length && rows.every((row, index) =>
    index < steering.length
      ? row.mode === 'steer' && row.text === steering[index]
      : row.mode === 'followUp' && row.text === followUp[index - steering.length]
  )
}

/** Keep promoted rows mounted while moving them ahead of the follow-up queue. */
export function reconcileQueuedRows(
  previous: QueuedMessageRow[],
  steering: readonly string[],
  followUp: readonly string[],
  createId: () => string,
  change?: QueueRowChange
): QueuedMessageRow[] {
  if (queuedRowsMatch(previous, steering, followUp)) return previous
  const candidates = previous
    .filter((row) => row.id !== change?.removedId)
    .map((row) => row.id === change?.promotedId ? { ...row, mode: 'steer' as const } : row)
  const reconcile = (mode: PromptStreamingBehavior, messages: readonly string[]) =>
    reconcileFollowUpRows(candidates.filter((row) => row.mode === mode), messages, createId)
      .map((row) => 'mode' in row ? row as QueuedMessageRow : { ...row, mode })
  return [...reconcile('steer', steering), ...reconcile('followUp', followUp)]
}
