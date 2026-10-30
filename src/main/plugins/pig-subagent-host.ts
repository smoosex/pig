/**
 * Bridge between the jiti-loaded pig-subagent extension and Pig's SubagentManager in main.
 *
 * The extension only owns the spawn tool and result delivery through `pi.sendMessage`; building child
 * sessions needs Pig's resource loaders, so it lives in the host. Both module instances meet on
 * globalThis, like pig-ui.
 */
import type { ThinkingLevel } from '../../shared/api'

export interface SpawnRequest {
  parentSessionId: string
  parentTurnId?: string
  parentSessionFile?: string
  toolCallId: string
  cwd: string
  title: string
  prompt: string
  background: boolean
  parentModel?: { provider: string; id: string }
  parentThinkingLevel?: ThinkingLevel
  /** Foreground only: the parent run's signal, so stopping the parent stops the child. */
  signal?: AbortSignal
  /** Foreground only: short progress line for the tool card. */
  onProgress?: (activity: string) => void
}

export interface SpawnOutcome {
  id: string
  /** Foreground: the formatted report. Background: the acknowledgement. */
  text: string
  isError: boolean
}

export interface SubagentDelivery {
  text: string
  details: unknown
}

export interface RestartRequest {
  signal?: AbortSignal
  parentSessionId: string
  id: string
  cwd: string
  instruction?: string
  parentModel?: { provider: string; id: string }
  parentThinkingLevel?: ThinkingLevel
}

export interface SubagentHost {
  spawn(request: SpawnRequest): Promise<SpawnOutcome>
  restart(request: RestartRequest): Promise<SpawnOutcome>
  /** The extension instance of a live parent registers how results reach that session. */
  attach(parentSessionId: string, deliver: (delivery: SubagentDelivery) => void): void
  detach(parentSessionId: string, deliver: (delivery: SubagentDelivery) => void): void
}

const key = Symbol.for('pig:subagent-host')
type Slot = Record<symbol, SubagentHost | undefined>

export function registerSubagentHost(host: SubagentHost | undefined): void {
  (globalThis as Slot)[key] = host
}

export function subagentHost(): SubagentHost | undefined {
  return (globalThis as Slot)[key]
}
