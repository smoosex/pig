/* Settings API for Pig's single global persona; no active Pi session is required. */
import { createHash } from 'node:crypto'
import {
  PERSONA_FILES, type PersonaDocument, type PersonaMoodValues,
  type PersonaObserverSettings, type PersonaSnapshot,
} from '../../../shared/persona'
import { revision } from './documents'
import { notifyPersonaControlsChanged } from './controls'
import { validateMood, validateObserver } from './mood-engine'
import { personaTransaction, readPersona, snapshot, type PersonaView } from './kernel'

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

export interface PersonaControls {
  automatic: boolean
  /** Current values after decay. */
  mood: PersonaMoodValues
  feeling: string
  revision: string
}

export interface PersonaControlsPatch {
  automatic?: boolean
  mood?: Partial<PersonaMoodValues>
}

// Activity leases persist decayed mood values, so stored mood cannot be the conflict basis. Every
// deliberate change bumps a counter instead: manual and Pig controls bump controlsRevision, and
// observations and manual moods append history. A background observation therefore still conflicts.
function controls(view: PersonaView): PersonaControls {
  const stored = view.engine.persistent
  const { pleasantness, activation, energy, feeling } = view.engine.state
  return {
    automatic: stored.emotionUpdatesEnabled,
    mood: { pleasantness, activation, energy },
    feeling,
    revision: createHash('sha256').update(JSON.stringify([
      stored.emotionUpdatesEnabled, stored.controlsRevision, stored.nextHistorySequence
    ])).digest('hex')
  }
}

export function getPersonaControls(): Promise<PersonaControls> {
  return readPersona(controls)
}

/** Mood and automatic changes in one locked transaction; `expectedRevision` is checked under the lock. */
export async function updatePersonaControls(patch: PersonaControlsPatch, expectedRevision?: string): Promise<PersonaControls> {
  if (patch.automatic !== undefined && typeof patch.automatic !== 'boolean') throw new Error('Persona automatic setting must be a boolean')
  return personaTransaction(transaction => {
    if (expectedRevision !== undefined && controls(transaction).revision !== expectedRevision) {
      throw new Error('Persona revision conflict; read the settings again before saving')
    }
    const engine = transaction.engine
    engine.persistent.controlsRevision++
    if (patch.mood) {
      const { pleasantness, activation, energy } = engine.state
      const values = { pleasantness, activation, energy, ...patch.mood }
      validateMood(values)
      engine.setMood(values, 'manual_set')
      transaction.appendHistory()
    }
    if (patch.automatic !== undefined) {
      engine.persistent.emotionUpdatesEnabled = patch.automatic
      engine.persistent.lastInteraction = Date.now()
    }
    transaction.markChanged()
    return controls(transaction)
  }).then((result) => {
    notifyPersonaControlsChanged()
    return result
  })
}
