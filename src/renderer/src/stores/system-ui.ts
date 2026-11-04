import { create } from 'zustand'
import type { ReviewFeedback, ReviewReturnPhase } from '../../../shared/api'

interface SystemUIState {
  reviewSessions: Record<string, true>
  returningReviewSessions: Record<string, true>
  reviewReturnPhases: Record<string, ReviewReturnPhase>
  reviewFeedback: Record<string, ReviewFeedback>
  setReviewFeedback: (sessionId: string, feedback: ReviewFeedback | null) => void
  setReviewActive: (sessionId: string, active: boolean) => void
  setReviewReturning: (sessionId: string, returning: boolean, phase?: ReviewReturnPhase) => void
}

export const useSystemUIStore = create<SystemUIState>((set) => ({
  reviewSessions: {},
  returningReviewSessions: {},
  reviewReturnPhases: {},
  reviewFeedback: {},
  setReviewFeedback: (sessionId, feedback) => set((state) => {
    const reviewFeedback = { ...state.reviewFeedback }
    if (feedback) reviewFeedback[sessionId] = feedback
    else delete reviewFeedback[sessionId]
    return { reviewFeedback }
  }),
  setReviewActive: (sessionId, active) => set((state) => {
    if (active) return { reviewSessions: { ...state.reviewSessions, [sessionId]: true } }
    const reviewSessions = { ...state.reviewSessions }
    delete reviewSessions[sessionId]
    return { reviewSessions }
  }),
  setReviewReturning: (sessionId, returning, phase) => set((state) => {
    const returningReviewSessions = { ...state.returningReviewSessions }
    const reviewReturnPhases = { ...state.reviewReturnPhases }
    if (returning) returningReviewSessions[sessionId] = true
    else delete returningReviewSessions[sessionId]
    if (returning && phase) reviewReturnPhases[sessionId] = phase
    else delete reviewReturnPhases[sessionId]
    return { returningReviewSessions, reviewReturnPhases }
  })
}))
