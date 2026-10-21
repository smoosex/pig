import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { TerminalHost, type PtyHostProcess, type TerminalWindow } from '../src/main/terminal/host'
import { terminalEnvironment } from '../src/main/terminal/environment'
import type { PtyHostMessage, PtyHostRequest, TerminalEvent } from '../src/shared/terminal'

class FakeWorker implements PtyHostProcess {
  sent: PtyHostRequest[] = []
  killed = false
  private listeners: { message: ((message: PtyHostMessage) => void)[]; exit: ((code: number) => void)[] } = { message: [], exit: [] }
  postMessage(message: PtyHostRequest) { this.sent.push(message) }
  on(event: 'message' | 'exit', listener: (value: never) => void) {
    this.listeners[event].push(listener as never)
    return this
  }
  kill() { this.killed = true; return true }
  reply(message: PtyHostMessage) { for (const listener of this.listeners.message) listener(message) }
  exit(code: number) { for (const listener of this.listeners.exit) listener(code) }
}

function fakeWindow() {
  const events: TerminalEvent[] = []
  const win: TerminalWindow = { isDestroyed: () => false, webContents: { send: (_channel, event) => { events.push(event) } } }
  return { win, events }
}

test('terminal environment drops the launching terminal and Pig internals, and declares Pig as the terminal', () => {
  const env = terminalEnvironment({
    PATH: '/usr/bin', HOME: '/home/me', TERM: 'xterm-ghostty', TERM_PROGRAM: 'ghostty', GHOSTTY_RESOURCES_DIR: '/x',
    COLORTERM: 'truecolor', NO_COLOR: '1', PIG_DIR: '/Users/me/.pig', ELECTRON_RUN_AS_NODE: '1', TERMINFO: '/x', EMPTY: undefined
  }, '1.2.3')
  assert.deepEqual(env, {
    PATH: '/usr/bin', HOME: '/home/me', TERM: 'xterm-256color', COLORTERM: 'truecolor',
    TERM_PROGRAM: 'Pig', TERM_PROGRAM_VERSION: '1.2.3', LANG: 'en_US.UTF-8'
  })
  assert.equal(terminalEnvironment({ LC_ALL: 'zh_CN.UTF-8' }, '1').LANG, undefined, 'an existing locale is kept as the user set it')
})

