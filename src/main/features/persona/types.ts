/* Continuous expressive state; personality remains owned by the persona documents. */
import type { PersonaMoodHistory, PersonaMoodValues, PersonaObserverSettings } from '../../../shared/persona'

/** Relative observer judgement: integer steps from -2 to 2, applied by the engine with clamping. */
export interface MoodObservation {
  pleasantness: number
  activation: number
  feeling: string
}
export interface EmotionalState extends PersonaMoodValues {
  feeling: string
  history: PersonaMoodHistory[]
}
export interface PersistentEmotionSnapshot extends PersonaMoodHistory {
  id: string
  sessionId: string
  sequence: number
}
export interface PersistentState extends PersonaMoodValues {
  version: 3
  feeling: string
  lastInteraction: number
  emotionUpdatesEnabled: boolean
  /** Invalidates background observations after any explicit control change. */
  controlsRevision: number
  observer: PersonaObserverSettings
  /** Activity leases expire after six hours unless renewed; shutdown/reload releases its own session. */
  activeSessions: Record<string, number>
  nextHistorySequence: number
  history: PersistentEmotionSnapshot[]
}
export interface SoulDefinition {
  systemPrompt: string
  userProfile?: string
}
