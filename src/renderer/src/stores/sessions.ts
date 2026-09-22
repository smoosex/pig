import { create } from 'zustand'
import { createCatalogSlice } from './sessions/catalog-slice'
import { createConversationSlice } from './sessions/conversation-slice'
import { createTabsSlice } from './sessions/tabs-slice'
import type { SessionsStore } from './sessions/types'

export type { ProjectGroup, SessionMeta, WorktreeGroup } from '../ipc/api'
export type { RuntimeState, OpenTab, SessionsStore } from './sessions/types'

/** One store, composed by responsibility so cross-slice updates remain atomic. */
export const useSessionsStore = create<SessionsStore>((...args) => ({
  ...createCatalogSlice(...args),
  ...createConversationSlice(...args),
  ...createTabsSlice(...args)
}))

/**
 * The session behind the active tab. A diff or file tab holds the strip without owning a session, so
 * anything that prompts, streams, or reads runtime state asks for this rather than the raw tab id.
 */
export function selectActiveSessionId(state: SessionsStore): string | null {
  const tab = state.openTabs.find((item) => item.id === state.activeTabId)
  return tab && (tab.kind === 'project' || tab.kind === 'chat') ? tab.id : null
}

/** The worktree holding the active session: the same tab the id above comes from, projected to cwd. */
export function selectActiveSessionCwd(state: SessionsStore): string | null {
  const tab = state.openTabs.find((item) => item.id === state.activeTabId)
  return tab && (tab.kind === 'project' || tab.kind === 'chat') ? tab.cwd : null
}
