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
export interface PersonaApi {
  get(): Promise<PersonaSnapshot>
  saveFile(document: PersonaDocument): Promise<PersonaSnapshot>
  setMood(values: PersonaMoodValues): Promise<PersonaSnapshot>
  setObserver(settings: PersonaObserverSettings): Promise<PersonaSnapshot>
  setAutomatic(enabled: boolean): Promise<PersonaSnapshot>
  /** Any persona file, mood or control write, from the settings page or a conversation. */
  onChanged(listener: () => void): () => void
}
