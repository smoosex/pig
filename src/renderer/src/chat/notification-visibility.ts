/** Mirror App's single-pane/split-pane rendering, not the sidebar's selected workspace. */
import type { OpenTab } from '../stores/sessions'

export function visibleNotificationSessions(
  tabs: Pick<OpenTab, 'id' | 'kind' | 'loadState'>[],
  activeTabId: string | null,
  paneTabIds: string[],
  settingsOpen: boolean
): string[] {
  if (settingsOpen) return []
  const splitVisible = paneTabIds.length > 1 && activeTabId !== null && paneTabIds.includes(activeTabId)
  const visibleIds = new Set(splitVisible ? paneTabIds : activeTabId ? [activeTabId] : [])
  return tabs.filter((tab) => visibleIds.has(tab.id) && tab.loadState === 'ready' &&
    (tab.kind === 'chat' || tab.kind === 'project')).map((tab) => tab.id)
}
