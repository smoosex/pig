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
