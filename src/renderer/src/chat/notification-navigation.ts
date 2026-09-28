/** Only an open session tab can be activated by a desktop notification. */
import type { SidebarTab } from '../../../shared/api'
import { useSessionsStore } from '../stores/sessions'

export function openNotifiedSession(
  sessionId: string,
  sidebarTab: SidebarTab,
  setSidebarTab: (tab: SidebarTab) => void,
  setWorkspaceRestoreMode: (startInChatHome: boolean) => void,
  closeSettings: () => void
): void {
  const state = useSessionsStore.getState()
  const tab = state.openTabs.find((item) => item.id === sessionId)
  if (!tab || (tab.kind !== 'chat' && tab.kind !== 'project')) return
  const next = tab.kind === 'chat' ? 'chats' : 'projects'
  if (sidebarTab !== next) {
    setWorkspaceRestoreMode(next === 'chats')
    setSidebarTab(next)
  }
  closeSettings()
  state.setActive(tab.id)
}
