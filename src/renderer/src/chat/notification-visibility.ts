/**
 * Mirror App's visible surface for OS desktop notifications:
 * - Settings hides both Workspace and Bot, so everything notifies via OS.
 * - Bot page hides Workspace tabs, so Bot itself is visible while background workspace sessions still notify.
 * - Focused Workspace shows BotPeekBubble for Bot events, so Bot suppresses duplicate OS notifications while focused.
 */
import type { OpenTab } from '../stores/sessions'

export function visibleNotificationSessions(
  tabs: Pick<OpenTab, 'id' | 'kind' | 'loadState'>[],
  activeTabId: string | null,
  paneTabIds: string[],
  settingsOpen: boolean,
  bot?: { open: boolean; sessionId: string | null }
): string[] {
  if (settingsOpen) return []
  if (bot?.open) return bot.sessionId ? [bot.sessionId] : []
  const splitVisible = paneTabIds.length > 1 && activeTabId !== null && paneTabIds.includes(activeTabId)
  const visibleIds = new Set(splitVisible ? paneTabIds : activeTabId ? [activeTabId] : [])
  const sessionIds = tabs.filter((tab) => visibleIds.has(tab.id) && tab.loadState === 'ready' &&
    (tab.kind === 'chat' || tab.kind === 'project')).map((tab) => tab.id)
  if (bot?.sessionId && !sessionIds.includes(bot.sessionId)) sessionIds.push(bot.sessionId)
  return sessionIds
}
