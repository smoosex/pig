/** Manual topic-driven Dream. One restricted runtime and one staged publication per run;
 * history is searched on demand, never drained as a queue or marked globally processed. */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DREAM_TOKEN_LIMIT, DREAM_COST_LIMIT, dreamTokens, type DreamAuditProject, type DreamRequest, type DreamStatus } from '../../../../shared/dream'
import { pigPath } from '../../../pig-dir'
import { currentLocale } from '../../../i18n'
import { getMemorySettings } from '../../memory-settings'
import { onPermissionsChanged, readPermissionSettings } from '../../../permissions/store'
import { MemoryFiles, memoryRoot } from '../long-term/files'
import { memoryScopeOf } from '../long-term/inventory'
import { auditKeepKey, commitAuditKeeps, readTelemetryWindow } from '../telemetry/store'
import type { AuditKeptEntry } from '../telemetry/types'
import { buildAuditHealthReport, matchesClickbaitSource, matchesStructuralKeep, type AuditHealthReport } from './audit'
import { auditUiLanguageName } from './audit-prompt'
import { DreamHistory, loadDreamSources } from './history'
import { DreamStage } from './staging'
import { runDreamWorker, type DreamWorkerOptions } from './runner'
import { registerDreamShutdown } from './lifecycle'

const HEX_64_RE = /^[a-f0-9]{64}$/
const idle = (): DreamStatus => ({ state: 'idle', changes: [], input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0, costKnown: true, requests: 0 })
export function validateDreamRequest(value: unknown): asserts value is DreamRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Dream request')
  const input = value as Record<string, unknown>
  const keys = Object.keys(input)
  if (keys.length === 1 && input.repair === true) return
  if (keys.length === 2 && input.audit === true) {
    const scope = input.scope as Record<string, unknown> | undefined
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new Error('DREAM_SCOPE: Invalid audit scope')
    const scopeKeys = Object.keys(scope)
    if (scopeKeys.length === 1 && (scope.kind === 'all' || scope.kind === 'global')) return
    if (scopeKeys.length === 2 && scope.kind === 'project' && typeof scope.projectId === 'string' && HEX_64_RE.test(scope.projectId)) return
    throw new Error('DREAM_SCOPE: Invalid audit scope')
  }
  if (keys.length !== 1 || typeof input.topic !== 'string' || !input.topic.trim() || input.topic.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.topic)) throw new Error('DREAM_TOPIC: Provide a topic of 1 to 2000 characters')
}

async function listHostVerifiedProjects(): Promise<Map<string, DreamAuditProject>> {
  const { listMemoryFiles, listMemoryProjects } = await import('../long-term/catalog')
  const projects = new Map<string, DreamAuditProject>()
  for (const project of await listMemoryProjects()) {
    projects.set(project.id, { id: project.id, name: project.name })
  }
  for (const file of await listMemoryFiles()) {
    const scope = memoryScopeOf(file.path)
    if (scope?.startsWith('projects/')) {
      const id = scope.slice('projects/'.length)
      if (!projects.has(id)) projects.set(id, { id, ...(file.projectName ? { name: file.projectName } : {}) })
    }
  }
  return projects
}

