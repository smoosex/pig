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
 */
import { spawn, type IPty } from 'node-pty'
import headless from '@xterm/headless'
import unicode11 from '@xterm/addon-unicode11'
import type { Terminal as HeadlessTerminal } from '@xterm/headless'
import type { PtyHostMessage, PtyHostRequest } from '../../shared/terminal'

const FLUSH_MS = 16
const FLUSH_LENGTH = 128 * 1024
const PAUSE_AT = 100_000
const RESUME_AT = 5_000
const ACK_TIMEOUT_MS = 10_000
const KILL_GRACE_MS = 1_000

interface Session {
  pty: IPty
  screen: HeadlessTerminal
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
}

const sessions = new Map<string, Session>()
// Closed panes and exited shells can still have a group-kill timer outstanding.
const pendingKills = new Set<Promise<void>>()
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

function start(request: Extract<PtyHostRequest, { type: 'spawn' }>): void {
  let pty: IPty
  const screen = new headless.Terminal({ cols: request.cols, rows: request.rows, scrollback: 5000, allowProposedApi: true })
  screen.loadAddon(new unicode11.Unicode11Addon())
  screen.unicode.activeVersion = '11'
  try {
    pty = spawn(request.file, request.args, {
      name: request.env.TERM, cols: request.cols, rows: request.rows, cwd: request.cwd, env: request.env
    })
  } catch (error) {
    screen.dispose()
    // Spawn failures (missing shell, posix_spawnp, bad cwd) belong to this one pane, not the host.
    post({ type: 'spawn-failed', id: request.id, message: error instanceof Error ? error.message : String(error) })
    return
  }
  const session: Session = { pty, screen, parsed: Promise.resolve(), version: 0, buffer: [], buffered: 0, unacked: 0, paused: false, closed: false }
  sessions.set(request.id, session)
  // node-pty closes the fd on EIO before onExit fires; resizing that fd throws EBADF, which would crash
  // every terminal in this process, or hits another pty that reused the number. IPty's typings omit 'close'.
  ;(pty as unknown as NodeJS.EventEmitter).on('close', () => { session.closed = true })
  pty.onData((data) => {
    session.parsed = session.parsed.then(() => new Promise<void>((resolve) => {
      screen.write(data, () => { session.version++; resolve() })
    }))
    session.buffer.push(data)
    session.buffered += data.length
    if (session.buffered >= FLUSH_LENGTH) flush(request.id, session)
    else session.flushTimer ??= setTimeout(() => flush(request.id, session), FLUSH_MS)
  })
  pty.onExit(({ exitCode, signal }) => {
    flush(request.id, session)
    clearTimeout(session.watchdog)
    // The shell can exit before other members of its group that ignore SIGHUP; keep the group-kill timer alive.
    sessions.delete(request.id)
    void session.parsed.then(() => screen.dispose())
    post({ type: 'exit', id: request.id, exitCode, signal: signal || null })
  })
  post({ type: 'spawned', id: request.id, pid: pty.pid })
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
    for (const session of sessions.values()) kill(session)
    void Promise.all(pendingKills).then(() => post({ type: 'shutdown-complete' }))
    return
  }
  if (shuttingDown) throw new Error('Terminal host is shutting down')
  if (data.type === 'spawn') return start(data)
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
      }
      break
    case 'ack':
      session.unacked = Math.max(0, session.unacked - data.length)
      if (session.paused) {
        if (session.unacked <= RESUME_AT) resume(session)
        else armWatchdog(session)
      }
      break
    case 'kill': kill(session); break
  }
})
