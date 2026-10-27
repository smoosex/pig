/* Every operation rebuilds a disposable engine from global disk state; only transactions write under the file lock. */
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { PersonaDocument, PersonaSnapshot } from '../../../shared/persona'
import { MoodEngine, validateFeeling, validateMood, validateObserver } from './mood-engine'
import type { PersistentState, PersistentEmotionSnapshot } from './types'
import { parseDocuments, readDocuments } from './documents'
import { atomicWrite, personaDir, readOptional, withPersonaLock } from './storage'

const finite = (value: unknown, min: number, max = Infinity): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const legacyEmotions = ['joy', 'trust', 'fear', 'surprise', 'sadness', 'disgust', 'anger', 'anticipation']
const valence = [0.9, 0.65, -0.65, 0.1, -0.8, -0.65, -0.8, 0.45]
const activation = [0.65, 0.3, 0.8, 0.85, 0.2, 0.5, 0.85, 0.65]

function legacyValues(angle: number, intensity: number) {
  const index = Math.floor((angle % 360 + 22.5) / 45) % 8
  return { pleasantness: 0.15 + (valence[index] - 0.15) * intensity, activation: 0.35 + (activation[index] - 0.35) * intensity, energy: 0.75 }
}

export function createPersistentState(now = Date.now()): PersistentState {
  return { version: 3, pleasantness: 0.15, activation: 0.35, energy: 0.75, feeling: '',
    lastInteraction: now, emotionUpdatesEnabled: true, controlsRevision: 0, observer: { enabled: true },
    activeSessions: {}, nextHistorySequence: 1, history: [] }
}

function parseState(raw: string | null): PersistentState {
  if (raw === null) return createPersistentState()
  const state: unknown = JSON.parse(raw)
  if (!object(state) || ![2, 3].includes(state.version as number) || !finite(state.lastInteraction, 0) ||
    typeof state.emotionUpdatesEnabled !== 'boolean' || !Number.isSafeInteger(state.nextHistorySequence) ||
    (state.nextHistorySequence as number) < 1 || !Array.isArray(state.history)) throw new Error('Invalid persona mood-state.json')
  const legacy = state.version === 2
  if (legacy) {
    if (!finite(state.lastAngle, 0, 360) || !finite(state.lastIntensity, 0, 1) ||
      (state.lastLateNightTrigger !== undefined && !finite(state.lastLateNightTrigger, 0))) throw new Error('Invalid persona legacy mood state')
  } else {
    if (!Number.isSafeInteger(state.controlsRevision) || (state.controlsRevision as number) < 0) throw new Error('Invalid persona controls revision')
    validateMood(state as unknown as PersistentState)
    validateFeeling(state.feeling)
    if (!object(state.observer)) throw new Error('Invalid persona observer')
    validateObserver(state.observer as unknown as PersistentState['observer'])
    if (!object(state.activeSessions) || Object.entries(state.activeSessions).some(([id, time]) => !id || !finite(time, 0))) throw new Error('Invalid persona activity state')
  }
  const ids = new Set<string>()
  let sequence = 0
  const history: PersistentEmotionSnapshot[] = []
  for (const entry of state.history) {
    if (!object(entry) || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) ||
      typeof entry.sessionId !== 'string' || !entry.sessionId || !Number.isSafeInteger(entry.sequence) ||
      (entry.sequence as number) <= sequence || !finite(entry.timestamp, 0) || typeof entry.trigger !== 'string' || !entry.trigger || entry.trigger.length > 200) throw new Error('Invalid persona mood history')
    if (legacy) {
      if (!finite(entry.angle, 0, 360) || !finite(entry.intensity, 0, 1) ||
        !legacyEmotions.includes(entry.emotion as string) || ![1, 2, 3].includes(entry.level as number) ||
        (entry.compound !== undefined && typeof entry.compound !== 'string')) throw new Error('Invalid persona legacy mood history')
    } else {
      validateMood(entry as unknown as PersistentEmotionSnapshot)
      validateFeeling(entry.feeling)
    }
    ids.add(entry.id)
    sequence = entry.sequence as number
    history.push({ ...(legacy ? { ...legacyValues(entry.angle as number, entry.intensity as number), feeling: '' } : {
      pleasantness: entry.pleasantness as number, activation: entry.activation as number, energy: entry.energy as number, feeling: entry.feeling as string,
    }), id: entry.id, sessionId: entry.sessionId, sequence, timestamp: entry.timestamp, trigger: entry.trigger })
  }
  if ((state.nextHistorySequence as number) <= sequence) throw new Error('Invalid persona mood history sequence')
  if (!legacy) return { ...state, history: history.slice(-50) } as unknown as PersistentState
  return { ...createPersistentState(state.lastInteraction), ...legacyValues(state.lastAngle as number, state.lastIntensity as number),
    emotionUpdatesEnabled: state.emotionUpdatesEnabled, nextHistorySequence: state.nextHistorySequence as number, history: history.slice(-50) }
}

