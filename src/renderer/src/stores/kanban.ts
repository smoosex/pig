/**
 * Renderer Zustand store for Pig's local Kanban board:
 * - Subscribes to `kanban:changed` with monotonic revision guards so stale snapshots never overwrite newer state
 * - Owns board/list view preference, sidebar project scope filter, search query, and global Issue create/detail dialog state
 */
import { create } from 'zustand'
import type {
  KanbanCreateInput,
  KanbanIssue,
  KanbanSnapshot,
  KanbanStatus,
  KanbanUpdateInput
} from '../../../shared/kanban'
import { api } from '../ipc/api'
import { failureMessage } from '../lib/ipc-error'

export type KanbanProjectScope = 'all' | 'unassigned' | string
export type KanbanViewMode = 'board' | 'list'

export type KanbanDialogState =
  | null
  | {
      mode: 'create'
      defaultProjectCwd: string | null
      defaultStatus?: KanbanStatus
    }
  | {
      mode: 'edit'
      number: number
    }

export interface KanbanStoreState {
  loaded: boolean
  loading: boolean
  error: string | null
  revision: number
  nextNumber: number
  items: KanbanIssue[]

  viewMode: KanbanViewMode
  projectScope: KanbanProjectScope
  searchQuery: string
  showCanceled: boolean
  dialog: KanbanDialogState

  init: () => Promise<void>
  applySnapshot: (snapshot: KanbanSnapshot) => void
  setViewMode: (mode: KanbanViewMode) => void
  setProjectScope: (scope: KanbanProjectScope) => void
  setSearchQuery: (query: string) => void
  setShowCanceled: (show: boolean) => void
  openCreateDialog: (options?: { projectCwd?: string | null; status?: KanbanStatus }) => void
  openIssueDialog: (number: number) => void
  closeDialog: () => void

  createIssue: (input: KanbanCreateInput) => Promise<KanbanIssue>
  updateIssue: (input: KanbanUpdateInput) => Promise<KanbanIssue>
  deleteIssue: (number: number) => Promise<void>
}

let unsubscribeKanban: (() => void) | null = null
let initPromise: Promise<void> | null = null

export const useKanbanStore = create<KanbanStoreState>((set, get) => ({
  loaded: false,
  loading: false,
  error: null,
  revision: -1,
  nextNumber: 1,
  items: [],

  viewMode: 'board',
  projectScope: 'all',
  searchQuery: '',
  showCanceled: false,
  dialog: null,

  init: async () => {
    if (!api?.kanban) return
    if (get().loaded) return
    if (initPromise) return initPromise
    set({ loading: true, error: null })
    initPromise = (async () => {
      try {
        unsubscribeKanban ??= api.kanban.onChanged((snapshot) => {
          get().applySnapshot(snapshot)
        })
        const snapshot = await api.kanban.getSnapshot()
        get().applySnapshot(snapshot)
      } catch (error) {
        set({ loading: false, error: failureMessage(error) })
      } finally {
        initPromise = null
      }
    })()
    return initPromise
  },

  applySnapshot: (snapshot) => {
    set((state) => {
      if (state.loaded && snapshot.revision < state.revision) {
        return state
      }
      return {
        loaded: true,
        loading: false,
        error: null,
        revision: snapshot.revision,
        nextNumber: snapshot.nextNumber,
        items: snapshot.items
      }
    })
  },

  setViewMode: (viewMode) => set({ viewMode }),
  setProjectScope: (projectScope) => set({ projectScope }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setShowCanceled: (showCanceled) => set({ showCanceled }),

  openCreateDialog: (options) => {
    const scope = get().projectScope
    const inferredProject =
      options?.projectCwd !== undefined
        ? options.projectCwd
        : scope === 'all' || scope === 'unassigned'
          ? null
          : scope
    set({
      dialog: {
        mode: 'create',
        defaultProjectCwd: inferredProject,
        defaultStatus: options?.status
      }
    })
  },

  openIssueDialog: (number) => {
    set({ dialog: { mode: 'edit', number } })
  },

  closeDialog: () => set({ dialog: null }),

  createIssue: async (input) => {
    const { issue, snapshot } = await api.kanban.create(input)
    get().applySnapshot(snapshot)
    return issue
  },

  updateIssue: async (input) => {
    const prevState = get()
    const baseRevision = prevState.revision
    const previousItems = prevState.items

    if (input.images === undefined) {
      const idx = previousItems.findIndex((item) => item.number === input.number)
      if (idx >= 0) {
        const current = previousItems[idx]
        const nextStatus = input.status ?? current.status
        const now = Date.now()
        const optimistic: KanbanIssue = {
          ...current,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          status: nextStatus,
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.projectCwd !== undefined ? { projectCwd: input.projectCwd } : {}),
          ...(input.labels !== undefined ? { labels: [...input.labels] } : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
          updatedAt: now,
          completedAt:
            nextStatus === 'done'
              ? (current.completedAt ?? now)
              : nextStatus !== current.status
                ? null
                : current.completedAt
        }
        const nextItems = [...previousItems]
        nextItems[idx] = optimistic
        set({ items: nextItems })
      }
    }

    try {
      const { issue, snapshot } = await api.kanban.update(input)
      get().applySnapshot(snapshot)
      return issue
    } catch (error) {
      if (get().revision === baseRevision) {
        set({ items: previousItems })
      }
      throw error
    }
  },

  deleteIssue: async (number) => {
    const snapshot = await api.kanban.delete(number)
    get().applySnapshot(snapshot)
    const dialog = get().dialog
    if (dialog?.mode === 'edit' && dialog.number === number) {
      set({ dialog: null })
    }
  }
}))
