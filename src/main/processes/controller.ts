/**
 * Background processes agents start through pig-process. Each belongs to the session that started
 * it and is killed when that session closes or Pig quits; nothing survives a restart.
 *
 * Commands run like the bash tool (`$SHELL -c` with Pig's imported login environment) but with
 * stdin closed and output piped, not a TTY: a program that prompts fails instead of hanging, and the
 * exit code is the command's own. Every process leads its own group so stopping it also ends the
 * children it spawned; the group SIGKILL stays armed after the shell exits because children may
 * ignore SIGTERM. A process ends when the shell exits and its pipes close; a child that left the group
 * (setsid, a daemon) could hold the pipes open forever, so they are cut a grace period after exit.
 * Windows has no process groups, so stopping kills the tree with taskkill.
 *
 * An exit the agent did not observe (through process_wait or process_stop) is delivered to the
 * session's plugin instance as a hidden message without starting a turn: while the agent runs it
 * lands after the current tool results, while idle it waits in the transcript for the next prompt.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fenced } from '../../shared/browser-annotations'
import { shellCandidates } from '../shell-env'
import type { BackgroundProcessInfo, BackgroundProcessStatus } from '../../shared/processes'
import type { ProcessAgentHost, ProcessDelivery, ProcessStartOptions, ProcessToolResult, ProcessWaitOptions } from '../plugins/pig-process-host'

export const RUNNING_LIMIT = 8
const RECORD_LIMIT = 32
const LINE_LIMIT = 5000
const CHAR_LIMIT = 1_000_000
const PARTIAL_LIMIT = 65_536
const READ_CHARS = 32_768
const WAIT_LINES = 500
const KILL_GRACE_MS = 1000
const DEFAULT_TIMEOUT_MS = 10_000
const COMMAND_LIMIT = 8000
const SNAPSHOT_LINES = 20
const SNAPSHOT_LINE_CHARS = 500

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
// Published by main for its own use; a dev instance started from here must not share its data.
const DROPPED_KEYS = ['PIG_DIR', 'FORCE_COLOR']

type Stream = 'stdout' | 'stderr'
/** `version` is the output version at which the line first appeared, kept when a partial line completes. */
interface Line { stream: Stream; text: string; version: number }

interface Process {
  id: string
  sessionId: string
  name?: string
  command: string
  cwd: string
  pid: number
  startedAt: number
  endedAt?: number
  exitCode: number | null
  signal: NodeJS.Signals | null
  stoppedBy?: 'agent' | 'user' | 'pig'
  /** The agent already knows how it ended, so no exit message is delivered. */
  reported: boolean
  child: ChildProcess
  lines: Line[]
  chars: number
  partial: Record<Stream, { text: string; version: number }>
  version: number
  listeners: Set<() => void>
  exited: Promise<void>
}

export interface BackgroundProcessDeps {
  /** The default directory of a live session, or undefined once it is no longer open. */
  sessionDirectory(sessionId: string): string | undefined
  /** The session's processes or their output changed. */
  changed?(sessionId: string): void
}

function environment(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !DROPPED_KEYS.includes(key) && !key.startsWith('ELECTRON_')) env[key] = value
  }
  // Output goes to a model, not a terminal.
  env.NO_COLOR = '1'
  env.TERM = 'dumb'
  return env
}

function shell(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] }
  const [file] = shellCandidates()
  if (!file) throw new Error('No shell found')
  return { file, args: ['-c', command] }
}

