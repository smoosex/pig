import { create } from 'zustand'
import { createCatalogSlice } from './sessions/catalog-slice'
import { createConversationSlice } from './sessions/conversation-slice'
import { createTabsSlice } from './sessions/tabs-slice'
import { useSettingsStore } from './settings'
import { api } from '../ipc/api'
import type { SessionsStore } from './sessions/types'
import { toolTabMemberships } from './sessions/tab-order'
import { useSplitLayoutStore } from './split-layout'

export type { ProjectGroup, SessionMeta, WorktreeGroup } from '../ipc/api'
export type { RuntimeState, OpenTab, SessionsStore } from './sessions/types'

/** One store, composed by responsibility so cross-slice updates remain atomic. */
export const useSessionsStore = create<SessionsStore>((...args) => ({
  ...createCatalogSlice(...args),
  ...createConversationSlice(...args),
  ...createTabsSlice(...args)
}))

// Placeholder tab titles are stored strings, so a language switch has to rewrite them; every other
// title comes from the session and is language-independent.
useSettingsStore.subscribe((state, previous) => {
  if (state.locale !== previous.locale) useSessionsStore.getState().relabelTabs()
})

// Every path that brings a session to the front (sidebar, tab strip, restore, close fallback) ends
// here, so the unread mark is cleared in one place rather than in each of them.
useSessionsStore.subscribe((state) => {
  const sessionId = selectActiveSessionId(state)
  if (sessionId && state.runtime[sessionId]?.unread) state.markRead(sessionId)
})

// Browser tabs own native resources even when a project removal bypasses closeTab.
useSessionsStore.subscribe((state, previous) => {
  if (state.openTabs === previous.openTabs) return
  const remaining = new Set(state.openTabs.map((tab) => tab.id))
  for (const tab of previous.openTabs) {
    if (tab.kind !== 'browser' || remaining.has(tab.id)) continue
    void api.browser.close(tab.id).catch((error: unknown) => {
      useSessionsStore.setState({ workspaceError: error instanceof Error ? error.message : String(error) })
    })
  }
})

// Main records which browser and terminal tabs are open. Nothing is written until the restore has merged
// the saved list, so an early tab cannot replace it; the first write after that also drops what did not
// come back, such as a terminal of a worktree since deleted.
let savedToolTabs: string | null = null
useSessionsStore.subscribe((state, previous) => {
  if (!state.workspaceRestoreReady || (state.openTabs === previous.openTabs && savedToolTabs !== null)) return
  const tabs = toolTabMemberships(state.openTabs)
  const signature = JSON.stringify(tabs)
  if (signature === savedToolTabs) return
  savedToolTabs = signature
  void api.saveOpenToolTabs(tabs).catch((error: unknown) => {
    useSessionsStore.setState({ workspaceError: error instanceof Error ? error.message : String(error) })
  })
})

// The split groups come back too; the same restore gate applies, and the write after it carries whatever
// the restore put on screen.
let savedSplit: string | null = null
function saveSplitLayout(): void {
  if (!useSessionsStore.getState().workspaceRestoreReady) return
  const layouts = useSplitLayoutStore.getState().groups.map(({ root, activePaneId }) => ({ root, activePaneId }))
  const signature = JSON.stringify(layouts)
  if (signature === savedSplit) return
  savedSplit = signature
  void api.saveOpenSplitLayouts(layouts).catch((error: unknown) => {
    useSessionsStore.setState({ workspaceError: error instanceof Error ? error.message : String(error) })
  })
}
useSplitLayoutStore.subscribe((state, previous) => {
  if (state.groups !== previous.groups) saveSplitLayout()
})
useSessionsStore.subscribe((state, previous) => {
  if (state.workspaceRestoreReady && !previous.workspaceRestoreReady) saveSplitLayout()
})

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
