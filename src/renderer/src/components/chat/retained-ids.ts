/** Shared bounded MRU id-list helpers used by ChatView and SplitPaneContainer. */

export function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

/** Keeps only valid ids, promotes active ids to the front without duplicates, and caps length. */
export function updateRecentIds(
  previous: string[],
  validIds: ReadonlySet<string>,
  promoteIds: readonly string[],
  limit: number
): string[] {
  const next = previous.filter((id) => validIds.has(id))
  for (let index = promoteIds.length - 1; index >= 0; index -= 1) {
    const id = promoteIds[index]
    if (!validIds.has(id)) continue
    const existing = next.indexOf(id)
    if (existing !== -1) next.splice(existing, 1)
    next.unshift(id)
  }
  const limited = next.slice(0, limit)
  return sameIds(previous, limited) ? previous : limited
}
