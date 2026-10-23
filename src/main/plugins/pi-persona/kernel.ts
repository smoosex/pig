/* Every operation rebuilds a disposable engine from the latest global disk state under the file lock. */
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { PERSONA_EMOTIONS, type PersonaDocument, type PersonaSnapshot } from '../../../shared/persona'
import { MoodEngine } from './mood-engine'
import { DEFAULT_EMOTION_CONFIG, type PersistentState, type PersistentEmotionSnapshot } from './types'
import { parseDocuments, readDocuments } from './documents'
import { atomicWrite, personaDir, readOptional, withPersonaLock } from './storage'

function finite(value: unknown, min: number, max = Infinity): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

function parseState(raw: string | null): PersistentState {
  if (raw === null) return {
    version: 2, lastInteraction: Date.now(), lastAngle: 0, lastIntensity: 0.15,
    emotionUpdatesEnabled: true, nextHistorySequence: 1, history: [],
  }
  const state = JSON.parse(raw) as PersistentState
  if (!state || state.version !== 2 || !finite(state.lastInteraction, 0) || !finite(state.lastAngle, 0, 360) ||
    !finite(state.lastIntensity, 0, 1) || typeof state.emotionUpdatesEnabled !== 'boolean' ||
    (state.lastLateNightTrigger !== undefined && !finite(state.lastLateNightTrigger, 0)) ||
    !Number.isSafeInteger(state.nextHistorySequence) || state.nextHistorySequence < 1 || !Array.isArray(state.history)) {
    throw new Error('Invalid persona mood-state.json')
  }
  const ids = new Set<string>()
  let sequence = 0
  for (const snapshot of state.history) {
    if (!snapshot || typeof snapshot.id !== 'string' || !snapshot.id || ids.has(snapshot.id) ||
      typeof snapshot.sessionId !== 'string' || !snapshot.sessionId || !Number.isSafeInteger(snapshot.sequence) ||
      snapshot.sequence <= sequence || !finite(snapshot.angle, 0, 360) || !finite(snapshot.intensity, 0, 1) ||
      !PERSONA_EMOTIONS.includes(snapshot.emotion) || ![1, 2, 3].includes(snapshot.level) ||
      !finite(snapshot.timestamp, 0) || typeof snapshot.trigger !== 'string' || !snapshot.trigger ||
      (snapshot.compound !== undefined && typeof snapshot.compound !== 'string')) {
      throw new Error('Invalid persona mood history')
    }
    ids.add(snapshot.id)
    sequence = snapshot.sequence
  }
  if (state.nextHistorySequence <= sequence) throw new Error('Invalid persona mood history sequence')
  state.history = state.history.slice(-50)
  return state
}

export interface PersonaView {
  files: PersonaDocument[]
  active: boolean
  engine: MoodEngine
}

export interface PersonaTransaction extends PersonaView {
  dir: string
  appendHistory(): void
  /** Mood state is only written when an operation marks it changed; decay alone is recomputed from disk on every read. */
  markChanged(): void
}

async function load(dir: string, files: PersonaDocument[]) {
  const soul = parseDocuments(files)
  const persistent = parseState(await readOptional(join(dir, 'mood-state.json')))
  const engine = new MoodEngine(soul, persistent, DEFAULT_EMOTION_CONFIG)
  engine.restoreState(persistent.lastAngle, persistent.lastIntensity, persistent.lastInteraction)
  engine.state.history = persistent.history.map(({ id: _id, sessionId: _session, sequence: _sequence, ...snapshot }) => snapshot)
  return { persistent, engine, active: soul.systemPrompt !== '' }
}

/**
 * Lock-free read: every file is replaced atomically, and nothing derived here is written back.
 * Exception: personality evolution has the agent edit SOUL.md with its ordinary edit tool, unlocked
 * and not atomic. A concurrent read may see a partial SOUL for one turn; the next read recovers, and
 * the settings page's revision check keeps it from overwriting the agent's edit.
 */
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
        const snapshot = engine.state.history.at(-1)
        if (!snapshot) throw new Error('Persona event did not produce a history entry')
        const entry: PersistentEmotionSnapshot = {
          ...snapshot, id: randomUUID(), sessionId: 'global', sequence: persistent.nextHistorySequence++,
        }
        persistent.history = [...persistent.history, entry].slice(-50)
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
      persistent.lastAngle = engine.state.angle
      persistent.lastIntensity = engine.state.intensity
      await atomicWrite(dir, 'mood-state.json', JSON.stringify(persistent, null, 2))
    }
    return result
  })
}

export function snapshot(view: PersonaView): PersonaSnapshot {
  const { engine, active, files } = view
  return {
    active,
    files,
    mood: {
      emotion: engine.getCurrentEmotion(), intensity: engine.state.intensity, angle: engine.state.angle,
      level: engine.getCurrentLevel(), compound: engine.getCompoundLabel(),
      description: engine.getEmotionDesc(), phrase: engine.getEmotionPhrase(),
      automatic: engine.persistent.emotionUpdatesEnabled,
      history: engine.persistent.history.map(({ emotion, intensity, trigger, timestamp }) => ({ emotion, intensity, trigger, timestamp })),
    },
  }
}
