/* One global persona and mood, shared by all Pig conversations. */
export const PERSONA_FILES = ['SOUL.md', 'IDENTIFY.md', 'USER.md'] as const
export type PersonaFileName = typeof PERSONA_FILES[number]
export const PERSONA_EMOTIONS = ['joy', 'trust', 'fear', 'surprise', 'sadness', 'disgust', 'anger', 'anticipation'] as const
export type PersonaEmotion = typeof PERSONA_EMOTIONS[number]
export interface PersonaDocument {
  name: PersonaFileName
  content: string
  revision: string | null
}
export interface PersonaSnapshot {
  active: boolean
  files: PersonaDocument[]
  mood: {
    emotion: PersonaEmotion
    /** Normalized strength, from 0 to 1. */
    intensity: number
    angle: number
    level: 1 | 2 | 3
    compound?: string
    description: string
    phrase: string
    automatic: boolean
    history: { emotion: PersonaEmotion; intensity: number; trigger: string; timestamp: number }[]
  }
}
export interface PersonaApi {
  get(): Promise<PersonaSnapshot>
  saveFile(document: PersonaDocument): Promise<PersonaSnapshot>
  /** intensity is normalized from 0 to 1, not a percentage. */
  setEmotion(emotion: PersonaEmotion, intensity: number): Promise<PersonaSnapshot>
  setAutomatic(enabled: boolean): Promise<PersonaSnapshot>
}