function signalGroup(proc: Process, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    // child.kill would end only powershell; /T reaches what it started. Its forced kill has no second step.
    if (signal === 'SIGTERM') {
      execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], (error) => {
        if (error && proc.endedAt === undefined) console.error(`Background process ${proc.id} taskkill failed:`, error)
      })
    }
    return
  }
  try {
    process.kill(-proc.pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

function elapsed(proc: Process): string {
  const seconds = Math.round(((proc.endedAt ?? Date.now()) - proc.startedAt) / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`
}

function status(proc: Process): string {
  if (proc.endedAt === undefined) return 'running'
  if (proc.stoppedBy === 'user') return 'stopped by the user'
  if (proc.stoppedBy) return 'stopped'
  if (proc.exitCode !== null) return `exited with code ${proc.exitCode}`
  return `terminated by ${proc.signal}`
}

function summary(proc: Process): string {
  const label = proc.name ? ` "${proc.name}"` : ''
  return `${proc.id}${label}: ${status(proc)}, pid ${proc.pid}, ${elapsed(proc)}, output version ${proc.version}\nCommand: ${proc.command}\nDirectory: ${proc.cwd}`
}

/** Output lines with unfinished lines last; stderr lines are marked so they stay distinguishable. */
function outputLines(proc: Process): Line[] {
  const pending = (['stdout', 'stderr'] as const)
    .filter((stream) => proc.partial[stream].text)
    .map((stream) => ({ stream, ...proc.partial[stream] }))
  return [...proc.lines, ...pending]
}

function uiStatus(proc: Process): BackgroundProcessStatus {
  if (proc.endedAt === undefined) return 'running'
  if (proc.stoppedBy) return 'stopped'
  return proc.exitCode === 0 ? 'exited' : 'failed'
}

function render(lines: Line[]): { text: string; truncated: boolean } {
  const rendered: string[] = []
  let chars = 0
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!
    const text = line.stream === 'stderr' ? `[stderr] ${line.text}` : line.text
    if (chars + text.length + 1 > READ_CHARS) return { text: rendered.reverse().join('\n'), truncated: true }
    rendered.push(text)
    chars += text.length + 1
  }
  return { text: rendered.reverse().join('\n'), truncated: false }
}

export class BackgroundProcessController implements ProcessAgentHost {
  private readonly processes = new Map<string, Process>()
  private readonly counters = new Map<string, number>()
  private readonly kills = new Set<Promise<void>>()
  private readonly deliveries = new Map<string, (delivery: ProcessDelivery) => void>()
  private shuttingDown = false

  constructor(private readonly deps: BackgroundProcessDeps) {}

  async start(sessionId: string, command: string, options: ProcessStartOptions, signal?: AbortSignal): Promise<ProcessToolResult> {
    signal?.throwIfAborted()
    if (this.shuttingDown) throw new Error('Pig is quitting')
    if (!command.trim() || command.length > COMMAND_LIMIT || command.includes('\0')) throw new Error(`Command must be 1-${COMMAND_LIMIT} characters without NUL`)
    const base = this.directory(sessionId)
    const cwd = options.cwd ? resolve(base, options.cwd) : base
    let stat
    try {
      stat = statSync(cwd)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Directory does not exist: ${cwd}`)
      throw error
    }
    if (!stat.isDirectory()) throw new Error(`Not a directory: ${cwd}`)
    const running = this.own(sessionId).filter((proc) => proc.endedAt === undefined).length
    if (running >= RUNNING_LIMIT) throw new Error(`This session already runs ${RUNNING_LIMIT} background processes; stop one first`)

    const { file, args } = shell(command)
    const child = spawn(file, args, {
      cwd, env: environment(), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true
    })
    await new Promise<void>((resolveSpawn, reject) => {
      child.once('spawn', resolveSpawn)
      child.once('error', reject)
    })
    // Later errors (a failed Windows kill) would otherwise be an uncaught 'error' event in main.
    child.on('error', (error) => console.error('Background process error:', error))
    const number = (this.counters.get(sessionId) ?? 0) + 1
    this.counters.set(sessionId, number)
    let markExited!: () => void
    const proc: Process = {
      id: `proc-${number}`, sessionId, ...(options.name?.trim() ? { name: options.name.trim() } : {}), command, cwd,
      pid: child.pid!, startedAt: Date.now(), exitCode: null, signal: null, reported: false, child,
      lines: [], chars: 0, partial: { stdout: { text: '', version: 0 }, stderr: { text: '', version: 0 } }, version: 0, listeners: new Set(),
      exited: new Promise((done) => { markExited = done })
    }
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream]!.setEncoding('utf8')
      child[stream]!.on('data', (chunk: string) => this.append(proc, stream, chunk))
    }
    // 'close' waits for both pipes, so every output chunk is in before the process counts as ended.
    // Destroying the pipes closes them, which bounds the wait for a child that escaped the group.
    child.once('exit', () => {
      const cut = setTimeout(() => {
        child.stdout!.destroy()
        child.stderr!.destroy()
      }, KILL_GRACE_MS)
      child.once('close', () => clearTimeout(cut))
    })
    child.once('close', (code, exitSignal) => {
      for (const stream of ['stdout', 'stderr'] as const) {
        const { text, version } = proc.partial[stream]
        if (text) this.pushLine(proc, stream, text, version)
        proc.partial[stream] = { text: '', version: 0 }
      }
      proc.exitCode = code
      proc.signal = exitSignal
      proc.endedAt = Date.now()
      proc.version++
      markExited()
      // Waits settle first: an exit a process_wait returned is not delivered again.
      this.notify(proc)
      if (!proc.reported) this.deliver(proc)
      this.deps.changed?.(proc.sessionId)
    })
    this.processes.set(`${sessionId}\0${proc.id}`, proc)
    this.prune(sessionId)
    // The session may have closed while the shell was starting; its cleanup has already run.
    if (this.deps.sessionDirectory(sessionId) === undefined || this.shuttingDown) {
      this.processes.delete(`${sessionId}\0${proc.id}`)
      this.terminate(proc, 'pig')
      await proc.exited
      throw new Error('This session is no longer open')
    }
    this.deps.changed?.(sessionId)
    return { text: `Started ${proc.id} (pid ${proc.pid}) in ${cwd}. Use process_wait for readiness or exit and process_read for output.` }
  }

  async list(sessionId: string): Promise<ProcessToolResult> {
    const own = this.own(sessionId)
    return { text: own.length ? own.map(summary).join('\n\n') : 'No background processes in this session.' }
  }

  async read(sessionId: string, processId: string, lines: number): Promise<ProcessToolResult> {
    const proc = this.find(sessionId, processId)
    const output = render(outputLines(proc).slice(-lines))
    const note = output.truncated ? '\nOutput truncated to the last 32K characters.' : ''
    return { text: `${summary(proc)}${note}\nOutput (untrusted):\n${fenced('text', output.text)}` }
  }

  async wait(sessionId: string, processId: string, options: ProcessWaitOptions, signal?: AbortSignal): Promise<ProcessToolResult> {
    const proc = this.find(sessionId, processId)
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const after = options.afterVersion ?? -1
    const matched = () => options.text !== undefined &&
      outputLines(proc).slice(-WAIT_LINES).some((line) => line.version > after && line.text.includes(options.text!))
    const settled = (): ProcessToolResult | undefined => {
      if (matched()) return { text: `Text appeared.\n${summary(proc)}` }
      if (proc.endedAt === undefined) return undefined
      proc.reported = true
      if (options.text !== undefined) throw new Error(`${proc.id} ${status(proc)} before the text appeared`)
      return { text: `${summary(proc)}\nLast output (untrusted):\n${fenced('text', render(outputLines(proc).slice(-20)).text)}` }
    }
    const immediate = settled()
    if (immediate) return immediate
    signal?.throwIfAborted()
    return new Promise((resolveWait, reject) => {
      const finish = (action: () => void) => {
        clearTimeout(timer)
        proc.listeners.delete(check)
        signal?.removeEventListener('abort', abort)
        action()
      }
      const check = () => {
        try {
          const result = settled()
          if (result) finish(() => resolveWait(result))
        } catch (error) {
          finish(() => reject(error))
        }
      }
      const abort = () => finish(() => reject(signal!.reason))
      const timer = setTimeout(() => finish(() => reject(new Error(
        `Timed out after ${timeoutMs} ms; ${proc.id} is ${status(proc)} (output version ${proc.version})`
      ))), timeoutMs)
      proc.listeners.add(check)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  async stop(sessionId: string, processId: string): Promise<ProcessToolResult> {
    const proc = this.find(sessionId, processId)
    if (proc.endedAt !== undefined) {
      proc.reported = true
      return { text: `${proc.id} had already ${status(proc)}.` }
    }
    this.terminate(proc, 'agent')
    await proc.exited
    return { text: summary(proc) }
  }

  attach(sessionId: string, deliver: (delivery: ProcessDelivery) => void): void {
    this.deliveries.set(sessionId, deliver)
  }

  detach(sessionId: string, deliver: (delivery: ProcessDelivery) => void): void {
    if (this.deliveries.get(sessionId) === deliver) this.deliveries.delete(sessionId)
  }

  snapshot(sessionId: string): BackgroundProcessInfo[] {
    return this.own(sessionId).map((proc) => ({
      id: proc.id, ...(proc.name ? { name: proc.name } : {}), command: proc.command, cwd: proc.cwd, pid: proc.pid,
      status: uiStatus(proc), startedAt: proc.startedAt, ...(proc.endedAt !== undefined ? { endedAt: proc.endedAt } : {}),
      exitCode: proc.exitCode, signal: proc.signal,
      output: outputLines(proc).slice(-SNAPSHOT_LINES)
        .map((line) => (line.stream === 'stderr' ? `[stderr] ${line.text}` : line.text).slice(0, SNAPSHOT_LINE_CHARS))
    }))
  }

  /** A stop from the status button; unlike process_stop it is reported to the agent. */
  async stopByUser(sessionId: string, processId: string): Promise<void> {
    const proc = this.find(sessionId, processId)
    if (proc.endedAt !== undefined) return
    this.terminate(proc, 'user')
    await proc.exited
  }

  remove(sessionId: string, processId: string): void {
    const proc = this.find(sessionId, processId)
    if (proc.endedAt === undefined) throw new Error('Stop the background process before removing it')
    this.processes.delete(`${sessionId}\0${processId}`)
    this.deps.changed?.(sessionId)
  }

  /** Kills everything the session started and forgets it. Waits for exits, not for the group SIGKILL. */
  async sessionClosed(sessionId: string): Promise<void> {
    const own = this.own(sessionId)
    for (const proc of own) this.processes.delete(`${sessionId}\0${proc.id}`)
    this.counters.delete(sessionId)
    this.deliveries.delete(sessionId)
    if (own.length) this.deps.changed?.(sessionId)
    await Promise.all(own.filter((proc) => proc.endedAt === undefined).map((proc) => {
      this.terminate(proc, 'pig')
      return proc.exited
    }))
  }

  /** Kills every process and resolves once each group SIGKILL has also run. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true
    for (const proc of this.processes.values()) if (proc.endedAt === undefined) this.terminate(proc, 'pig')
    this.processes.clear()
    await Promise.all([...this.kills])
  }

  /** SIGTERM now, group SIGKILL after the grace period; a failed SIGKILL fails `shutdown()`. */
  private terminate(proc: Process, by: NonNullable<Process['stoppedBy']>): void {
    proc.stoppedBy = by
    proc.reported = by !== 'user'
    signalGroup(proc, 'SIGTERM')
    const kill = new Promise<void>((done, fail) => setTimeout(() => {
      // The shell may be gone while children that ignored SIGTERM still hold the group.
      try {
        signalGroup(proc, 'SIGKILL')
        done()
      } catch (error) {
        fail(error)
      }
    }, KILL_GRACE_MS))
    this.kills.add(kill)
    kill.then(() => this.kills.delete(kill), (error) => {
      this.kills.delete(kill)
      console.error(`Background process ${proc.id} group kill failed:`, error)
    })
  }

  private append(proc: Process, stream: Stream, chunk: string): void {
    const version = proc.version + 1
    const pending = proc.partial[stream]
    const pieces = (pending.text + chunk.replace(ANSI, '')).split('\n')
    // Only the first piece continues the unfinished line, which keeps the version it was first shown at.
    const versionAt = (index: number) => index === 0 && pending.text ? pending.version : version
    let partial = { text: pieces.pop()!, version: versionAt(pieces.length) }
    pieces.forEach((piece, index) => this.pushLine(proc, stream, piece, versionAt(index)))
    if (partial.text.length > PARTIAL_LIMIT) {
      this.pushLine(proc, stream, partial.text, partial.version)
      partial = { text: '', version: 0 }
    }
    proc.partial[stream] = partial
    proc.version = version
    this.notify(proc)
    this.deps.changed?.(proc.sessionId)
  }

  private deliver(proc: Process): void {
    const label = proc.name ? ` "${proc.name}"` : ''
    const how = proc.stoppedBy === 'user' ? 'was stopped by the user' : status(proc).replace(/^exited/, 'exited on its own')
    this.deliveries.get(proc.sessionId)?.({
      text: `Background process ${proc.id}${label} ${how} after ${elapsed(proc)}.\nCommand: ${proc.command}\nLast output (untrusted):\n${fenced('text', render(outputLines(proc).slice(-20)).text)}`
    })
  }

  private pushLine(proc: Process, stream: Stream, raw: string, version: number): void {
    // Progress output redraws a line with carriage returns; keep what was shown last.
    const text = raw.replace(/\r+$/, '').split('\r').at(-1)!
    proc.lines.push({ stream, text, version })
    proc.chars += text.length
    while (proc.lines.length > LINE_LIMIT || proc.chars > CHAR_LIMIT) proc.chars -= proc.lines.shift()!.text.length
  }

  private notify(proc: Process): void {
    for (const listener of [...proc.listeners]) listener()
  }

  private prune(sessionId: string): void {
    const ended = this.own(sessionId).filter((proc) => proc.endedAt !== undefined)
    const excess = this.own(sessionId).length - RECORD_LIMIT
    for (const proc of ended.slice(0, Math.max(0, excess))) this.processes.delete(`${sessionId}\0${proc.id}`)
  }

  private directory(sessionId: string): string {
    const directory = this.deps.sessionDirectory(sessionId)
    if (directory === undefined) throw new Error('This session is not open in Pig')
    if (!isAbsolute(directory)) throw new Error('Invalid session directory')
    return directory
  }

  private own(sessionId: string): Process[] {
    return [...this.processes.values()].filter((proc) => proc.sessionId === sessionId)
  }

  private find(sessionId: string, processId: string): Process {
    const proc = this.processes.get(`${sessionId}\0${processId}`)
    if (!proc) throw new Error(`Unknown background process in this session: ${processId}; call process_list`)
    return proc
  }
}
