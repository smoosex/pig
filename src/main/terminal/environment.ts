/**
 * What a terminal pane runs and with which environment. The base is Pig's own process.env, which
 * already carries the login shell's PATH and keys (see shell-env.ts); what the launching terminal or
 * Pig itself put there for its own use is removed so it cannot leak into the user's shell.
 */
import { shellCandidates } from '../shell-env'

// Identity of whatever terminal launched Pig (a dev instance started from Ghostty carries
// TERM=xterm-ghostty, which the pane cannot honour) and colour opt-outs meant for Pig's own output.
const TERMINAL_IDENTITY = /^(TERM|TERMINFO|TERM_PROGRAM|TERM_SESSION_ID|COLORTERM|ITERM_|KITTY_|GHOSTTY_|WEZTERM_|ALACRITTY_|VSCODE_)/
const DROPPED_KEYS = new Set([
  'NO_COLOR',
  'FORCE_COLOR',
  // Published by main for its extensions. Inherited by a shell, it would make a Pig dev instance
  // launched from this pane share the installed app's data directory.
  'PIG_DIR',
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE'
])

export interface TerminalShell {
  file: string
  args: string[]
}

export function terminalShell(platform: NodeJS.Platform = process.platform): TerminalShell {
  if (platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo'] }
  const [file] = shellCandidates()
  if (!file) throw new Error('No login shell found')
  // A login shell reads the profile files GUI launches skip, the way Terminal.app starts one.
  return { file, args: ['-l'] }
}

export function terminalEnvironment(env: NodeJS.ProcessEnv, appVersion: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || TERMINAL_IDENTITY.test(key) || DROPPED_KEYS.has(key)) continue
    result[key] = value
  }
  result.TERM = 'xterm-256color'
  result.COLORTERM = 'truecolor'
  result.TERM_PROGRAM = 'Pig'
  result.TERM_PROGRAM_VERSION = appVersion
  // Finder launches carry no locale, and a shell without one prints CJK as escapes.
  if (!result.LANG && !result.LC_ALL && !result.LC_CTYPE) result.LANG = 'en_US.UTF-8'
  return result
}
