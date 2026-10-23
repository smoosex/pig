/* Background processes an agent started through pig-process, as the session's status button shows them. */

/** `stopped` was asked for (by the agent or the user); `failed` ended on its own with a nonzero code or signal. */
export type BackgroundProcessStatus = 'running' | 'exited' | 'failed' | 'stopped'

export interface BackgroundProcessInfo {
  id: string
  name?: string
  command: string
  cwd: string
  pid: number
  status: BackgroundProcessStatus
  startedAt: number
  endedAt?: number
  exitCode: number | null
  signal: string | null
  /** The last output lines, stderr lines prefixed with `[stderr] `. */
  output: string[]
}

/** A whole per-session snapshot; it always replaces the previous one. */
export interface BackgroundProcessUpdate {
  sessionId: string
  processes: BackgroundProcessInfo[]
}

export interface ProcessApi {
  list(sessionId: string): Promise<BackgroundProcessInfo[]>
  /** The agent learns about a stop it did not ask for. */
  stop(sessionId: string, processId: string): Promise<void>
  /** Forgets an ended process. */
  remove(sessionId: string, processId: string): Promise<void>
  onChanged(listener: (update: BackgroundProcessUpdate) => void): () => void
}
