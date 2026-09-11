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
