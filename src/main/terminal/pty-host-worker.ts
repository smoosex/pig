/**
 * PTY utility process. node-pty is native and ConPTY keeps worker threads of its own, so the shells
 * live here rather than in main beside the Pi sessions: a crash takes down terminals only.
 *
 * Output is coalesced per frame and metered: the pane acknowledges what it has parsed, and a shell
 * whose unacknowledged output passes the budget is paused at the PTY, so `cat` of a huge file cannot
 * flood IPC or the renderer. A pane that stops acknowledging is resumed after a timeout instead of
 * freezing its shell forever. A separate headless parser consumes the same output even for hidden
 * panes; it never forwards terminal-generated responses to the shell. Snapshots wait on its parser
 * queue independently of renderer acknowledgements.
 *
 * The same parser feeds the restart record: at most once every five seconds after new output, and once more when
 * a window or the app closes, the screen and scrollback are re-encoded and written beside the shell's
 * directory. A tab the user closes deletes its record. File operations for one terminal run in order,
 * so a late write can never recreate a record that was just deleted, and a reloaded window that starts
 * the same id again waits for them before reading the record.
 *
 * Main forgets a terminal the moment it closes it, so a closed shell sends nothing more: its late output
 * or exit would otherwise be taken for a new shell started under the same id.
 */
import { statSync } from 'node:fs'
import { spawn, type IPty } from 'node-pty'
import headless from '@xterm/headless'
import unicode11 from '@xterm/addon-unicode11'
import serialize from '@xterm/addon-serialize'
import type { Terminal as HeadlessTerminal } from '@xterm/headless'
import type { SerializeAddon } from '@xterm/addon-serialize'
import type { PtyHostMessage, PtyHostRequest } from '../../shared/terminal'
import {
  TERMINAL_HISTORY_LIMIT, readTerminalHistory, removeTerminalHistory, shellDirectory, writeTerminalHistory
} from './history-file'

const FLUSH_MS = 16
const FLUSH_LENGTH = 128 * 1024
const PAUSE_AT = 100_000
const RESUME_AT = 5_000
const ACK_TIMEOUT_MS = 10_000
const KILL_GRACE_MS = 1_000
// Closing saves a final record; the periodic save only bounds what a crash loses, so it stays infrequent.
const SAVE_INTERVAL_MS = 5_000
const SCROLLBACK = 5000

interface Session {
  pty: IPty
  screen: HeadlessTerminal
  serializer: SerializeAddon
  historyPath: string
  /** Where the shell started, replaced by where it was last seen when the tab's window or the app closes. */
  cwd: string
  saveTimer?: NodeJS.Timeout
  /** Closed by main: no further periodic saves, and nothing more is posted. */
  retiring: boolean
  /** Serialize parser callbacks, resizes and reads in PTY/port arrival order. */
  parsed: Promise<void>
  version: number
  buffer: string[]
  buffered: number
  flushTimer?: NodeJS.Timeout
  unacked: number
  paused: boolean
  watchdog?: NodeJS.Timeout
  killTimer?: NodeJS.Timeout
  /** The PTY fd is closed; the exit event follows once waitpid reports. */
  closed: boolean
  exited: boolean
}

const sessions = new Map<string, Session>()
// Closed panes and exited shells can still have a group-kill timer outstanding.
const pendingKills = new Set<Promise<void>>()
// Closes that save a final record before the shell is hung up; shutdown waits for them.
const retirements = new Set<Promise<void>>()
// Outlives an exited shell, whose record is deleted once its tab closes.
const historyPaths = new Map<string, string>()
const fileOps = new Map<string, Promise<void>>()
// Requests for an id whose spawn waits on that id's file operations, replayed in order once it starts.
const starting = new Map<string, Exclude<PtyHostRequest, { type: 'shutdown' }>[]>()
const pendingStarts = new Set<Promise<void>>()
let shuttingDown = false

function post(message: PtyHostMessage): void {
  process.parentPort.postMessage(message)
}

