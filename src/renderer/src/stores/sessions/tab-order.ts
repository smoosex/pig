/**
 * The strip's own ordering, as pure functions the store can apply.
 *
 * `openTabs` is one flat array holding both halves of the switcher, so a position in it is not a
 * position on screen: the tabs between two visible ones can belong to the other half. Everything here
 * therefore works on the visible sequence — the subset the strip actually lists — and leaves the other
 * half's elements exactly where they were.
 */
import type { OpenTab } from './types'

/**
 * The tabs an order may be written for. A file tab is never part of what a worktree remembers across
 * launches, so its place is its own to lose when the run ends: dragging one moves it now, and it comes
 * back at the tail later, where the restore appends it.
 */
export function persistableIds(tabs: OpenTab[]): string[] {
  return tabs.filter((tab) => tab.kind !== 'file' && tab.kind !== 'browser').map((tab) => tab.id)
}

/** Chat browsers have no worktree; real chat sessions keep their own storage cwd. */
export function isChatScope(tab: OpenTab): boolean {
  return tab.kind === 'chat' || (tab.kind === 'browser' && tab.cwd === '')
}

/** The strip sequence a tab belongs to: the chats half's, or its own worktree's project tabs. */
export function sameScopeTabs(tabs: OpenTab[], tab: OpenTab): OpenTab[] {
  return isChatScope(tab)
    ? tabs.filter(isChatScope)
    : tabs.filter((item) => !isChatScope(item) && item.cwd === tab.cwd)
}

/**
 * A dragged half-strip written back into the flat list: the visible ids take the slots they already
 * held, everything else stays put. Ids that went away mid-drag are dropped rather than resurrected, so
 * a close behind this pointer cannot leave a tab the store never had.
 */
export function applyVisibleOrder(tabs: OpenTab[], visibleIds: string[]): OpenTab[] {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]))
  const ordered = [...new Set(visibleIds)].flatMap((id) => (byId.has(id) ? [id] : []))
  // The slots are the positions of exactly those ids, so they and `ordered` are the same length by
  // construction: an id that is no longer open was dropped above rather than given a slot.
  const slots = tabs.reduce<number[]>((indices, tab, index) =>
    ordered.includes(tab.id) ? [...indices, index] : indices, [])
  const next = [...tabs]
  slots.forEach((slot, index) => {
    next[slot] = byId.get(ordered[index])!
  })
  const moved = next.some((tab, index) => tab !== tabs[index])
  return moved ? next : tabs
}

/**
 * Where the strip goes when a tab closes: its right neighbour, or its left when nothing is to the
 * right. That is the rule every tab strip the reader already knows follows, and it is the only one that
 * survives an order they arranged themselves — the tail of the array stopped meaning "most recent" the
 * moment dragging became possible. Always taken within the closed tab's own half, so closing a worktree
 * tab can never land the pane on a chat and take the worktree with it.
 */
export function neighbourTab(tabs: OpenTab[], closed: OpenTab): OpenTab | null {
  return neighbourAmong(tabs, closed, () => true)
}

/**
 * The same rule where a tab can go together with others — `survivors` says which of the strip's tabs are
 * still there afterwards, so a neighbour that is leaving too cannot be handed the pane.
 */
export function neighbourAmong(
  tabs: OpenTab[],
  closed: OpenTab,
  survivors: (tab: OpenTab) => boolean
): OpenTab | null {
  const scope = sameScopeTabs(tabs, closed)
  const index = scope.findIndex((item) => item.id === closed.id)
  if (index === -1) return null
  return scope.slice(index + 1).find(survivors)
    ?? scope.slice(0, index).findLast(survivors)
    ?? null
}
