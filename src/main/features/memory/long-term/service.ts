/** Shared bounded workers, durable source jobs and atomic commits; independent of OM reflection. */
import { statSync } from 'node:fs'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { LongTermSettings } from '../../../../shared/long-term-memory'
import { getMemorySettings } from '../../memory-settings'
import { longTermMemoryPath } from '../paths'
import { memoryAccess } from './access'
import { extractLearning } from './learning'
import { integrateKnowledge } from './integration'
import { LongTermMemoryStore, type MemoryAccess, type PendingIntegration } from './store'
import { sourceWindow, windowStillValid, type LearningWindow } from './sources'
import { MemoryReviewError, REVIEW_TIMEOUT_MS } from './review-errors'

export function withMemoryStore<T>(work: (store: LongTermMemoryStore) => T): T {
  const store = new LongTermMemoryStore(longTermMemoryPath())
  try { return work(store) } finally { store.close() }
}
export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let cancel!: () => void
  const stopped = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason ?? new Error('Long-term memory work cancelled'))
    signal.addEventListener('abort', cancel, { once: true })
  })
  try { return await Promise.race([work, stopped]) } finally { signal.removeEventListener('abort', cancel) }
}
let workers = 0
export const learningConcurrency = (): number => workers
const waiting = new Set<() => void>()
async function slot(signal: AbortSignal): Promise<() => void> {
  while (workers >= 2) {
    let wake!: () => void
    try {
      await abortable(new Promise<void>(resolve => { wake = resolve; waiting.add(wake) }), signal)
    } finally { waiting.delete(wake) }
  }
  signal.throwIfAborted(); workers++
  return () => { workers--; const wake = waiting.values().next().value; if (wake) { waiting.delete(wake); wake() } }
}
export const LEARNING_IDLE_MS = 60_000
export interface LearningStepResult { delay?: number; jobId?: string }

/** Called only on an idle source branch. Each pass does one extraction OR one integration. */
export async function learningStep(ctx: ExtensionContext, settings: LongTermSettings, access: MemoryAccess,
  branchIds: ReadonlySet<string>, signal: AbortSignal): Promise<LearningStepResult> {
  const sessionFile = ctx.sessionManager.getSessionFile()
  if (!sessionFile) return {}
  try { if (!statSync(sessionFile).isFile()) throw new Error('Task source is not a session file') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
  const origin = { sessionId: access.session, sessionFile, cwd: ctx.cwd, project: access.project }
  const snapshot = withMemoryStore(store => {
    const pending = store.pending(access.session, branchIds)
    const ready = pending.find(item => (store.job(item.episode.id)?.retryAt ?? 0) <= Date.now())
    if (ready) {
      const window: LearningWindow = { id: ready.episode.id, origin, anchorId: ready.episode.anchorId,
        entryIds: ready.episode.sources.map(ref => ref.entryId), sources: ready.proposals.flatMap(item => item.sources) }
      // Jobs persist only references and digests, not source transcripts.
      store.register(window)
      const existing = [...new Map(ready.proposals.flatMap(proposal => store.related(proposal, access)).map(item => [item.id, item])).values()]
      return { integration: ready, existing, window, revision: store.revision() }
    }
    const window = sourceWindow(ctx.sessionManager, origin, id => store.processed(access.session, id), store.initializedAt(access.session))
    if (!window) return { delay: pending.length ? Math.max(1, Math.min(...pending.map(item => (store.job(item.episode.id)?.retryAt ?? 0) - Date.now()))) : undefined }
    store.register(window)
    const retryAt = store.job(window.id)!.retryAt
    return { window, sourceRevision: store.sourceRevision(), previous: store.recentEpisodes(access.session, branchIds).filter(item => item.integration === 'done' && item.sources.length + window.sources.length <= 96), revision: store.revision(),
      ...(retryAt > Date.now() ? { delay: retryAt - Date.now() } : {}) }
  })
  if (!snapshot.window || snapshot.delay !== undefined) return { delay: snapshot.delay }
  const window = snapshot.window
  const manager = ctx.sessionManager
  const validate = async () => {
    signal.throwIfAborted()
    const current = await getMemorySettings()
    const currentAccess = await memoryAccess(ctx)
    signal.throwIfAborted()
    if (!ctx.isIdle() || current.passive || !current.longTerm?.enabled || JSON.stringify(current.longTerm) !== JSON.stringify(settings)
      || JSON.stringify(currentAccess) !== JSON.stringify(access) || ctx.sessionManager !== manager
      || manager.getSessionId() !== origin.sessionId || manager.getSessionFile() !== origin.sessionFile || !windowStillValid(window, manager)) throw new MemoryReviewError('conflict')
  }
  const release = await slot(signal)
  const request = new AbortController()
  const cancel = () => request.abort(signal.reason)
  signal.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => request.abort(new MemoryReviewError('timeout')), REVIEW_TIMEOUT_MS)
  timer.unref?.()
  try {
    await validate()
    if (snapshot.integration) {
      const input: PendingIntegration = snapshot.integration
      const changes = await abortable(integrateKnowledge(ctx, settings, input, snapshot.existing ?? [], access, request.signal), request.signal)
      await validate()
      request.signal.throwIfAborted()
      withMemoryStore(store => store.integrate(input, changes, snapshot.revision!))
    } else {
      const learned = window.sources.length ? await abortable(extractLearning(ctx, settings, window, snapshot.previous ?? [], request.signal), request.signal) : { episodes: [], proposals: [] }
      await validate()
      request.signal.throwIfAborted()
      withMemoryStore(store => store.commitLearning(window, learned, snapshot.sourceRevision!))
    }
    return { delay: 0, jobId: window.id }
  } catch (error) {
    if (signal.aborted) throw error
    const code = error instanceof MemoryReviewError ? error.code : 'request'
    // A forget/delete revision change is retried from current state, never with the old payload.
    const delay = withMemoryStore(store => store.fail(window.id, code, snapshot.integration ? 'integration' : 'extraction'))
    throw Object.assign(new MemoryReviewError(code), { retryDelay: delay, jobId: window.id })
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', cancel); release()
  }
}