function flush(id: string, session: Session): void {
  clearTimeout(session.flushTimer)
  session.flushTimer = undefined
  if (!session.buffered) return
  const data = session.buffer.join('')
  session.buffer = []
  session.buffered = 0
  if (session.retiring) return
  post({ type: 'output', id, data })
  session.unacked += data.length
  if (!session.paused && session.unacked > PAUSE_AT) {
    session.paused = true
    session.pty.pause()
    armWatchdog(session)
  }
}

function armWatchdog(session: Session): void {
  clearTimeout(session.watchdog)
  session.watchdog = setTimeout(() => {
    session.unacked = 0
    resume(session)
  }, ACK_TIMEOUT_MS)
}

function resume(session: Session): void {
  clearTimeout(session.watchdog)
  if (!session.paused) return
  session.paused = false
  session.pty.resume()
}

function queueFile(id: string, operation: () => Promise<void>): Promise<void> {
  const next = (fileOps.get(id) ?? Promise.resolve()).then(operation).catch((error: unknown) => {
    // Losing a restart record must not take the shells in this host down with it.
    console.error(`Terminal history for ${id} failed:`, error)
  })
  fileOps.set(id, next)
  void next.then(() => { if (fileOps.get(id) === next) fileOps.delete(id) })
  return next
}

/** The newest scrollback that fits the record's size limit; the alternate screen (vim, less) is left out. */
function encodeHistory(session: Session): string {
  for (const scrollback of [SCROLLBACK, 2000, 500]) {
    const text = session.serializer.serialize({ scrollback, excludeAltBuffer: true, excludeModes: true })
    if (text.length <= TERMINAL_HISTORY_LIMIT) return text
  }
  // Cut at a line boundary so the record never starts inside an escape sequence.
  const text = session.serializer.serialize({ scrollback: 0, excludeAltBuffer: true, excludeModes: true }).slice(-TERMINAL_HISTORY_LIMIT)
  const boundary = text.indexOf('\n')
  return boundary === -1 ? '' : text.slice(boundary + 1)
}

/** A final save also looks up the shell's directory, inside the file queue so a restart waits for both. */
function save(id: string, session: Session, final = false): Promise<void> {
  // Encoded in parser order, so the record matches what the pane showed; written outside the parse chain.
  const history = new Promise<string>((resolve, reject) => {
    session.parsed = session.parsed.then(() => {
      try { resolve(encodeHistory(session)) } catch (error) { reject(error) }
    })
  })
  const { historyPath: path } = session
  return queueFile(id, async () => {
    if (final) {
      try {
        session.cwd = await shellDirectory(session.pty.pid) ?? session.cwd
      } catch (error) {
        // lsof failing or timing out costs only the directory; the output is still worth keeping.
        console.error(`Terminal directory lookup for ${id} failed:`, error)
      }
    }
    await writeTerminalHistory(path, { version: 1, cwd: session.cwd, history: await history })
  })
}

function scheduleSave(id: string, session: Session): void {
  if (session.saveTimer || session.retiring) return
  session.saveTimer = setTimeout(() => {
    session.saveTimer = undefined
    void save(id, session)
  }, SAVE_INTERVAL_MS)
  // Never what keeps the host alive; closing writes the final record.
  session.saveTimer.unref()
}

