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
export interface SoulTraits {
  openness: number
  conscientiousness: number
  extraversion: number
  agreeableness: number
  neuroticism: number
  formality: number
  tsundere: number
  sarcasm: number
}
export const DEFAULT_TRAITS: SoulTraits = {
  openness: 0.5, conscientiousness: 0.5, extraversion: 0.5, agreeableness: 0.5,
  neuroticism: 0.5, formality: 0.5, tsundere: 0, sarcasm: 0,
}
export interface SoulDefinition {
  name?: string
  emoji: string
  traits: SoulTraits
  systemPrompt: string
  userProfile?: string
}
