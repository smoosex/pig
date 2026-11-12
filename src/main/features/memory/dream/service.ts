/** Manual topic-driven Dream. One restricted runtime and one staged publication per run;
 * history is searched on demand, never drained as a queue or marked globally processed. */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DREAM_TOKEN_LIMIT, DREAM_COST_LIMIT, dreamTokens, type DreamRequest, type DreamStatus } from '../../../../shared/dream'
import { pigPath } from '../../../pig-dir'
import { getMemorySettings } from '../../memory-settings'
import { onPermissionsChanged, readPermissionSettings } from '../../../permissions/store'
import { DreamHistory, loadDreamSources } from './history'
import { DreamStage } from './staging'
import { runDreamWorker } from './runner'
import { registerDreamShutdown } from './lifecycle'

const idle = (): DreamStatus => ({ state: 'idle', changes: [], input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0, costKnown: true, requests: 0 })
export function validateDreamRequest(value: unknown): asserts value is DreamRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Dream request')
  const input = value as Record<string, unknown>
  if (Object.keys(input).length !== 1 || typeof input.topic !== 'string' || !input.topic.trim() || input.topic.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.topic)) throw new Error('DREAM_TOPIC: Provide a topic of 1 to 2000 characters')
}
export class DreamService {
  private value = idle()
  private flight?: { owner: number; controller: AbortController; done: Promise<void> }
  constructor(private readonly load = loadDreamSources, private readonly worker = runDreamWorker) {}
  status(): DreamStatus { return structuredClone(this.value) }
  start(owner: number, request: DreamRequest): DreamStatus {
    validateDreamRequest(request)
    if (this.flight) throw new Error('DREAM_BUSY: Another Dream is running')
    const controller = new AbortController()
    this.value = { ...idle(), id: randomUUID(), topic: request.topic.trim(), state: 'running', phase: 'preparing' }
    const flight = { owner, controller, done: Promise.resolve() }
    this.flight = flight
    flight.done = this.run(controller).catch(() => { this.value.state = 'error'; this.value.error = 'DREAM_FAILED' })
      .finally(() => { if (this.flight === flight) this.flight = undefined })
    return this.status()
  }
  async stop(owner?: number): Promise<DreamStatus> {
    const flight = this.flight
    if (flight && owner !== undefined && owner !== flight.owner) throw new Error('Dream belongs to another window')
    if (flight) { flight.controller.abort(new Error('DREAM_CANCELLED')); await flight.done }
    return this.status()
  }
  cancelOwner(owner: number): void { if (this.flight?.owner === owner) this.flight.controller.abort(new Error('DREAM_CANCELLED')) }
  private async run(controller: AbortController): Promise<void> {
    const signal = controller.signal, startedAt = Date.now()
    const directory = pigPath('dream', this.value.id!)
    let unsubscribe = () => {}
    try {
      const initialMode = readPermissionSettings().defaultMode
      const check = () => {
        signal.throwIfAborted()
        if (initialMode === 'read-only' || readPermissionSettings().defaultMode !== initialMode) throw new Error('DREAM_PERMISSION: Permission mode changed; start a new Dream')
      }
      unsubscribe = onPermissionsChanged(() => { try { check() } catch { controller.abort(new Error('DREAM_PERMISSION')) } })
      check()
      if (!(await getMemorySettings()).fileMemory?.enabled) throw new Error('DREAM_DISABLED')
      const sources = await this.load(signal)
      check()
      const progress = (phase: DreamStatus['phase'], current: string) => {
        if (!this.value.wrappingUp) { this.value.phase = phase; this.value.current = current }
      }
      const history = new DreamHistory(sources, signal, progress)
      const stage = new DreamStage(directory)
      this.value.report = await this.worker({ directory, topic: this.value.topic!, history, signal, check,
        transcript: () => { this.value.sessionFile = 'session.jsonl' },
        progress,
        usage: usage => {
          for (const key of ['input', 'cacheRead', 'cacheWrite', 'output', 'requests'] as const) this.value[key] += usage[key]
          if (usage.cost === null) this.value.costKnown = false
          else this.value.cost += usage.cost
          const tokens = dreamTokens(this.value)
          const hard = tokens >= DREAM_TOKEN_LIMIT ? { kind: 'tokens' as const, used: tokens, limit: DREAM_TOKEN_LIMIT }
            : this.value.cost >= DREAM_COST_LIMIT ? { kind: 'cost' as const, used: this.value.cost, limit: DREAM_COST_LIMIT } : undefined
          if (hard && !signal.aborted) {
            this.value.budgetStop = hard
            controller.abort(new Error(hard.kind === 'tokens' ? 'DREAM_TOKEN_BUDGET' : 'DREAM_COST_BUDGET'))
          } else if (!this.value.wrappingUp && (tokens >= DREAM_TOKEN_LIMIT * 0.8 || this.value.cost >= DREAM_COST_LIMIT * 0.8)) {
            this.value.wrappingUp = tokens >= DREAM_TOKEN_LIMIT * 0.8 ? 'tokens' : 'cost'
            this.value.phase = 'wrappingUp'
            this.value.current = undefined
          }
          return this.value.wrappingUp
        }
      })
      check()
      if (!(await getMemorySettings()).fileMemory?.enabled) throw new Error('DREAM_DISABLED')
      await history.validateReadSources(); check()
      this.value.phase = 'publishing'
      this.value.changes = stage.publish(history.writableScopes(), check)
      this.value.state = 'done'
    } catch (error) {
      const reason = signal.aborted ? signal.reason : error
      const code = reason instanceof Error ? /^DREAM_[A-Z_]+/.exec(reason.message)?.[0] : undefined
      this.value.state = this.value.budgetStop ? 'limited' : signal.aborted && code === 'DREAM_CANCELLED' ? 'cancelled' : 'error'
      this.value.error = code ?? 'DREAM_FAILED'
      this.value.report = undefined
    } finally {
      unsubscribe(); this.value.phase = undefined
      try {
        rmSync(join(directory, 'staged'), { recursive: true, force: true })
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        writeFileSync(join(directory, 'result.json'), JSON.stringify({ ...this.value, startedAt, endedAt: Date.now() }), { mode: 0o600, flag: 'wx' })
      } catch { this.value.state = 'error'; this.value.error = 'DREAM_STATE' }
    }
  }
}
export const dreamService = new DreamService()
registerDreamShutdown(() => dreamService.stop())
