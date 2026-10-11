import { create } from 'zustand'

interface SystemUIState {
  reviewSessions: Record<string, true>
  setReviewActive: (sessionId: string, active: boolean) => void
}

export const useSystemUIStore = create<SystemUIState>((set) => ({
  reviewSessions: {},
  setReviewActive: (sessionId, active) => set((state) => {
    if (active) return { reviewSessions: { ...state.reviewSessions, [sessionId]: true } }
    const reviewSessions = { ...state.reviewSessions }
    delete reviewSessions[sessionId]
    return { reviewSessions }
  })
}))