export interface PersonaView { files: PersonaDocument[]; active: boolean; engine: MoodEngine }
export interface PersonaTransaction extends PersonaView {
  dir: string
  appendHistory(): void
  markChanged(): void
}
async function load(dir: string, files: PersonaDocument[]) {
  const soul = parseDocuments(files)
  const persistent = parseState(await readOptional(join(dir, 'mood-state.json')))
  // All Pig sessions share this host process. A restarted host must not keep working for a crashed PID.
  for (const id of Object.keys(persistent.activeSessions)) {
    if (id.startsWith('pid/') && id.split('/')[1] !== String(process.pid)) delete persistent.activeSessions[id]
  }
  const engine = new MoodEngine(soul, persistent)
  engine.tick()
  return { persistent, engine, active: soul.systemPrompt !== '' }
}

/** Atomic file reads never acquire a lock or persist decay/migration. SOUL evolution remains an unlocked agent edit. */
export async function readPersona<T>(action: (view: PersonaView) => T): Promise<T> {
  const dir = personaDir()
  const files = await readDocuments(dir)
  const { engine, active } = await load(dir, files)
  return action({ files, active, engine })
}
export async function personaTransaction<T>(
  action: (transaction: PersonaTransaction) => Promise<T> | T,
  prepare?: (files: PersonaDocument[]) => Promise<PersonaDocument[]> | PersonaDocument[],
): Promise<T> {
  return withPersonaLock(async dir => {
    const original = await readDocuments(dir)
    const files = prepare ? await prepare(original) : original
    const { persistent, engine, active } = await load(dir, files)
    let changed = false
    const transaction: PersonaTransaction = {
      dir, files, active, engine,
      appendHistory() {
        const entry = engine.state.history.at(-1)
        if (!entry) throw new Error('Persona event did not produce a history entry')
        persistent.history = [...persistent.history, { ...entry, id: randomUUID(), sessionId: 'global', sequence: persistent.nextHistorySequence++ }].slice(-50)
        changed = true
      },
      markChanged() { changed = true },
    }
    const result = await action(transaction)
    for (const file of files) {
      const previous = original.find(candidate => candidate.name === file.name)!
      if (previous.revision === file.revision) continue
      if (file.revision === null) await fs.rm(join(dir, file.name), { force: true })
      else await atomicWrite(dir, file.name, file.content)
    }
    if (changed) {
      const { pleasantness, activation, energy, feeling } = engine.state
      Object.assign(persistent, { pleasantness, activation, energy, feeling })
      await atomicWrite(dir, 'mood-state.json', JSON.stringify(persistent, null, 2))
    }
    return result
  })
}

/** Session lifecycle callers release on end/reload, and renew long-running activity before the six-hour lease expires. */
export async function setActivity(sessionId: string, active: boolean, now = Date.now()): Promise<void> {
  if (typeof sessionId !== 'string' || !sessionId || typeof active !== 'boolean' || !finite(now, 0)) throw new Error('Invalid persona activity')
  const needed = await readPersona(view => active ? view.active : Object.hasOwn(view.engine.persistent.activeSessions, sessionId))
  if (!needed) return
  await personaTransaction(transaction => {
    if (active && !transaction.active) return
    transaction.engine.setActivity(sessionId, active, now)
    transaction.markChanged()
  })
}
export function snapshot(view: PersonaView): PersonaSnapshot {
  const { engine, active, files } = view
  const { pleasantness, activation, energy, feeling } = engine.state
  return { active, files, mood: { pleasantness, activation, energy, feeling,
    description: engine.getEmotionDesc(), automatic: engine.persistent.emotionUpdatesEnabled,
    observer: { ...engine.persistent.observer },
    history: engine.persistent.history.map(({ id: _id, sessionId: _sessionId, sequence: _sequence, ...entry }) => entry),
  } }
}
