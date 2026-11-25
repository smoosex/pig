/**
 * Renderer store for Project Spaces. Uses revision gating so late snapshots never overwrite newer
 * mutations, and degrades cleanly to the built-in Default space in test fixtures without `api.spaces`.
 */
import { create } from 'zustand'
import type { Translate } from '../../../shared/i18n'
import {
  DEFAULT_SPACE_ID,
  createDefaultSpacesSnapshot,
  type CreateProjectSpaceInput,
  type ProjectSpace,
  type ProjectSpacesSnapshot,
  type UpdateProjectSpaceInput
} from '../../../shared/project-spaces'
import { api } from '../ipc/api'
import { failureMessage } from '../lib/ipc-error'

export type SpaceDialogState =
  | { mode: 'create'; moveProjectCwd?: string }
  | { mode: 'rename'; spaceId: string }
  | { mode: 'icon'; spaceId: string }
  | { mode: 'delete'; spaceId: string }

export function spaceDisplayName(space: ProjectSpace | undefined, t: Translate): string {
  if (!space) return t('spaces.defaultName')
  if (space.id === DEFAULT_SPACE_ID && !space.name.trim()) return t('spaces.defaultName')
  return space.name.trim() || t('spaces.defaultName')
}

export function suggestNextSpaceName(spaces: readonly ProjectSpace[], t: Translate): string {
  const existing = new Set(spaces.map((space) => spaceDisplayName(space, t).toLowerCase()))
  let n = spaces.length + 1
  while (existing.has(t('spaces.numberedName', { n }).toLowerCase())) {
    n++
  }
  return t('spaces.numberedName', { n })
}

interface ProjectSpacesStore {
  spaces: ProjectSpace[]
  activeSpaceId: string
  assignments: Record<string, string>
  revision: number
  ready: boolean
  busy: boolean
  error: string | null
  dialog: SpaceDialogState | null
  load: () => Promise<void>
  openDialog: (dialog: SpaceDialogState) => void
  closeDialog: () => void
  selectSpace: (spaceId: string) => Promise<void>
  createSpace: (input: CreateProjectSpaceInput) => Promise<ProjectSpacesSnapshot | null>
  updateSpace: (input: UpdateProjectSpaceInput) => Promise<ProjectSpacesSnapshot | null>
  removeSpace: (id: string) => Promise<ProjectSpacesSnapshot | null>
  assignProject: (cwd: string, spaceId: string) => Promise<void>
  forgetProject: (cwd: string) => Promise<void>
  applySnapshot: (snapshot: ProjectSpacesSnapshot) => void
}

const initial = createDefaultSpacesSnapshot()

export const useProjectSpacesStore = create<ProjectSpacesStore>((set, get) => {
  const applySnapshot = (snapshot: ProjectSpacesSnapshot) =>
    set((state) =>
      snapshot.revision < state.revision
        ? state
        : {
            spaces: snapshot.spaces,
            activeSpaceId: snapshot.activeSpaceId,
            assignments: snapshot.assignments,
            revision: snapshot.revision,
            ready: true,
            error: null
          }
    )

  return {
    spaces: initial.spaces,
    activeSpaceId: initial.activeSpaceId,
    assignments: initial.assignments,
    revision: -1,
    ready: false,
    busy: false,
    error: null,
    dialog: null,

    applySnapshot,

    openDialog: (dialog) => set({ dialog, error: null }),
    closeDialog: () => set({ dialog: null }),

    load: async () => {
      if (!api?.spaces?.getSnapshot) {
        set({ ready: true })
        return
      }
      try {
        applySnapshot(await api.spaces.getSnapshot())
      } catch (error) {
        set({ ready: true, error: failureMessage(error) })
      }
    },

    selectSpace: async (spaceId) => {
      const previous = get().activeSpaceId
      if (previous === spaceId) return
      set({ activeSpaceId: spaceId, error: null })
      if (!api?.spaces?.select) return
      try {
        applySnapshot(await api.spaces.select(spaceId))
      } catch (error) {
        set((state) => ({
          activeSpaceId: state.activeSpaceId === spaceId ? previous : state.activeSpaceId,
          error: failureMessage(error)
        }))
      }
    },

    createSpace: async (input) => {
      if (!api?.spaces?.create) return null
      set({ busy: true, error: null })
      try {
        const snapshot = await api.spaces.create(input)
        applySnapshot(snapshot)
        set({ busy: false, dialog: null })
        return snapshot
      } catch (error) {
        set({ busy: false, error: failureMessage(error) })
        throw error
      }
    },

    updateSpace: async (input) => {
      if (!api?.spaces?.update) return null
      set({ busy: true, error: null })
      try {
        const snapshot = await api.spaces.update(input)
        applySnapshot(snapshot)
        set({ busy: false, dialog: null })
        return snapshot
      } catch (error) {
        set({ busy: false, error: failureMessage(error) })
        throw error
      }
    },

    removeSpace: async (id) => {
      if (!api?.spaces?.remove) return null
      set({ busy: true, error: null })
      try {
        const snapshot = await api.spaces.remove(id)
        applySnapshot(snapshot)
        set({ busy: false, dialog: null })
        return snapshot
      } catch (error) {
        set({ busy: false, error: failureMessage(error) })
        throw error
      }
    },

    assignProject: async (cwd, spaceId) => {
      const prevAssignments = get().assignments
      set({
        assignments: { ...prevAssignments, [cwd]: spaceId },
        error: null
      })
      if (!api?.spaces?.assignProject) return
      try {
        applySnapshot(await api.spaces.assignProject(cwd, spaceId))
      } catch (error) {
        set({ assignments: prevAssignments, error: failureMessage(error) })
      }
    },

    forgetProject: async (cwd) => {
      if (!api?.spaces?.forgetProject) return
      try {
        applySnapshot(await api.spaces.forgetProject(cwd))
      } catch {
        // Best-effort cleanup after project removal.
      }
    }
  }
})
