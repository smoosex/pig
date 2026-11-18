/** Unsent content belongs to the session, not to a pane's React ancestry. Preview URLs stay local. */
import type { JSONContent } from '@tiptap/core'
import { create } from 'zustand'

export interface DraftImage {
  id: string
  mimeType: string
  data: string
}

export interface FailedDraft {
  content: JSONContent
  images: DraftImage[]
}

type DraftErrors = Record<string, string | undefined>
type FailedDrafts = Record<string, FailedDraft[] | undefined>

interface ComposerDraft {
  /** External replacements rehydrate mounted editors without replaying their own keystrokes. */
  restoreVersion?: number
  focusOnRestore?: boolean
  focusAfterPromotion?: boolean
  content?: JSONContent
  images?: DraftImage[]
  bashMode?: boolean
  bashDismissed?: boolean
}

interface ComposerDraftsState {
  drafts: Record<string, ComposerDraft | undefined>
  errors: DraftErrors
  failedDrafts: FailedDrafts
  setErrors: (update: (current: DraftErrors) => DraftErrors) => void
  setFailedDrafts: (update: (current: FailedDrafts) => FailedDrafts) => void
  setContent: (sessionId: string, content: JSONContent) => void
  setImages: (sessionId: string, images: DraftImage[]) => void
  consumeDraft: (sessionId: string, content: JSONContent | undefined, imageIds: string[], bash: boolean, focus: boolean) => boolean
  takePromotionFocus: (sessionId: string) => boolean
  restoreDraft: (sessionId: string, draft: FailedDraft) => void
  setBashMode: (sessionId: string, bashMode: boolean, bashDismissed?: boolean) => void
  discard: (sessionId: string) => void
}

export const useComposerDraftsStore = create<ComposerDraftsState>((set) => ({
  drafts: {},
  errors: {},
  failedDrafts: {},
  setErrors: (update) => set((state) => ({ errors: update(state.errors) })),
  setFailedDrafts: (update) => set((state) => ({ failedDrafts: update(state.failedDrafts) })),
  setContent: (sessionId, content) =>
    set((state) => ({
      drafts: { ...state.drafts, [sessionId]: { ...state.drafts[sessionId], content } }
    })),
  setImages: (sessionId, images) =>
    set((state) => ({
      drafts: { ...state.drafts, [sessionId]: { ...state.drafts[sessionId], images } }
    })),
  consumeDraft: (sessionId, content, imageIds, bash, focus) => {
    let consumed = false
    set((state) => {
      const draft = state.drafts[sessionId]
      if (!draft) return state
      consumed = draft.content === content
      const images = draft.images?.filter(image => !imageIds.includes(image.id))
      if (!focus && !consumed && images?.length === draft.images?.length) return state
      return { drafts: { ...state.drafts, [sessionId]: {
        ...draft, images,
        ...(consumed ? { content: undefined, ...(bash ? { bashMode: false, bashDismissed: false } : {}) } : {}),
        restoreVersion: (draft.restoreVersion ?? 0) + 1,
        focusOnRestore: false,
        focusAfterPromotion: focus
      } } }
    })
    return consumed
  },
  takePromotionFocus: (sessionId) => {
    let requested = false
    set(state => {
      const draft = state.drafts[sessionId]
      if (!draft?.focusAfterPromotion) return state
      requested = true
      return { drafts: { ...state.drafts, [sessionId]: { ...draft, focusAfterPromotion: false } } }
    })
    return requested
  },
  restoreDraft: (sessionId, draft) =>
    set((state) => ({
      drafts: {
        ...state.drafts,
        [sessionId]: {
          ...draft,
          restoreVersion: (state.drafts[sessionId]?.restoreVersion ?? 0) + 1,
          focusOnRestore: true,
          bashMode: false,
          bashDismissed: true
        }
      },
      errors: { ...state.errors, [sessionId]: undefined }
    })),
  setBashMode: (sessionId, bashMode, bashDismissed = false) =>
    set((state) => ({
      drafts: {
        ...state.drafts,
        [sessionId]: { ...state.drafts[sessionId], bashMode, bashDismissed }
      }
    })),
  discard: (sessionId) =>
    set((state) => {
      const drafts = { ...state.drafts }
      const errors = { ...state.errors }
      const failedDrafts = { ...state.failedDrafts }
      delete drafts[sessionId]
      delete errors[sessionId]
      delete failedDrafts[sessionId]
      return { drafts, errors, failedDrafts }
    })
}))
