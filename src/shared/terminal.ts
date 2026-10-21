/** Host-owned terminal panes: one PTY per `terminal:<uuid>` tab, owned by the creating UI window. */
export interface TerminalInfo {
  pid: number
  shell: string
  cwd: string
}

/**
 * Output is counted in UTF-16 code units on both ends, so an acknowledgement returns exactly what the
 * pane received. The PTY host pauses a shell whose unacknowledged output grows past its budget.
 */
export type TerminalEvent =
  | { terminalId: string; kind: 'output'; data: string }
  | { terminalId: string; kind: 'exit'; exitCode: number; signal: number | null }
  /** The PTY host itself died; the shell is gone with it. */
  | { terminalId: string; kind: 'failed'; message: string }

export interface TerminalApi {
  /** Starts the shell; `cwd` null means the home directory (terminals opened outside a project). */
  create: (terminalId: string, cwd: string | null, cols: number, rows: number) => Promise<TerminalInfo>
  /** Binary input encodes one byte (0–255) per UTF-16 code unit, without UTF-8 conversion. */
  write: (terminalId: string, data: string, binary?: boolean) => Promise<void>
  resize: (terminalId: string, cols: number, rows: number) => Promise<void>
  ack: (terminalId: string, length: number) => Promise<void>
  close: (terminalId: string) => Promise<void>
  onEvent: (listener: (event: TerminalEvent) => void) => () => void
}

export const TERMINAL_ID_PATTERN = /^terminal:[a-z\d-]{1,128}$/i
export const TERMINAL_MAX_WRITE = 65_536
export const TERMINAL_COLS = { min: 2, max: 1000 } as const
export const TERMINAL_ROWS = { min: 1, max: 500 } as const

/** Messages between main and the PTY utility process. Main validates everything before it crosses. */
export type PtyHostRequest =
  | { type: 'shutdown' }
  | { type: 'spawn'; id: string; file: string; args: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number }
  | { type: 'write'; id: string; data: string; binary?: boolean }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'ack'; id: string; length: number }
  | { type: 'kill'; id: string }

export type PtyHostMessage =
  | { type: 'shutdown-complete' }
  | { type: 'spawned'; id: string; pid: number }
  | { type: 'spawn-failed'; id: string; message: string }
  | { type: 'output'; id: string; data: string }
  | { type: 'exit'; id: string; exitCode: number; signal: number | null }
