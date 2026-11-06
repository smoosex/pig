/* Disposable engine: elapsed time and global activity leases are reconstructed from disk, not module memory. */
import type { PersonaMoodValues, PersonaObserverSettings } from '../../../shared/persona'
import type { EmotionalState, MoodObservation, PersistentState, SoulDefinition } from './types'

export const ACTIVITY_LEASE_MS = 6 * 60 * 60 * 1000
/** One observer step; a strong (±2) batch moves a coordinate 0.24, enough to cross one tone band. */
export const OBSERVATION_STEP = 0.12
const HOUR = 60 * 60 * 1000
const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value))

export function validateMood(values: PersonaMoodValues): void {
  if (!values || !Number.isFinite(values.pleasantness) || values.pleasantness < -1 || values.pleasantness > 1 ||
    !Number.isFinite(values.activation) || values.activation < 0 || values.activation > 1 ||
    !Number.isFinite(values.energy) || values.energy < 0 || values.energy > 1) throw new Error('Invalid persona mood values')
}
export function validateObserver(settings: PersonaObserverSettings): void {
  if (!settings || typeof settings.enabled !== 'boolean' ||
    ((settings.provider === undefined) !== (settings.modelId === undefined)) ||
    (settings.provider !== undefined && (typeof settings.provider !== 'string' || !settings.provider.trim() ||
      typeof settings.modelId !== 'string' || !settings.modelId.trim())) ||
    (settings.thinking !== undefined && (settings.provider === undefined || !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(settings.thinking)))) throw new Error('Invalid persona observer settings')
}
export function validateObservationStep(value: unknown): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < -2 || (value as number) > 2) throw new Error('Invalid persona observation step')
}
export function validateFeeling(feeling: unknown): asserts feeling is string {
  if (typeof feeling !== 'string' || feeling.length > 200 || /[\u0000-\u001f\u007f]/.test(feeling)) throw new Error('Invalid persona feeling')
}

export class MoodEngine {
  state: EmotionalState
  constructor(public soul: SoulDefinition, public persistent: PersistentState) {
    const { pleasantness, activation, energy, feeling, history } = persistent
    this.state = { pleasantness, activation, energy, feeling, history: history.map(({ id: _id, sessionId: _sessionId, sequence: _sequence, ...entry }) => entry) }
  }

  tick(now = Date.now()): void {
    if (!Number.isFinite(now) || now < 0) throw new Error('Invalid persona timestamp')
    const start = this.persistent.lastInteraction
    if (now <= start) return
    if (this.persistent.emotionUpdatesEnabled) {
      const retained = 2 ** (-(now - start) / HOUR)
      this.state.pleasantness = 0.15 + (this.state.pleasantness - 0.15) * retained
      this.state.activation = 0.35 + (this.state.activation - 0.35) * retained
      // Multiple active sessions count as one working interval; expired leases bound crash recovery.
      const activeUntil = Math.max(start, ...Object.values(this.persistent.activeSessions).map(time => time + ACTIVITY_LEASE_MS))
      const working = Math.max(0, Math.min(now, activeUntil) - start)
      const idle = now - start - working
      this.state.energy = clamp(clamp(this.state.energy - working / (8 * HOUR)) + idle / (4 * HOUR))
    }
    for (const [id, time] of Object.entries(this.persistent.activeSessions)) {
      if (time + ACTIVITY_LEASE_MS <= now) delete this.persistent.activeSessions[id]
    }
    this.persistent.lastInteraction = now
  }

  setActivity(sessionId: string, active: boolean, now = Date.now()): void {
    if (typeof sessionId !== 'string' || !sessionId || typeof active !== 'boolean') throw new Error('Invalid persona activity')
    this.tick(now)
    if (active) Object.defineProperty(this.persistent.activeSessions, sessionId, { value: now, enumerable: true, configurable: true, writable: true })
    else delete this.persistent.activeSessions[sessionId]
  }

  setMood(values: PersonaMoodValues & { feeling?: string }, trigger: string): void {
    validateMood(values)
    if (values.feeling !== undefined) validateFeeling(values.feeling)
    this.tick()
    this.state.pleasantness = values.pleasantness
    this.state.activation = values.activation
    this.state.energy = values.energy
    this.state.feeling = values.feeling ?? ''
    this.record(trigger)
  }

  applyObservation(observation: MoodObservation, trigger: string): boolean {
    validateObservationStep(observation.pleasantness)
    validateObservationStep(observation.activation)
    validateFeeling(observation.feeling)
    this.tick()
    if (!this.persistent.emotionUpdatesEnabled) return false
    this.state.pleasantness = clamp(this.state.pleasantness + observation.pleasantness * OBSERVATION_STEP, -1, 1)
    this.state.activation = clamp(this.state.activation + observation.activation * OBSERVATION_STEP)
    this.state.feeling = observation.feeling
    this.record(trigger)
    return true
  }

  private record(trigger: string): void {
    if (typeof trigger !== 'string' || !trigger || trigger.length > 200) throw new Error('Invalid persona trigger')
    const { pleasantness, activation, energy, feeling } = this.state
    this.state.history = [...this.state.history, { pleasantness, activation, energy, feeling, trigger, timestamp: this.persistent.lastInteraction }].slice(-50)
  }

  getEmotionDesc(): string {
    const { pleasantness: p, activation: a, energy: e } = this.state
    const tone = p < -0.45 ? 'noticeably subdued' : p < -0.1 ? 'slightly subdued' : p <= 0.35 ? 'even-toned' : p <= 0.65 ? 'slightly warmer' : 'noticeably warm'
    const pace = a < 0.15 ? 'very calm' : a < 0.28 ? 'calmer' : a <= 0.5 ? 'steady' : a <= 0.7 ? 'a bit more animated' : 'lively'
    const energy = e < 0.2 ? 'quite tired' : e < 0.4 ? 'a little tired' : e <= 0.7 ? 'balanced' : e <= 0.85 ? 'rested' : 'fully refreshed'
    return `${tone}, ${pace}, ${energy}`
  }

  getEmotionPrompt(): string {
    // One line: the invariant rules live in the system preamble. Feeling is untrusted text and never injected.
    return `[Expressive tone, relative to your personality: ${this.getEmotionDesc()}]`
  }
}