test('terminal host scopes shells to their window and survives a crashed PTY host', async () => {
  const workers: FakeWorker[] = []
  const host = new TerminalHost(() => { const worker = new FakeWorker(); workers.push(worker); return worker }, '1.0.0')
  const owner = fakeWindow()
  const other = fakeWindow()

  const created = host.create(owner.win, 'terminal:a', '/project', 80, 24)
  const spawn = workers[0].sent[0]
  assert.equal(spawn.type, 'spawn')
  assert.deepEqual(spawn.type === 'spawn' && { cwd: spawn.cwd, cols: spawn.cols, rows: spawn.rows, term: spawn.env.TERM }, { cwd: '/project', cols: 80, rows: 24, term: 'xterm-256color' })
  workers[0].reply({ type: 'spawned', id: 'terminal:a', pid: 42 })
  assert.equal((await created).pid, 42)
  assert.throws(() => host.create(owner.win, 'terminal:a', '/project', 80, 24), /already exists/)

  workers[0].reply({ type: 'output', id: 'terminal:a', data: 'hi' })
  assert.deepEqual(owner.events, [{ terminalId: 'terminal:a', kind: 'output', data: 'hi' }])
  assert.equal(other.events.length, 0)
  assert.throws(() => host.write(other.win, 'terminal:a', 'x'), /another window/)
  assert.throws(() => host.close(other.win, 'terminal:a'), /another window/)
  host.write(owner.win, 'terminal:a', 'ls\r')
  host.ack(owner.win, 'terminal:a', 2)
  assert.deepEqual(workers[0].sent.slice(1), [{ type: 'write', id: 'terminal:a', data: 'ls\r' }, { type: 'ack', id: 'terminal:a', length: 2 }])

  host.write(owner.win, 'terminal:a', '\x00\x80\xff', true)
  assert.deepEqual(workers[0].sent.at(-1), { type: 'write', id: 'terminal:a', data: '\x00\x80\xff', binary: true })
  host.write(owner.win, 'terminal:a', '中文', false)
  assert.deepEqual(workers[0].sent.at(-1), { type: 'write', id: 'terminal:a', data: '中文', binary: false })
  assert.throws(() => host.clear(other.win, 'terminal:a'), /another window/)
  host.clear(owner.win, 'terminal:a')
  assert.deepEqual(workers[0].sent.at(-1), { type: 'clear', id: 'terminal:a' })
  workers[0].reply({ type: 'clear', id: 'terminal:a' })
  assert.deepEqual(owner.events.at(-1), { terminalId: 'terminal:a', kind: 'clear' })
  host.ack(owner.win, 'terminal:a', 0)

  workers[0].reply({ type: 'exit', id: 'terminal:a', exitCode: 3, signal: null })
  assert.deepEqual(owner.events.at(-1), { terminalId: 'terminal:a', kind: 'exit', exitCode: 3, signal: null })
  host.write(owner.win, 'terminal:a', 'late')
  assert.equal(workers[0].sent.at(-1)?.type, 'ack', 'input after exit never reaches the host')
  host.close(owner.win, 'terminal:a')
  host.close(owner.win, 'terminal:a')
  assert.equal(workers[0].sent.some((message) => message.type === 'kill'), false, 'an exited shell needs no kill')

  const failed = host.create(owner.win, 'terminal:b', '/missing', 80, 24)
  workers[0].reply({ type: 'spawn-failed', id: 'terminal:b', message: 'posix_spawnp failed' })
  await assert.rejects(failed, /posix_spawnp failed/)

  const closing = host.create(owner.win, 'terminal:c', '/project', 80, 24)
  host.closeWindow(owner.win)
  await assert.rejects(closing, /Terminal closed/)
  assert.deepEqual(workers[0].sent.at(-1), { type: 'kill', id: 'terminal:c' }, 'a shell still starting is killed after it spawns')

  const live = host.create(owner.win, 'terminal:d', '/project', 80, 24)
  workers[0].reply({ type: 'spawned', id: 'terminal:d', pid: 7 })
  await live
  const starting = host.create(owner.win, 'terminal:e', '/project', 80, 24)
  workers[0].exit(1)
  await assert.rejects(starting, /exited with code 1/)
  assert.deepEqual(owner.events.at(-1), { terminalId: 'terminal:d', kind: 'failed', message: 'Terminal host exited with code 1' })
  void host.create(owner.win, 'terminal:f', '/project', 80, 24)
  assert.equal(workers.length, 2, 'the next terminal forks a fresh host')
})

test('terminal snapshots correlate replies, scope lists and cancel pending reads across lifecycle changes', async () => {
  const worker = new FakeWorker()
  const host = new TerminalHost(() => worker, '1')
  const { win } = fakeWindow()
  const other = fakeWindow().win
  const create = async (id: string) => {
    const pending = host.create(win, id, '/project', 80, 24)
    worker.reply({ type: 'spawned', id, pid: 42 })
    await pending
  }
  const request = () => {
    const message = worker.sent.at(-1)!
    assert.equal(message.type, 'snapshot')
    if (message.type !== 'snapshot') throw new Error('Expected snapshot request')
    return message
  }
  const snapshot = { text: 'plain', cols: 80, rows: 24, cursorX: 5, cursorY: 0, alternateScreen: false, bracketedPaste: false, applicationCursor: false, version: 1, truncated: false }
  await create('terminal:a')
  assert.deepEqual(host.list(other), [])
  assert.deepEqual(host.list(win), [{ terminalId: 'terminal:a', info: { pid: 42, shell: host.list(win)[0].info.shell, cwd: '/project' }, exited: false }])
  await assert.rejects(host.snapshot(other, 'terminal:a', 10), /another window/)
  const first = host.snapshot(win, 'terminal:a', 10)
  const a = request()
  const second = host.snapshot(win, 'terminal:a', 20)
  const b = request()
  assert.notEqual(a.requestId, b.requestId)
  worker.reply({ type: 'snapshot-result', id: b.id, requestId: b.requestId, snapshot })
  assert.deepEqual(await second, snapshot)
  worker.reply({ type: 'snapshot-failed', id: a.id, requestId: a.requestId, message: 'read failed' })
  await assert.rejects(first, /read failed/)

  const controller = new AbortController()
  const aborted = host.snapshot(win, 'terminal:a', 10, controller.signal)
  const late = request()
  controller.abort(new Error('cancelled'))
  await assert.rejects(aborted, /cancelled/)
  worker.reply({ type: 'snapshot-result', id: late.id, requestId: late.requestId, snapshot })
  const sent = worker.sent.length
  await assert.rejects(host.snapshot(win, 'terminal:a', 10, controller.signal), /cancelled/)
  assert.equal(worker.sent.length, sent)

  const closed = host.snapshot(win, 'terminal:a', 10)
  host.close(win, 'terminal:a')
  await assert.rejects(closed, /closed/)
  await create('terminal:b')
  const exited = host.snapshot(win, 'terminal:b', 10)
  worker.reply({ type: 'exit', id: 'terminal:b', exitCode: 0, signal: null })
  await assert.rejects(exited, /exited/)
  assert.equal(host.list(win)[0].exited, true)
  await assert.rejects(host.snapshot(win, 'terminal:b', 10), /exited/)
  await create('terminal:c')
  const crashed = host.snapshot(win, 'terminal:c', 10)
  worker.exit(1)
  await assert.rejects(crashed, /host exited/)
})

