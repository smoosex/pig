/** Host-owned terminal panes: one PTY per `terminal:<uuid>` tab, owned by the creating UI window. */
import type { TerminalAgentApi } from './terminal-agent'

export interface TerminalSnapshot {
  text: string
  cols: number
  rows: number
  cursorX: number
  cursorY: number
  alternateScreen: boolean
  bracketedPaste: boolean
  applicationCursor: boolean
  version: number
  truncated: boolean
}

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
  | { terminalId: string; kind: 'clear' }
  | { terminalId: string; kind: 'exit'; exitCode: number; signal: number | null }
  /** The PTY host itself died; the shell is gone with it. */
  | { terminalId: string; kind: 'failed'; message: string }

export interface TerminalApi extends TerminalAgentApi {
  /** Starts the shell; `cwd` null means the home directory (terminals opened outside a project). */
  create: (terminalId: string, cwd: string | null, cols: number, rows: number) => Promise<TerminalInfo>
  /** Binary input encodes one byte (0–255) per UTF-16 code unit, without UTF-8 conversion. */
  write: (terminalId: string, data: string, binary?: boolean) => Promise<void>
  clear: (terminalId: string) => Promise<void>
  resize: (terminalId: string, cols: number, rows: number) => Promise<void>
  ack: (terminalId: string, length: number) => Promise<void>
  close: (terminalId: string) => Promise<void>
  onEvent: (listener: (event: TerminalEvent) => void) => () => void
}

export const TERMINAL_ID_PATTERN = /^terminal:[a-z\d-]{1,128}$/i
export const TERMINAL_MAX_WRITE = 65_536
export const TERMINAL_COLS = { min: 2, max: 1000 } as const
export const TERMINAL_ROWS = { min: 1, max: 500 } as const

/**
 * Where a terminal's output survives restarts. `failed` is the notice shown for a record that could not
 * be read, with a `{message}` placeholder.
 */
export interface TerminalHistoryTarget {
  path: string
  failed: string
}

/** A closed tab's history is gone; a window or app that closes keeps it for the next launch. */
export type TerminalHistoryOnClose = 'keep' | 'discard'

/** Messages between main and the PTY utility process. Main validates everything before it crosses. */
export type PtyHostRequest =
  | { type: 'shutdown' }
  | {
    type: 'spawn'; id: string; file: string; args: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number
    history: TerminalHistoryTarget
  }
  | { type: 'write'; id: string; data: string; binary?: boolean }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'clear'; id: string }
  | { type: 'ack'; id: string; length: number }
  /** Also sent for a shell that already exited, so a discarded history is removed. */
  | { type: 'close'; id: string; history: TerminalHistoryOnClose }
  | { type: 'snapshot'; id: string; requestId: string; lines: number }

export type PtyHostMessage =
  | { type: 'shutdown-complete' }
  | { type: 'snapshot-result'; id: string; requestId: string; snapshot: TerminalSnapshot }
  | { type: 'snapshot-failed'; id: string; requestId: string; message: string }
  /** `cwd` is where the shell started: the directory saved with its history when that still exists. */
  | { type: 'spawned'; id: string; pid: number; cwd: string }
  | { type: 'spawn-failed'; id: string; message: string }
  | { type: 'output'; id: string; data: string }
  | { type: 'clear'; id: string }
  | { type: 'exit'; id: string; exitCode: number; signal: number | null }