export class DreamService {
  private value = idle()
  private flight?: { owner: number; controller: AbortController; done: Promise<void> }
  constructor(private readonly load = loadDreamSources, private readonly worker = runDreamWorker) {}
  status(): DreamStatus { return structuredClone(this.value) }
  async auditProjects(): Promise<DreamAuditProject[]> {
    const projects = await listHostVerifiedProjects()
    return [...projects.values()].sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id))
  }
  start(owner: number, request: DreamRequest): DreamStatus {
    validateDreamRequest(request)
    if (this.flight) throw new Error('DREAM_BUSY: Another Dream is running')
    const controller = new AbortController()
    this.value = {
      ...idle(),
      id: randomUUID(),
      ...('repair' in request
        ? { repair: true }
        : 'audit' in request
          ? { audit: true, auditScope: request.scope }
          : { topic: request.topic.trim() }),
      state: 'running',
      phase: 'preparing'
    }
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
    let published = false
    try {
      const initialMode = readPermissionSettings().defaultMode
      const check = () => {
        signal.throwIfAborted()
        if (initialMode === 'read-only' || readPermissionSettings().defaultMode !== initialMode) {
          const denied = new Error('DREAM_PERMISSION: Permission mode changed; start a new Dream')
          if (!signal.aborted) controller.abort(denied)
          throw denied
        }
      }
      unsubscribe = onPermissionsChanged(() => { try { check() } catch { controller.abort(new Error('DREAM_PERMISSION')) } })
      check()
      if (!this.value.repair && (await getMemorySettings()).fileMemory?.enabled === false) throw new Error('DREAM_DISABLED')
      const catalog = this.value.repair ? await (await import('../long-term/catalog')).listMemoryFiles() : undefined
      const misplaced = catalog?.filter(file => file.repairable).map(file => file.path)
      if (catalog?.some(file => /LIMIT$/.test(file.issue ?? ''))) throw new Error('DREAM_REPAIR: Resolve incomplete directory scans first')
      if (misplaced && !misplaced.length) throw new Error('DREAM_REPAIR: No repairable misplaced files')
      const projects = new Map<string, { id: string; name?: string; cwd?: string }>()
      if (this.value.repair) for (const project of await (await import('../long-term/catalog')).listMemoryProjects()) projects.set(project.id, project)
      for (const file of catalog ?? []) {
        const scope = memoryScopeOf(file.path)
        if (scope?.startsWith('projects/')) {
          const id = scope.slice('projects/'.length)
          if (!projects.has(id)) projects.set(id, { id, name: file.projectName })
        }
      }
      const repair = misplaced ? { misplaced, projects: [...projects.values()] } : undefined
      const sources = repair ? [] : await this.load(signal)
      check()
      const progress = (phase: DreamStatus['phase'], current: string) => {
        if (!this.value.wrappingUp) { this.value.phase = phase; this.value.current = current }
      }
      const history = new DreamHistory(sources, signal, progress)

      let verifiedAuditProjects: Map<string, DreamAuditProject> | undefined
      let frozenAuditReport: AuditHealthReport | undefined
      const pendingKeeps = new Map<string, AuditKeptEntry>()
      if (this.value.audit && this.value.auditScope) {
        verifiedAuditProjects = await listHostVerifiedProjects()
        const sourcesById = new Map(sources.map(source => [source.id, source]))
        if (this.value.auditScope.kind === 'project') {
          const targetId = this.value.auditScope.projectId
          if (!verifiedAuditProjects.has(targetId)) {
            const seenCwds = new Set<string>()
            for (const source of sources) {
              if (seenCwds.has(source.cwd)) continue
              seenCwds.add(source.cwd)
              const ctx = await history.context(source)
              if (ctx.projectId === targetId) {
                verifiedAuditProjects.set(targetId, { id: targetId, name: ctx.project })
                break
              }
            }
          }
          if (!verifiedAuditProjects.has(targetId)) {
            throw new Error('DREAM_SCOPE: Selected project could not be verified by the host')
          }
          this.value.auditProjectName = verifiedAuditProjects.get(targetId)?.name
        } else if (this.value.auditScope.kind === 'all') {
          const telemetry = readTelemetryWindow({ now: startedAt })
          const checkedSessions = new Set<string>()
          for (const row of telemetry.rows) {
            if (checkedSessions.has(row.sessionId)) continue
            const candidateIds = new Set<string>()
            if (row.projectId && !verifiedAuditProjects.has(row.projectId)) candidateIds.add(row.projectId)
            for (const op of row.ops) {
              if (op.scope === 'project' && op.projectId && !verifiedAuditProjects.has(op.projectId)) candidateIds.add(op.projectId)
            }
            if (!candidateIds.size) continue
            checkedSessions.add(row.sessionId)
            const source = sourcesById.get(row.sessionId)
            if (!source) continue
            const ctx = await history.context(source)
            if (ctx.projectId && candidateIds.has(ctx.projectId)) {
              verifiedAuditProjects.set(ctx.projectId, { id: ctx.projectId, name: ctx.project })
            }
          }
        }
        frozenAuditReport = await buildAuditHealthReport({
          scope: this.value.auditScope,
          history,
          verifiedProjects: verifiedAuditProjects,
          now: startedAt
        })
      }

      const topicHealth: DreamWorkerOptions['health'] = !repair && !this.value.audit
        ? async topicFilter => buildAuditHealthReport({
            scope: { kind: 'all' },
            history,
            verifiedProjects: await listHostVerifiedProjects(),
            topicFilter
          })
        : undefined

      const stage = new DreamStage(directory, undefined, misplaced ? new Set(misplaced) : undefined)
      this.value.report = await this.worker({ directory, topic: this.value.topic ?? '', history, repair,
        ...(this.value.audit && this.value.auditScope && verifiedAuditProjects && frozenAuditReport ? {
          audit: {
            scope: this.value.auditScope,
            uiLanguage: auditUiLanguageName(currentLocale()),
            report: async () => frozenAuditReport!,
            verifiedProjects: verifiedAuditProjects,
            recordKeep: entry => { pendingKeeps.set(auditKeepKey(entry), entry) }
          }
        } : {}),
        ...(topicHealth ? { health: topicHealth } : {}),
        signal, check,
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
      if (!repair && (await getMemorySettings()).fileMemory?.enabled === false) throw new Error('DREAM_DISABLED')
      await history.validateReadSources(); check()
      this.value.phase = 'publishing'
      const writableScopes = repair
        ? new Set(['global', ...repair.projects.map(project => `projects/${project.id}`)])
        : this.value.audit && this.value.auditScope && verifiedAuditProjects
          ? this.value.auditScope.kind === 'global'
            ? new Set(['global'])
            : this.value.auditScope.kind === 'project'
              ? new Set([`projects/${this.value.auditScope.projectId}`])
              : new Set(['global', ...[...verifiedAuditProjects.keys()].map(id => `projects/${id}`)])
          : history.writableScopes()
      this.value.changes = stage.publish(writableScopes, check)
      published = true
      if (this.value.audit && pendingKeeps.size > 0) {
        const liveRoot = memoryRoot()
        const catalog = new MemoryFiles(liveRoot)
        await commitAuditKeeps(
          [...pendingKeeps.values()],
          entry => {
            check()
            const prefix = entry.scope === 'global' ? 'global' : `projects/${entry.projectId}`
            const liveStore = new MemoryFiles(join(liveRoot, prefix), liveRoot)
            return liveStore.optional(entry.path)?.revision === entry.rev
              && (entry.kind !== 'clickbait' || matchesClickbaitSource(liveStore, entry.from, entry.fromRev))
              && (entry.kind !== 'structure' || matchesStructuralKeep(liveRoot, entry))
          },
          {
            signal,
            check,
            withLiveLock: action => catalog.withCatalogLease(action),
            beforeWrite: async () => {
              check()
              if ((await getMemorySettings()).fileMemory?.enabled === false) {
                const disabled = new Error('DREAM_DISABLED')
                if (!signal.aborted) controller.abort(disabled)
                throw disabled
              }
              check()
            }
          }
        )
      }
      this.value.state = 'done'
    } catch (error) {
      const reason = signal.aborted ? signal.reason : error
      const code = reason instanceof Error ? /^DREAM_[A-Z_]+/.exec(reason.message)?.[0] : undefined
      this.value.state = this.value.budgetStop ? 'limited' : signal.aborted && code === 'DREAM_CANCELLED' ? 'cancelled' : 'error'
      this.value.error = code ?? 'DREAM_FAILED'
      if (!published) this.value.report = undefined
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
registerDreamShutdown(disabling => disabling && dreamService.status().repair ? Promise.resolve() : dreamService.stop())
