import type { OpenTab } from '../stores/sessions/types'
import { isChatScope } from '../stores/sessions/tab-order'
import type { SidebarTab } from '../../../shared/api'
import { collectPaneNodes, findPaneNode, type SplitGroup } from '../stores/split-layout'

export function stripShowsChats(_tab: SidebarTab, currentProjectCwd: string | null): boolean {
  return currentProjectCwd === null
}

/** Which tabs the strip shows. Project worktrees show their session, file, diff, browser, and terminal tabs. */
export function visibleTabsFor(
  tabs: OpenTab[],
  tab: SidebarTab,
  currentProjectCwd: string | null
): OpenTab[] {
  return stripShowsChats(tab, currentProjectCwd)
    ? tabs.filter(isChatScope)
    : tabs.filter((item) => !isChatScope(item) && item.cwd === currentProjectCwd)
}

export interface StripSlot {
  /** The tab the slot selects: for a split group, the pane that last had focus there. */
  tabId: string
  group: { paneTabIds: string[]; memberIds: string[] } | null
}

/** The strip's slots in order: each split group collapses into one, at its first visible member's place. */
export function stripSlots(visibleTabs: OpenTab[], groups: readonly SplitGroup[]): StripSlot[] {
  const grouped = groups.flatMap((group) => {
    const paneTabIds = collectPaneNodes(group.root).map((pane) => pane.tabId)
    const members = visibleTabs.filter((tab) => paneTabIds.includes(tab.id))
    if (!members.length) return []
    const focusedTabId = findPaneNode(group.root, group.activePaneId)?.tabId
    const representative = members.find((tab) => tab.id === focusedTabId) ?? members[0]
    return [{ tabId: representative.id, group: { paneTabIds, memberIds: members.map((tab) => tab.id) } }]
  })
  const placed = new Set<string>()
  return visibleTabs.flatMap((tab): StripSlot[] => {
    const slot = grouped.find((item) => item.group.memberIds.includes(tab.id))
    if (!slot) return [{ tabId: tab.id, group: null }]
    if (placed.has(slot.tabId)) return []
    placed.add(slot.tabId)
    return [slot]
  })
}

export type HalfSwitch =
  | { kind: 'none' }
  | { kind: 'project'; cwd: string }

export function halfSwitch(
  tabs: OpenTab[],
  next: SidebarTab,
  activeTabId: string | null,
  currentProjectCwd: string | null,
  _lastChatTabId: string | null,
  lastProjectCwd: string | null,
  knownProjectCwds: ReadonlySet<string>
): HalfSwitch {
  if (next === 'kanban') {
    return { kind: 'none' }
  }
  const active = tabs.find((item) => item.id === activeTabId)
  if (active && !isChatScope(active)) return { kind: 'none' }
  const held = (cwd: string | null): string | null =>
    cwd && (knownProjectCwds.has(cwd) || tabs.some((tab) => !isChatScope(tab) && tab.cwd === cwd))
      ? cwd
      : null
  const cwd = held(lastProjectCwd) ?? held(currentProjectCwd)
  if (cwd) return { kind: 'project', cwd }
  if (currentProjectCwd === null) return { kind: 'none' }
  const newest = tabs.findLast((item) => !isChatScope(item))
  return newest ? { kind: 'project', cwd: newest.cwd } : { kind: 'none' }
}
