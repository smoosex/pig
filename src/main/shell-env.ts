/**
 * Import the user's shell environment into the Pig process.
 *
 * A GUI-launched app inherits launchd's minimal environment, so PATH entries and API keys exported
 * from the user's shell rc files never reach the agent's non-interactive `/bin/bash -c` tool shell.
 * One probe at startup restores them: PATH is merged, missing variables are added, and everything
 * the launch already provided wins, so the app's own environment is never silently overridden.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const PROBE_MARKER = '__PIG_SHELL_ENV__'
// Interactive is what sources the rc files holding the user's PATH and API keys; the marker
// separates their output from rc banners printed before it.
const PROBE_COMMAND = `printf '%s\\0' '${PROBE_MARKER}'; env -0`
const PROBE_TIMEOUT_MS = 4_000
const MAX_PROBE_BYTES = 1024 * 1024
// A GUI launch has no SHELL, so the platform defaults stand in; zsh first because that is what
// macOS has shipped as the login shell since 10.15.
const FALLBACK_SHELLS = ['/bin/zsh', '/bin/bash', '/bin/sh']
// Last resort for a probe that never answered: the directories tools are normally installed into.
const FALLBACK_BIN_DIRS = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin']

// Shell-internal state that would otherwise leak into every child process of the app.
const IGNORED_KEYS = new Set([
  '_',
  'PWD',
  'OLDPWD',
  'SHLVL',
  'FPATH',
  'ZDOTDIR',
  'PS1',
  'PS2',
  'PS3',
  'PS4',
  'COLUMNS',
  'LINES'
])

// Set by the probe itself, so they say nothing about the user's environment and must not be
// imported: TERM would tell every later child it has a colour terminal, and the two guards and
// SHELL belong to the probe invocation, not to the app.
const PROBE_ENV_KEYS = ['SHELL', 'TERM', 'APPLE_SUPPRESS_DEVELOPER_TOOL_POPUP', 'GIT_TERMINAL_PROMPT']

export interface ShellEnvironmentResult {
  imported: number
  pathEntries: number
}

export type ShellProbe = (shell: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>

/**
 * The probe runs the user's rc files, so it gets a minimal environment of its own: the app's
 * variables (dev server URLs, Electron switches) must not leak into their shell, and the two
 * guards keep a login rc from opening a dialog or waiting on a credential prompt.
 */
function probeEnv(shell: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    SHELL: shell,
    TERM: 'xterm-256color',
    // A login rc can hit the /usr/bin/git shim, which would otherwise pop the Xcode CLT installer.
    APPLE_SUPPRESS_DEVELOPER_TOOL_POPUP: '1',
    GIT_TERMINAL_PROMPT: '0'
  }
  for (const key of ['HOME', 'USER', 'TMPDIR'] as const) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

function runProbe(shell: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      shell,
      args,
      // SIGKILL, because a timed-out rc that left a child holding the pipe survives the default
      // SIGTERM and keeps the callback waiting for as long as that child lives.
      { timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: MAX_PROBE_BYTES, encoding: 'utf8', env },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      }
    )
  })
}

/** True when the probe was killed for outliving its timeout rather than failing on its own. */
function isTimeout(error: unknown): boolean {
  const failure = error as { killed?: boolean; signal?: string | null } | null
  return Boolean(failure?.killed || failure?.signal)
}

/** Prepend the usual tool directories to PATH and report how many were actually missing. */
export function applyFallbackPath(target: NodeJS.ProcessEnv): number {
  const home = target.HOME
  const dirs = [
    ...FALLBACK_BIN_DIRS,
    ...(home ? [join(home, '.local', 'bin'), join(home, '.bun', 'bin'), join(home, '.cargo', 'bin')] : [])
  ]
  const current = (target.PATH ?? '').split(':').filter(Boolean)
  const missing = dirs.filter((dir) => !current.includes(dir))
  if (missing.length > 0) target.PATH = [...missing, ...current].join(':')
  return missing.length
}

/** Read the NUL-separated `env -0` output printed after the marker, ignoring earlier rc output. */
export function parseShellEnvironment(output: string): Record<string, string> {
  const start = output.indexOf(PROBE_MARKER)
  if (start < 0) return {}
  const entries: Record<string, string> = {}
  for (const chunk of output.slice(start + PROBE_MARKER.length).split('\0')) {
    const separator = chunk.indexOf('=')
    if (separator <= 0) continue
    const key = chunk.slice(0, separator)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || IGNORED_KEYS.has(key)) continue
    entries[key] = chunk.slice(separator + 1)
  }
  return entries
}

/** Merge a probe result: PATH keeps the shell's order first, other keys only fill in what is missing. */
export function mergeShellEnvironment(
  target: NodeJS.ProcessEnv,
  entries: Record<string, string>
): ShellEnvironmentResult {
  const merged: string[] = []
  const push = (value: string): void => {
    for (const entry of value.split(':').filter(Boolean)) {
      if (!merged.includes(entry)) merged.push(entry)
    }
  }
  push(entries.PATH ?? '')
  const pathEntries = merged.length
  push(target.PATH ?? '')
  if (merged.length > 0) target.PATH = merged.join(':')

  let imported = 0
  for (const [key, value] of Object.entries(entries)) {
    if (key === 'PATH' || key in target) continue
    target[key] = value
    imported++
  }
  return { imported, pathEntries }
}

export async function importShellEnvironment(
  options: { shell?: string; probe?: ShellProbe } = {}
): Promise<ShellEnvironmentResult> {
  const unchanged = { imported: 0, pathEntries: 0 }
  if (process.platform === 'win32') return unchanged
  const probe = options.probe ?? runProbe
  const failures: string[] = []
  for (const shell of shellCandidates(options.shell)) {
    let entries: Record<string, string>
    try {
      entries = parseShellEnvironment(await probe(shell, ['-ilc', PROBE_COMMAND], probeEnv(shell)))
    } catch (error) {
      failures.push(`${shell}: ${error instanceof Error ? error.message : String(error)}`)
      // A timeout means the user's rc ran and hung: another shell can only repeat the wait, and
      // would answer successfully with its own unrelated defaults and hide the failure.
      if (isTimeout(error)) break
      continue
    }
    // A shell that answered without a PATH cannot say where the user's tools live, which is the
    // point of the probe: treat it as a failure instead of a silent partial import.
    if (!entries.PATH) {
      failures.push(`${shell}: no PATH in the environment`)
      continue
    }
    for (const key of PROBE_ENV_KEYS) delete entries[key]
    const result = mergeShellEnvironment(process.env, entries)
    console.log(
      `Shell environment imported from ${shell}: ${result.imported} variables, ${result.pathEntries} PATH entries`
    )
    return result
  }
  const pathEntries = applyFallbackPath(process.env)
  console.warn(
    `Shell environment probe failed (${failures.join('; ')}); added ${pathEntries} fallback PATH entries`
  )
  return { imported: 0, pathEntries }
}

/** The requested shell, else the login shell candidates that exist on this machine. */
export function shellCandidates(preferred?: string): string[] {
  if (preferred) return [preferred]
  const candidates = [process.env.SHELL, ...FALLBACK_SHELLS]
  const shells: string[] = []
  for (const candidate of candidates) {
    if (!candidate || shells.includes(candidate) || !existsSync(candidate)) continue
    shells.push(candidate)
  }
  return shells
}
