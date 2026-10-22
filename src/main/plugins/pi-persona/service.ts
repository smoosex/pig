/* Settings API for Pig's single global persona; no active Pi session is required. */
import {
  PERSONA_FILES, PERSONA_EMOTIONS, type PersonaDocument, type PersonaEmotion,
  type PersonaSnapshot,
} from '../../../shared/persona'
import { revision } from './documents'
import { personaTransaction, readPersona, snapshot } from './kernel'

function checkRevision(actual: string | null, expected: unknown, name: string): void {
  if (expected !== null && (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected))) {
    throw new Error(`Invalid persona revision for ${name}`)
  }
  if (actual !== expected) throw new Error(`Persona revision conflict for ${name}; reload before saving`)
}

export async function getPersona(): Promise<PersonaSnapshot> {
  return readPersona(snapshot)
}

export async function savePersonaFile(document: PersonaDocument): Promise<PersonaSnapshot> {
  if (!document || !PERSONA_FILES.includes(document.name) || typeof document.content !== 'string') {
    throw new Error('Invalid persona document')
  }
  return personaTransaction(snapshot, files => files.map(file => {
    if (file.name !== document.name) return file
    checkRevision(file.revision, document.revision, file.name)
    return { name: file.name, content: document.content, revision: revision(document.content) }
  }))
}

export async function setPersonaEmotion(emotion: PersonaEmotion, intensity: number): Promise<PersonaSnapshot> {
  if (!PERSONA_EMOTIONS.includes(emotion) || typeof intensity !== 'number' || !Number.isFinite(intensity) || intensity < 0 || intensity > 1) {
    throw new Error('Persona emotion must be valid and intensity must be between 0 and 1')
  }
  return personaTransaction(transaction => {
    transaction.engine.setEmotion(emotion, intensity, 'manual_set')
    transaction.appendHistory()
    return snapshot(transaction)
  })
}

export async function setPersonaAutomatic(enabled: boolean): Promise<PersonaSnapshot> {
  if (typeof enabled !== 'boolean') throw new Error('Persona automatic setting must be a boolean')
  return personaTransaction(transaction => {
    transaction.engine.persistent.emotionUpdatesEnabled = enabled
    transaction.engine.persistent.lastInteraction = Date.now()
    transaction.markChanged()
    return snapshot(transaction)
  })
}
