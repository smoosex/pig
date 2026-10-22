/**
 * The record a terminal leaves for the next launch: the parsed screen and scrollback re-encoded as ANSI,
 * and the directory its shell was last seen in. Only the PTY host writes it; main names and prunes the files.
 * Output can hold secrets, so files are private to the user.
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, readlink, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

export interface TerminalHistory {
  version: 1
  cwd: string
  history: string
}

export const TERMINAL_HISTORY_LIMIT = 1024 * 1024
const CWD_LOOKUP_TIMEOUT_MS = 2_000

/** `terminal:<uuid>` without the colon Windows cannot put in a file name. */
export function terminalHistoryFile(id: string): string {
  return `${id.slice('terminal:'.length)}.json`
}

/** Null when the terminal never left a record; a record that exists but cannot be read is an error. */
// Synchronous so the PTY host handles every request for a terminal after its spawn, in order.
export function readTerminalHistory(path: string): TerminalHistory | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const value = JSON.parse(text) as Partial<TerminalHistory>
  if (value.version !== 1 || typeof value.cwd !== 'string' || typeof value.history !== 'string') {
    throw new Error('Invalid terminal history record')
  }
  return { version: 1, cwd: value.cwd, history: value.history }
}

export async function writeTerminalHistory(path: string, record: TerminalHistory): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(record), { mode: 0o600 })
  await rename(temporary, path)
}

export async function removeTerminalHistory(path: string): Promise<void> {
  await rm(path, { force: true })
}

/**
 * The shell's current directory, read from outside because shells do not report it without
 * integration scripts. Null where the platform offers no way, or once the process is gone.
 */
export async function shellDirectory(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      return await readlink(`/proc/${pid}/cwd`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  if (process.platform !== 'darwin') return null
  let stdout: string
  try {
    ;({ stdout } = await promisify(execFile)('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'], { timeout: CWD_LOOKUP_TIMEOUT_MS }))
  } catch (error) {
    // lsof exits 1 with no output when the process has already gone.
    if ((error as { code?: unknown }).code === 1 && !(error as { stdout?: string }).stdout) return null
    throw error
  }
  const line = stdout.split('\n').find((entry) => entry.startsWith('n'))
  return line ? line.slice(1) : null
}
