import { observationPoolMetrics } from './agents/dropper/pool.js'
import { loadConfig, resolveCompactAfterTokens } from './config.js'
import { memoryRuntime } from './runtime.js'
import {
  diffProjection, foldLedger, fullProjection, observationToSummaryLine,
  observedTokensSinceLastCompaction, observedTokensSinceReflectionCoverage,
  rawTokensSinceLastCompaction, rawTokensSinceObservationCoverage,
  reflectionToSummaryLine, visibleProjection, type Entry, type Projection
} from './session-ledger/index.js'
import { compactionProgress, progressLabel } from './hooks/compaction-trigger.js'

function pct(value: number, total: number): number {
  return total > 0 ? Math.round(value / total * 100) : 0
}

function totalTokens(items: { tokenCount: number }[]): number {
  return items.reduce((sum, item) => sum + item.tokenCount, 0)
}

export function memoryStatus(sessionId: string, entries: Entry[], contextWindow?: number, cwd?: string): string {
  const runtime = memoryRuntime(sessionId)
  const config = runtime?.configLoaded ? runtime.config : loadConfig(cwd)
  const folded = foldLedger(entries)
  const visible = visibleProjection(entries)
  const full = fullProjection(entries)
  const drift = diffProjection(visible, full)
  const pool = observationPoolMetrics(folded.activeObservations, config.observationsPoolTargetTokens)
  const observationSuffix = [
    drift.observationsOnlyInFull.length ? `+${drift.observationsOnlyInFull.length}` : '',
    drift.droppedOnlyInFull.length ? `-${drift.droppedOnlyInFull.length}` : ''
  ].filter(Boolean).join(' ')
  const reflectionSuffix = drift.reflectionsOnlyInFull.length ? ` +${drift.reflectionsOnlyInFull.length}` : ''
  const compactThreshold = resolveCompactAfterTokens(config, contextWindow)
  const observationProgress = rawTokensSinceObservationCoverage(entries)
  const reflectionProgress = observedTokensSinceReflectionCoverage(entries)
  const compactionProgressTokens = runtime ? compactionProgress(runtime, entries) : rawTokensSinceLastCompaction(entries)
  const unobservedSinceCompaction = Math.max(0, rawTokensSinceLastCompaction(entries) - observedTokensSinceLastCompaction(entries))
  const progressKind = runtime ? progressLabel(runtime) : 'estimated'
  const lines = [
    ...(config.passive ? ['── Mode ──', 'Passive: automatic memory workers and auto-compaction disabled; manual/Pi compaction and recall remain active', ''] : []),
    '── Memory ──',
    `Observations: ${folded.observations.length} recorded / ${folded.droppedObservationIds.size} dropped / ${folded.activeObservations.length} active / ${visible.observations.length} visible${observationSuffix ? ` ${observationSuffix}` : ''}`,
    `Reflections:  ${folded.reflections.length} recorded / ${visible.reflections.length} visible${reflectionSuffix}`,
    '',
    '── Activity ──',
    `Next observation: ~${observationProgress.toLocaleString()} / ${config.observeAfterTokens.toLocaleString()} tokens (${pct(observationProgress, config.observeAfterTokens)}%)`,
    `Next reflection:  ~${reflectionProgress.toLocaleString()} / ${config.reflectAfterTokens.toLocaleString()} observed tokens (${pct(reflectionProgress, config.reflectAfterTokens)}%)`,
    `Next compaction:  ~${compactionProgressTokens.toLocaleString()} / ${compactThreshold.toLocaleString()} ${progressKind} source tokens (${pct(compactionProgressTokens, compactThreshold)}%)`,
    `Observer backlog: ~${unobservedSinceCompaction.toLocaleString()} unobserved source tokens since the compaction boundary`,
    `Visible observation pool: ~${totalTokens(visible.observations).toLocaleString()} / ${config.observationsPoolMaxTokens.toLocaleString()} tokens (${pct(totalTokens(visible.observations), config.observationsPoolMaxTokens)}%)`,
    `Active observation pool: ~${pool.observationTokens.toLocaleString()} / ${config.observationsPoolTargetTokens.toLocaleString()} target tokens (${pct(pool.observationTokens, config.observationsPoolTargetTokens)}%)`,
    `Reflection pool:         ~${totalTokens(visible.reflections).toLocaleString()} tokens`
  ]
  if (runtime?.consolidationInFlight || runtime?.compactInFlight || runtime?.compactHookInFlight) {
    lines.push('', '── In flight ──')
    if (runtime.consolidationInFlight) lines.push(`Consolidation: running${runtime.consolidationPhase ? ` (${runtime.consolidationPhase})` : ''}`)
    if (runtime.compactInFlight) lines.push('Auto-compaction: running')
    if (runtime.compactHookInFlight) lines.push('Compaction hook: running')
  }
  if (runtime?.lastObserverError || runtime?.lastReflectorError || runtime?.lastDropperError) {
    lines.push('', '── Last error ──')
    if (runtime.lastObserverError) lines.push(`Observer: ${runtime.lastObserverError}`)
    if (runtime.lastReflectorError) lines.push(`Reflector: ${runtime.lastReflectorError}`)
    if (runtime.lastDropperError) lines.push(`Dropper: ${runtime.lastDropperError}`)
  }
  return lines.join('\n')
}

function renderItems<T>(items: T[], render: (item: T) => string, empty: string): string {
  return items.length ? items.map(render).join('\n') : empty
}

export function memoryView(entries: Entry[], full = false): string {
  const projection: Projection = full ? fullProjection(entries) : visibleProjection(entries)
  const label = full ? 'recorded' : 'visible'
  return [
    '── Reflections ──',
    renderItems(projection.reflections, reflectionToSummaryLine, `No ${label} reflections.`),
    '',
    '── Observations ──',
    renderItems(projection.observations, observationToSummaryLine, `No ${label} observations.`)
  ].join('\n')
}