function receive(id: string, session: Session, data: string): void {
  session.parsed = session.parsed.then(() => new Promise<void>((resolve) => {
    session.screen.write(data, () => { session.version++; resolve() })
  }))
  session.buffer.push(data)
  session.buffered += data.length
  if (session.buffered >= FLUSH_LENGTH) flush(id, session)
  else session.flushTimer ??= setTimeout(() => flush(id, session), FLUSH_MS)
  scheduleSave(id, session)
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function start(request: Extract<PtyHostRequest, { type: 'spawn' }>): void {
  const pending = fileOps.get(request.id)
  if (!pending) return spawnShell(request)
  starting.set(request.id, [])
  const started = pending.then(() => {
    const queued = starting.get(request.id)!
    starting.delete(request.id)
    spawnShell(request)
    for (const queuedRequest of queued) handle(queuedRequest)
  })
  pendingStarts.add(started)
  void started.finally(() => pendingStarts.delete(started))
}

function spawnShell(request: Extract<PtyHostRequest, { type: 'spawn' }>): void {
  let pty: IPty
  // A record that cannot be read is reported in the pane; the shell still starts, and the next save replaces it.
  let restored: string
  let cwd = request.cwd
  try {
    const record = readTerminalHistory(request.history.path)
    if (record && directoryExists(record.cwd)) cwd = record.cwd
    // The new shell's prompt starts on a fresh line below the old output, with no marker between them.
    restored = record ? `${record.history}\x1b[0m\r\n` : ''
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    restored = `\x1b[2m${request.history.failed.replace('{message}', message)}\x1b[0m\r\n`
  }
  const screen = new headless.Terminal({ cols: request.cols, rows: request.rows, scrollback: SCROLLBACK, allowProposedApi: true })
  screen.loadAddon(new unicode11.Unicode11Addon())
  screen.unicode.activeVersion = '11'
  const serializer = new serialize.SerializeAddon()
  screen.loadAddon(serializer)
  try {
    pty = spawn(request.file, request.args, {
      name: request.env.TERM, cols: request.cols, rows: request.rows, cwd, env: request.env
    })
  } catch (error) {
    screen.dispose()
    // Spawn failures (missing shell, posix_spawnp, bad cwd) belong to this one pane, not the host.
    post({ type: 'spawn-failed', id: request.id, message: error instanceof Error ? error.message : String(error) })
    return
  }
  const session: Session = {
    pty, screen, serializer, historyPath: request.history.path, cwd, retiring: false,
    parsed: Promise.resolve(), version: 0, buffer: [], buffered: 0, unacked: 0, paused: false, closed: false, exited: false
  }
  sessions.set(request.id, session)
  historyPaths.set(request.id, request.history.path)
  // The old output reaches both parsers before anything the new shell prints.
  if (restored) receive(request.id, session, restored)
  // node-pty closes the fd on EIO before onExit fires; resizing that fd throws EBADF, which would crash
  // every terminal in this process, or hits another pty that reused the number. IPty's typings omit 'close'.
  ;(pty as unknown as NodeJS.EventEmitter).on('close', () => { session.closed = true })
  pty.onData((data) => receive(request.id, session, data))
  pty.onExit(({ exitCode, signal }) => {
    flush(request.id, session)
    clearTimeout(session.watchdog)
    // The tab closes on exit and discards the record; until then the last periodic save stands.
    clearTimeout(session.saveTimer)
    session.exited = true
    // The shell can exit before other members of its group that ignore SIGHUP; keep the group-kill timer alive.
    // A reloaded window may already have started a new shell under the same id.
    if (sessions.get(request.id) === session) sessions.delete(request.id)
    void session.parsed.then(() => screen.dispose())
    if (!session.retiring) post({ type: 'exit', id: request.id, exitCode, signal: signal || null })
  })
  post({ type: 'spawned', id: request.id, pid: pty.pid, cwd })
}

function close(id: string, history: 'keep' | 'discard'): void {
  const session = sessions.get(id)
  const path = historyPaths.get(id)
  historyPaths.delete(id)
  if (session) {
    session.retiring = true
    clearTimeout(session.saveTimer)
  }
  if (history === 'discard') {
    if (session) kill(session)
    if (path) void queueFile(id, () => removeTerminalHistory(path))
    return
  }
  // An exited shell keeps its last periodic save.
  if (!session) return
  const retirement = save(id, session, true).finally(() => {
    retirements.delete(retirement)
    if (!session.exited) kill(session)
  })
  retirements.add(retirement)
}

function kill(session: Session): void {
  if (session.killTimer) return
  // SIGHUP is what closing a terminal sends. The SIGKILL fallback reaches only the shell's own process group:
  // with job control each job has its own group, so jobs that ignore SIGHUP survive, as with nohup elsewhere.
  session.pty.kill()
  if (process.platform === 'win32') return
  let complete!: () => void
  const pending = new Promise<void>((resolve) => { complete = resolve })
  pendingKills.add(pending)
  session.killTimer = setTimeout(() => {
    try {
      process.kill(-session.pty.pid, 'SIGKILL')
    } catch (error) {
      // The group may have exited between the hang-up and this timer.
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    pendingKills.delete(pending)
    complete()
  }, KILL_GRACE_MS)
}

process.parentPort.on('message', ({ data }: { data: PtyHostRequest }) => {
  if (data.type === 'shutdown') {
    shuttingDown = true
    // A deferred spawn still starts its shell and replays the close main sent for it before shutting down.
    void Promise.all(pendingStarts).then(() => {
      for (const session of sessions.values()) if (!session.retiring) kill(session)
      // Retirements hang up their shells when they finish, adding to the pending kills.
      return Promise.all(retirements)
    })
      .then(() => Promise.all([...pendingKills, ...fileOps.values()]))
      .then(() => post({ type: 'shutdown-complete' }))
    return
  }
  if (shuttingDown) throw new Error('Terminal host is shutting down')
  handle(data)
})

function handle(data: Exclude<PtyHostRequest, { type: 'shutdown' }>): void {
  const queue = starting.get(data.id)
  if (queue) return void queue.push(data)
  if (data.type === 'spawn') return start(data)
  if (data.type === 'close') return close(data.id, data.history)
  // Input racing a shell's exit finds no session; the exit event already told main.
  const session = sessions.get(data.id)
  if (!session) {
    if (data.type === 'snapshot') post({ type: 'snapshot-failed', id: data.id, requestId: data.requestId, message: 'Unknown terminal' })
    return
  }
  switch (data.type) {
    case 'snapshot': {
      session.parsed = session.parsed.then(() => {
        const screen = session.screen
        const buffer = screen.buffer.active
        const start = Math.max(0, buffer.length - data.lines)
        const lines: string[] = []
        for (let i = start; i < buffer.length; i++) lines.push(buffer.getLine(i)!.translateToString(true))
        const text = lines.join('\n')
        post({ type: 'snapshot-result', id: data.id, requestId: data.requestId, snapshot: {
          text: text.slice(-32_768), cols: screen.cols, rows: screen.rows,
          cursorX: buffer.cursorX, cursorY: buffer.cursorY, alternateScreen: buffer.type === 'alternate',
          bracketedPaste: screen.modes.bracketedPasteMode, applicationCursor: screen.modes.applicationCursorKeysMode,
          version: session.version, truncated: start > 0 || text.length > 32_768
        } })
      }).catch((error: unknown) => {
        // Main receives the failure; rethrowing would reject the shared parse chain and crash every shell in this host.
        post({ type: 'snapshot-failed', id: data.id, requestId: data.requestId, message: error instanceof Error ? error.message : String(error) })
      })
      break
    }
    case 'clear':
      // Flush pre-clear output before the marker; both parsers clear between the same chunks.
      flush(data.id, session)
      post({ type: 'clear', id: data.id })
      session.parsed = session.parsed.then(() => { session.screen.clear(); session.version++ })
      scheduleSave(data.id, session)
      break
    case 'write': session.pty.write(data.binary ? Buffer.from(data.data, 'latin1') : data.data); break
    case 'resize':
      if (!session.closed) {
        session.pty.resize(data.cols, data.rows)
        session.parsed = session.parsed.then(() => {
          if (session.screen.cols === data.cols && session.screen.rows === data.rows) return
          session.screen.resize(data.cols, data.rows)
          session.version++
        })
        scheduleSave(data.id, session)
      }
      break
    case 'ack':
      session.unacked = Math.max(0, session.unacked - data.length)
      if (session.paused) {
        if (session.unacked <= RESUME_AT) resume(session)
        else armWatchdog(session)
      }
      break
  }
}