test('terminal shutdown rejects pending snapshots before waiting for worker cleanup', async () => {
  const worker = new FakeWorker()
  const host = new TerminalHost(() => worker, '1')
  const { win } = fakeWindow()
  const created = host.create(win, 'terminal:a', '/', 80, 24)
  worker.reply({ type: 'spawned', id: 'terminal:a', pid: 42 })
  await created
  const read = host.snapshot(win, 'terminal:a', 10)
  const shutdown = host.shutdown()
  await assert.rejects(read, /closed/)
  worker.reply({ type: 'shutdown-complete' })
  await shutdown
})

test('terminal IPC rejects malformed binary input before forwarding to the host', async () => {
  const fixture = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const handlers = new Map()
    const writes = []
    const win = {}
    mock.module('electron', () => ({ app: { getVersion: () => '1' }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, utilityProcess: {} }))
    mock.module(${JSON.stringify(new URL('../src/main/terminal/host.ts', import.meta.url).href)}, () => ({ TerminalHost: class { write(...args) { writes.push(args) } } }))
    mock.module(${JSON.stringify(new URL('../src/main/browser/validation.ts', import.meta.url).href)}, () => ({ assertBrowserSender() {} }))
    mock.module(${JSON.stringify(new URL('../src/main/ipc/window.ts', import.meta.url).href)}, () => ({ windowForEvent: () => win }))
    mock.module(${JSON.stringify(new URL('../src/main/i18n.ts', import.meta.url).href)}, () => ({ t: (key) => key }))
    const { registerTerminalIpc } = await import(${JSON.stringify(new URL('../src/main/ipc/terminal.ts', import.meta.url).href)})
    registerTerminalIpc()
    const write = handlers.get('terminal:write')
    for (const flag of [null, 0, 1, 'true', {}, []]) {
      assert.throws(() => write({}, 'terminal:a', 'x', flag), /binary flag/)
    }
    for (const data of [String.fromCharCode(256), '中文', '😀']) {
      assert.throws(() => write({}, 'terminal:a', data, true), /binary input/)
    }
    for (const data of [null, 1, 'x'.repeat(65537)]) {
      assert.throws(() => write({}, 'terminal:a', data, true), /terminal input/)
    }
    assert.equal(writes.length, 0)
    const bytes = String.fromCharCode(...Array.from({ length: 256 }, (_, i) => i))
    write({}, 'terminal:a', bytes, true)
    write({}, 'terminal:a', '中文')
    write({}, 'terminal:a', '😀', false)
    assert.deepEqual(writes, [[win, 'terminal:a', bytes, true], [win, 'terminal:a', '中文', undefined], [win, 'terminal:a', '😀', false]])
  `
  const child = Bun.spawn([process.execPath, '-e', fixture], { stdout: 'pipe', stderr: 'pipe', timeout: 8_000 })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  assert.equal(code, 0, stderr || stdout)
})
