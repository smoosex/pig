/** Routes desktop notification clicks to either the Bot conversation or an open workspace session tab. */
import type { SidebarTab } from '../../../shared/api'
import { useSessionsStore } from '../stores/sessions'

export function openNotifiedSession(
  sessionId: string,
  sidebarTab: SidebarTab,
  setSidebarTab: (tab: SidebarTab) => void,
  setWorkspaceRestoreMode: (startInChatHome: boolean) => void,
  closeSettings: () => void,
  bot?: { sessionId: string | null; openBot: () => void; closeBot: () => void }
): boolean {
  if (bot?.sessionId && sessionId === bot.sessionId) {
    closeSettings()
    bot.openBot()
    return true
  }
  const state = useSessionsStore.getState()
  const tab = state.openTabs.find((item) => item.id === sessionId)
  if (!tab || (tab.kind !== 'chat' && tab.kind !== 'project')) return false
  bot?.closeBot()
  const next = tab.kind === 'chat' ? 'chats' : 'projects'
  if (sidebarTab !== next) {
    setWorkspaceRestoreMode(next === 'chats')
    setSidebarTab(next)
  }
  closeSettings()
  state.setActive(tab.id)
  return true
}
