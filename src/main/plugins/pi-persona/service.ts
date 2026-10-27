/* Settings API for Pig's single global persona; no active Pi session is required. */
import {
  PERSONA_FILES, type PersonaDocument, type PersonaMoodValues,
  type PersonaObserverSettings, type PersonaSnapshot,
} from '../../../shared/persona'
import { revision } from './documents'
import { notifyPersonaControlsChanged } from './controls'
import { validateMood, validateObserver } from './mood-engine'
import { personaTransaction, readPersona, snapshot } from './kernel'

function controlsChanged(result: PersonaSnapshot): PersonaSnapshot {
  notifyPersonaControlsChanged()
  return result
}

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
  })).then(controlsChanged)
}

export async function setPersonaMood(values: PersonaMoodValues): Promise<PersonaSnapshot> {
  validateMood(values)
  return personaTransaction(transaction => {
    transaction.engine.persistent.controlsRevision++
    transaction.engine.setMood({ pleasantness: values.pleasantness, activation: values.activation, energy: values.energy }, 'manual_set')
    transaction.appendHistory()
    return snapshot(transaction)
  }).then(controlsChanged)
}

export async function setPersonaObserver(settings: PersonaObserverSettings): Promise<PersonaSnapshot> {
  validateObserver(settings)
  return personaTransaction(transaction => {
    transaction.engine.persistent.controlsRevision++
    transaction.engine.persistent.observer = settings.provider === undefined
      ? { enabled: settings.enabled }
      : { enabled: settings.enabled, provider: settings.provider, modelId: settings.modelId,
        ...(settings.thinking !== undefined ? { thinking: settings.thinking } : {}) }
    transaction.markChanged()
    return snapshot(transaction)
  }).then(controlsChanged)
}

export async function setPersonaAutomatic(enabled: boolean): Promise<PersonaSnapshot> {
  if (typeof enabled !== 'boolean') throw new Error('Persona automatic setting must be a boolean')
  return personaTransaction(transaction => {
    transaction.engine.persistent.controlsRevision++
    transaction.engine.persistent.emotionUpdatesEnabled = enabled
    transaction.engine.persistent.lastInteraction = Date.now()
    transaction.markChanged()
    return snapshot(transaction)
  }).then(controlsChanged)
}
