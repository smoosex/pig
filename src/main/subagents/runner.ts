/** The execution seam: the manager drives children through this interface and tests replace it. */
import type { ThinkingLevel } from '../../shared/api'
import type { UsageCounts } from '../../shared/turn-usage'

export interface RunSpec {
  id: string
  parentSessionId: string
  title: string
  /** The child's own lifetime, independent of the parent turn for background work. */
  signal?: AbortSignal
  cwd: string
  prompt: string
  model?: { provider: string; id: string }
  thinkingLevel?: ThinkingLevel
  sessionDir: string
}

export type RunEvent =
  | { type: 'turn_start' }
  | { type: 'tool'; name: string; args: Record<string, unknown> }
  | { type: 'assistant'; text: string; thinking: boolean; usage?: UsageCounts; cost: number }

export interface RunResult {
  error?: string
}

export interface SubagentRun {
  sessionFile?: string
  /** Settles once the child is idle and disposed; never rejects. */
  done: Promise<RunResult>
  abort(): void
  messages(): unknown[]
}

export interface SubagentRunner {
  start(spec: RunSpec, onEvent: (event: RunEvent) => void): Promise<SubagentRun>
  readTranscript(sessionFile: string): Promise<unknown[]>
}

export interface ModelChoice {
  model?: { provider: string; id: string }
  thinkingLevel?: ThinkingLevel
  fallbackReason?: string
}

export interface ModelLookup {
  exists(provider: string, id: string): boolean
  available(provider: string, id: string): boolean
}

/**
 * Only failures known before starting fall back to the parent's model; runtime errors fail the child
 * instead, since switching models mid-transcript breaks provider-specific thinking blocks.
 */
export function chooseModel(
  configured: { model?: { provider: string; id: string }; thinkingLevel?: ThinkingLevel },
  parent: { model?: { provider: string; id: string }; thinkingLevel?: ThinkingLevel },
  lookup: ModelLookup
): ModelChoice {
  const target = configured.model
  if (!target) return { model: parent.model, thinkingLevel: parent.thinkingLevel }
  if (lookup.available(target.provider, target.id)) {
    return { model: target, thinkingLevel: configured.thinkingLevel ?? parent.thinkingLevel }
  }
  const name = `${target.provider}/${target.id}`
  return {
    model: parent.model,
    thinkingLevel: parent.thinkingLevel,
    fallbackReason: lookup.exists(target.provider, target.id) ? `${name} has no credentials` : `${name} is not available`
  }
}
