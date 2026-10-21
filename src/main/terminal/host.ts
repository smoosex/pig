/**
 * Terminal panes belong to the UI window that created them, never to a Pi session. Main keeps the
 * ownership map and talks to one lazily forked PTY utility process; that process holds every shell.
 * If it dies, each live pane is told so and the next terminal forks a fresh host.
 */
import type { PtyHostMessage, PtyHostRequest, TerminalEvent, TerminalInfo } from '../../shared/terminal'
import { terminalEnvironment, terminalShell } from './environment'

export interface PtyHostProcess {
  postMessage(message: PtyHostRequest): void
  on(event: 'message', listener: (message: PtyHostMessage) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  kill(): boolean
}

export interface TerminalWindow {
  isDestroyed(): boolean
  webContents: { send(channel: 'terminal:event', event: TerminalEvent): void }
}

interface Terminal {
  win: TerminalWindow
  info: TerminalInfo
  exited: boolean
  spawn?: { resolve(info: TerminalInfo): void; reject(error: Error): void }
}

export class TerminalHost {
  private worker: PtyHostProcess | null = null
  private readonly terminals = new Map<string, Terminal>()
  private shutdownPromise?: Promise<void>
  private shutdownResult?: { resolve(): void; reject(error: Error): void }

  constructor(
    private readonly fork: () => PtyHostProcess,
    private readonly appVersion: string
  ) {}

  create(win: TerminalWindow, id: string, cwd: string, cols: number, rows: number): Promise<TerminalInfo> {
    if (this.shutdownPromise) throw new Error('Terminal host is shutting down')
    if (this.terminals.has(id)) throw new Error('Terminal already exists')
    const shell = terminalShell()
    const env = terminalEnvironment(process.env, this.appVersion)
    const worker = this.ensureWorker()
    return new Promise((resolve, reject) => {
      this.terminals.set(id, { win, info: { pid: 0, shell: shell.file, cwd }, exited: false, spawn: { resolve, reject } })
      worker.postMessage({ type: 'spawn', id, file: shell.file, args: shell.args, cwd, env, cols, rows })
    })
  }

  write(win: TerminalWindow, id: string, data: string, binary?: boolean): void {
    if (!this.owned(win, id).exited) this.worker!.postMessage({ type: 'write', id, data, ...(binary === undefined ? {} : { binary }) })
  }

  resize(win: TerminalWindow, id: string, cols: number, rows: number): void {
    if (!this.owned(win, id).exited) this.worker!.postMessage({ type: 'resize', id, cols, rows })
  }

  ack(win: TerminalWindow, id: string, length: number): void {
    if (!this.owned(win, id).exited) this.worker!.postMessage({ type: 'ack', id, length })
  }

  /** Idempotent: a tab may close before, during or after its shell starts or exits. */
  close(win: TerminalWindow, id: string): void {
    const terminal = this.terminals.get(id)
    if (!terminal) return
    if (terminal.win !== win) throw new Error('Terminal belongs to another window')
    this.terminals.delete(id)
    terminal.spawn?.reject(new Error('Terminal closed'))
    // Ordered after the spawn request on the same port, so a still-starting shell is killed too.
    if (!terminal.exited && this.worker) this.worker.postMessage({ type: 'kill', id })
  }

  closeWindow(win: TerminalWindow): void {
    for (const [id, terminal] of [...this.terminals]) if (terminal.win === win) this.close(win, id)
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.shutdownPromise = new Promise((resolve, reject) => {
      this.shutdownResult = { resolve, reject }
    })
    if (!this.worker) this.shutdownResult!.resolve()
    else {
      try {
        for (const [id, terminal] of this.terminals) this.close(terminal.win, id)
        this.worker.postMessage({ type: 'shutdown' })
      } catch (error) {
        this.shutdownResult!.reject(error as Error)
      }
    }
    return this.shutdownPromise
  }

  private owned(win: TerminalWindow, id: string): Terminal {
    const terminal = this.terminals.get(id)
    if (!terminal) throw new Error('Unknown terminal')
    if (terminal.win !== win) throw new Error('Terminal belongs to another window')
    return terminal
  }

  private ensureWorker(): PtyHostProcess {
    if (this.worker) return this.worker
    const worker = this.fork()
    this.worker = worker
    worker.on('message', (message) => this.receive(message))
    worker.on('exit', (code) => {
      if (this.worker !== worker) return
      this.worker = null
      this.shutdownResult?.reject(new Error(`Terminal host exited before shutdown completed with code ${code}`))
      for (const [id, terminal] of this.terminals) {
        if (terminal.exited) continue
        terminal.exited = true
        const message = `Terminal host exited with code ${code}`
        if (terminal.spawn) {
          this.terminals.delete(id)
          terminal.spawn.reject(new Error(message))
        } else {
          this.emit(terminal, { terminalId: id, kind: 'failed', message })
        }
      }
    })
    return worker
  }

  private receive(message: PtyHostMessage): void {
    if (message.type === 'shutdown-complete') {
      this.shutdownResult?.resolve()
      return
    }
    const terminal = this.terminals.get(message.id)
    // Late messages for closed panes are expected: close does not wait for the shell to die.
    if (!terminal) return
    switch (message.type) {
      case 'spawned': {
        terminal.info = { ...terminal.info, pid: message.pid }
        const spawn = terminal.spawn
        terminal.spawn = undefined
        spawn?.resolve(terminal.info)
        break
      }
      case 'spawn-failed':
        this.terminals.delete(message.id)
        terminal.spawn?.reject(new Error(message.message))
        break
      case 'output':
        this.emit(terminal, { terminalId: message.id, kind: 'output', data: message.data })
        break
      case 'exit':
        terminal.exited = true
        this.emit(terminal, { terminalId: message.id, kind: 'exit', exitCode: message.exitCode, signal: message.signal })
        break
    }
  }

  private emit(terminal: Terminal, event: TerminalEvent): void {
    if (!terminal.win.isDestroyed()) terminal.win.webContents.send('terminal:event', event)
  }
}
