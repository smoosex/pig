/** Shared bookmark state; persisted revisions prevent late reads from undoing a newer click. */
import { create } from 'zustand'
import type { BookmarkSnapshot, ReplyBookmark } from '../../../shared/bookmarks'
import { api } from '../ipc/api'
import { failureMessage } from '../lib/ipc-error'

interface BookmarkState {
  items: ReplyBookmark[]
  revision: number
  ready: boolean
  error: string | null
  pending: Record<string, boolean>
  jump: { sessionId: string; turnIndex: number; turnId: string; token: number } | null
  refresh(): Promise<void>
  add(sessionId: string, turnId: string, entryId: string, title: string): Promise<void>
  remove(id: string): Promise<void>
  requestJump(item: ReplyBookmark, turnIndex: number): void
  clearJump(token: number): void
}

export const useBookmarksStore = create<BookmarkState>((set, get) => {
  const apply = (snapshot: BookmarkSnapshot) => set(state => snapshot.revision < state.revision ? state : {
    items: snapshot.items, revision: snapshot.revision, ready: true, error: null
  })
  const mutate = async (id: string, write: () => Promise<BookmarkSnapshot>) => {
    if (get().pending[id]) return
    set(state => ({ pending: { ...state.pending, [id]: true } }))
    try { apply(await write()) }
    finally {
      set(state => {
        const pending = { ...state.pending }
        delete pending[id]
        return { pending }
      })
    }
  }
  return {
    items: [], revision: -1, ready: false, error: null, pending: {}, jump: null,
    refresh: async () => {
      try { apply(await api.bookmarks.list()) }
      catch (error) { set({ error: failureMessage(error) }) }
    },
    add: (sessionId, turnId, entryId, title) => mutate(`${sessionId}/${entryId}`, () => api.bookmarks.add(sessionId, turnId, entryId, title)),
    remove: id => mutate(id, () => api.bookmarks.remove(id)),
    requestJump: (item, turnIndex) => set({ jump: { sessionId: item.session.id, turnId: item.turnId, turnIndex, token: ++jumpToken } }),
    clearJump: token => { if (get().jump?.token === token) set({ jump: null }) }
  }
})

let jumpToken = 0
