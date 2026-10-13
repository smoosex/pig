import { create } from 'zustand'

interface SystemUIState {
  reviewSessions: Record<string, true>
  returningReviewSessions: Record<string, true>
  setReviewActive: (sessionId: string, active: boolean) => void
  setReviewReturning: (sessionId: string, returning: boolean) => void
}

export const useSystemUIStore = create<SystemUIState>((set) => ({
  reviewSessions: {},
  returningReviewSessions: {},
  setReviewActive: (sessionId, active) => set((state) => {
    if (active) return { reviewSessions: { ...state.reviewSessions, [sessionId]: true } }
    const reviewSessions = { ...state.reviewSessions }
    delete reviewSessions[sessionId]
    return { reviewSessions }
  }),
  setReviewReturning: (sessionId, returning) => set((state) => {
    if (returning) return { returningReviewSessions: { ...state.returningReviewSessions, [sessionId]: true } }
    const returningReviewSessions = { ...state.returningReviewSessions }
    delete returningReviewSessions[sessionId]
    return { returningReviewSessions }
  })
}))
