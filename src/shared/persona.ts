/* One global persona and expressive state, shared by all Pig conversations. */
import type { ThinkingLevel } from './api'
export const PERSONA_FILES = ['SOUL.md', 'IDENTIFY.md', 'USER.md'] as const
export type PersonaFileName = typeof PERSONA_FILES[number]
export interface PersonaDocument {
  name: PersonaFileName
  content: string
  revision: string | null
}
export interface PersonaMoodValues {
  /** -1 (subdued) to 1 (pleasant). */
  pleasantness: number
  /** 0 (calm) to 1 (activated), independent of energy. */
  activation: number
  /** 0 (tired) to 1 (rested). Expressive only, never a capability limit. */
  energy: number
}
export interface PersonaObserverSettings {
  enabled: boolean
  /** Both absent means inherit the conversation model and thinking level. */
  provider?: string
  modelId?: string
  thinking?: ThinkingLevel
}
export interface PersonaMoodHistory extends PersonaMoodValues {
  feeling: string
  trigger: string
  timestamp: number
}
export interface PersonaSnapshot {
  active: boolean
  files: PersonaDocument[]
  mood: PersonaMoodValues & {
    feeling: string
    description: string
    automatic: boolean
    observer: PersonaObserverSettings
    history: PersonaMoodHistory[]
  }
}
export type PersonaObserverUsageRange = 7 | 30 | 'all'
export const PERSONA_OBSERVER_OUTCOMES = ['changed', 'unchanged', 'invalid', 'error', 'timeout', 'aborted'] as const
export type PersonaObserverOutcome = typeof PERSONA_OBSERVER_OUTCOMES[number]
export interface PersonaObserverUsageTotals {
  requests: number
  /** Requests whose provider reported usage; token and cost sums cover only these. */
  measured: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  cost: number
  durationMs: number
  /** The observer's conservative UTF-8 byte budget estimate, summed over measured requests. */
  estimatedInput: number
}
export interface PersonaObserverUsageModel extends PersonaObserverUsageTotals {
  provider: string
  modelId: string
  /** Conversation model rather than a configured observer model. */
  inherited: boolean
  thinking: ThinkingLevel
}
export interface PersonaObserverUsageSummary {
  range: PersonaObserverUsageRange
  totals: PersonaObserverUsageTotals
  models: PersonaObserverUsageModel[]
  outcomes: Record<PersonaObserverOutcome, number>
}
export interface PersonaApi {
  get(): Promise<PersonaSnapshot>
  saveFile(document: PersonaDocument): Promise<PersonaSnapshot>
  setMood(values: PersonaMoodValues): Promise<PersonaSnapshot>
  setObserver(settings: PersonaObserverSettings): Promise<PersonaSnapshot>
  setAutomatic(enabled: boolean): Promise<PersonaSnapshot>
  observerUsage(range: PersonaObserverUsageRange): Promise<PersonaObserverUsageSummary>
  clearObserverUsage(): Promise<void>
  /** Any persona file, mood or control write, from the settings page or a conversation. */
  onChanged(listener: () => void): () => void
}
