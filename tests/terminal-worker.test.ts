import { test } from 'bun:test'
import assert from 'node:assert/strict'

// Keep node-pty's mock and process.parentPort confined to a separate Bun process.
const workerUrl = new URL('../src/main/terminal/pty-host-worker.ts', import.meta.url).href

function fixture(mode: 'descendant' | 'esrch' | 'eperm' | 'shell'): string {
  return `
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
const mode = ${JSON.stringify(mode)}
const realKill = process.kill.bind(process)
const descendantCode = \`process.on('SIGHUP', () => {}); console.log(process.pid); setInterval(() => {}, 1000)\`
const shellCode = \`
  import { spawn } from 'node:child_process'
  process.on('SIGHUP', () => { if (\${JSON.stringify(mode)} !== 'shell') process.exit(0) })
  if (\${JSON.stringify(mode)} === 'descendant') {
    spawn(process.execPath, ['-e', \${JSON.stringify(descendantCode)}], { stdio: ['ignore', 'inherit', 'inherit'] })
  } else console.log('ready')
  setInterval(() => {}, 1000)
\`
let shell
let exitCallback
let shellExited = false
let groupKillAt = 0
let groupError
const port = new EventEmitter()
const messages = []
port.postMessage = (message) => { messages.push(message); port.emit(message.type, message) }
process.parentPort = port
mock.module('node-pty', () => ({ spawn() {
  shell = spawn(process.execPath, ['-e', shellCode], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] })
  shell.on('exit', (code, signal) => { shellExited = true; exitCallback({ exitCode: code ?? 0, signal: signal ? 1 : 0 }) })
  return {
    pid: shell.pid,
    onData() {}, onExit(callback) { exitCallback = callback }, on() {},
    kill() { realKill(-shell.pid, 'SIGHUP') },
    pause() {}, resume() {}, write() {}, resize() {}
  }
} }))
process.on('exit', () => {
  if (shell?.pid) { try { realKill(-shell.pid, 'SIGKILL') } catch {} }
})
process.kill = (pid, signal) => {
  if (pid === -shell.pid && signal === 'SIGKILL') {
    groupKillAt = Date.now()
    if (mode !== 'shell') assert(shellExited, 'shell must exit before group cleanup')
    assert(!messages.some(message => message.type === 'shutdown-complete'), 'shutdown must wait for group SIGKILL')
    if (mode === 'eperm') throw Object.assign(new Error('GROUP_KILL_EPERM'), { code: 'EPERM' })
    try { return realKill(pid, signal) }
    catch (error) { groupError = error.code; throw error }
  }
  return realKill(pid, signal)
}
await import(${JSON.stringify(workerUrl)})
port.emit('message', { data: { type: 'spawn', id: 'test', file: 'mock', args: [], cwd: process.cwd(), env: { TERM: 'xterm' }, cols: 80, rows: 24, history: { path: join(mkdtempSync(join(tmpdir(), 'pig-history-')), 'test.json'), failed: '{message}' } } })
const [chunk] = await once(shell.stdout, 'data')
const descendantPid = mode === 'descendant' ? Number(chunk.toString().trim()) : undefined
const exited = once(shell, 'exit')
const killedAt = Date.now()
port.emit('message', { data: { type: 'close', id: 'test', history: 'discard' } })
if (mode !== 'shell') {
  await exited
  assert(Date.now() - killedAt < 1000, 'shell should exit within the HUP grace period')
}
if (descendantPid) assert(realKill(descendantPid, 0), 'HUP-ignoring descendant must still be alive after shell exit')
const shutdownComplete = once(port, 'shutdown-complete')
port.emit('message', { data: { type: 'shutdown' } })
if (mode === 'eperm') await new Promise(resolve => setTimeout(resolve, 1300))
else await shutdownComplete
assert(Date.now() - killedAt >= 900, 'shutdown must wait for the outstanding one-second cleanup')
if (mode === 'shell') await exited
assert(groupKillAt - killedAt >= 900, 'group SIGKILL must retain its grace period after shell exit')
assert(!messages.some(message => message.type === 'exit'), 'a shell main closed reports nothing more')
if (mode === 'esrch') assert.equal(groupError, 'ESRCH', 'already-exited group is safely ignored')
if (descendantPid) {
  // An orphan may briefly remain as a zombie on Linux; it is dead, not a surviving job.
  let dead = false
  for (let i = 0; i < 50; i++) {
    try {
      const state = execFileSync('ps', ['-o', 'stat=', '-p', String(descendantPid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      dead = !state || state.startsWith('Z')
    } catch { dead = true }
    if (dead) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert(dead, 'group SIGKILL must terminate the HUP-ignoring descendant')
}
console.log('verified')
`
}

for (const mode of ['descendant', 'esrch', 'eperm', 'shell'] as const) {
  test.skipIf(process.platform === 'win32')(`terminal worker retains post-exit group cleanup: ${mode}`, async () => {
    const child = Bun.spawn([process.execPath, '-e', fixture(mode)], {
      stdout: 'pipe', stderr: 'pipe', timeout: 8_000
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
    ])
    if (mode === 'eperm') {
      assert.notEqual(code, 0, 'non-ESRCH errors must escape the timer callback')
      assert.match(stderr, /GROUP_KILL_EPERM/)
    } else {
      assert.equal(code, 0, stderr)
      assert.match(stdout, /verified/)
    }
  }, 10_000)
}

const closedResizeFixture = `
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
const port = new EventEmitter()
process.parentPort = port
port.postMessage = () => {}
const ptys = []
mock.module('node-pty', () => ({ spawn() {
  const pty = Object.assign(new EventEmitter(), {
    pid: 1000 + ptys.length, fdOpen: true, sizes: [], writes: [],
    onData() {}, onExit() {}, kill() {}, pause() {}, resume() {}, write(data) { this.writes.push(data) },
    resize(cols, rows) {
      if (!this.fdOpen) throw Object.assign(new Error('ioctl(2) failed, EBADF'), { code: 'EBADF' })
      this.sizes.push([cols, rows])
    }
  })
  ptys.push(pty)
  return pty
} }))
await import(${JSON.stringify(workerUrl)})
const spawn = (id) => port.emit('message', { data: { type: 'spawn', id, file: 'mock', args: [], cwd: '/', env: { TERM: 'xterm' }, cols: 80, rows: 24, history: { path: join(mkdtempSync(join(tmpdir(), 'pig-history-')), id + '.json'), failed: '{message}' } } })
spawn('a')
spawn('b')
const bytes = String.fromCharCode(...Array.from({ length: 256 }, (_, i) => i))
port.emit('message', { data: { type: 'write', id: 'b', data: bytes, binary: true } })
port.emit('message', { data: { type: 'write', id: 'b', data: '中文😀' } })
port.emit('message', { data: { type: 'write', id: 'b', data: '中文😀', binary: false } })
assert(Buffer.isBuffer(ptys[1].writes[0]))
assert.deepEqual([...ptys[1].writes[0]], Array.from({ length: 256 }, (_, i) => i))
assert.deepEqual(ptys[1].writes.slice(1), ['中文😀', '中文😀'])
// EIO closed the fd; waitpid has not reported yet, so onExit has not fired.
ptys[0].fdOpen = false
ptys[0].emit('close')
port.emit('message', { data: { type: 'resize', id: 'a', cols: 100, rows: 30 } })
port.emit('message', { data: { type: 'resize', id: 'b', cols: 100, rows: 30 } })
assert.deepEqual(ptys[1].sizes, [[100, 30]])
console.log('verified')
`

test('terminal worker ignores a resize between the pty closing and the shell exit', async () => {
  const child = Bun.spawn([process.execPath, '-e', closedResizeFixture], { stdout: 'pipe', stderr: 'pipe', timeout: 8_000 })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  assert.equal(code, 0, stderr)
  assert.match(stdout, /verified/)
})

const historyFixture = `
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter, once } from 'node:events'
const port = new EventEmitter()
process.parentPort = port
const messages = []
port.postMessage = (message) => { messages.push(message); port.emit(message.type, message) }
const realKill = process.kill.bind(process)
process.kill = (pid, signal) => pid < 0 ? true : realKill(pid, signal)
const ptys = new Map()
mock.module('node-pty', () => ({ spawn(_file, _args, options) {
  const pty = Object.assign(new EventEmitter(), {
    pid: 4_000_000 + ptys.size, options, killed: false,
    onData(callback) { this.data = callback }, onExit(callback) { this.exit = callback },
    kill() { this.killed = true }, pause() {}, resume() {}, write() {}, resize() {}
  })
  ptys.set(options.cwd + ':' + ptys.size, pty)
  return pty
} }))
await import(${JSON.stringify(workerUrl)})
const root = mkdtempSync(join(tmpdir(), 'pig-history-'))
const saved = join(root, 'saved-dir')
mkdirSync(saved)
const target = (name) => ({ path: join(root, name + '.json'), failed: 'FAILED {message}' })
const spawn = (id, name) => port.emit('message', { data: { type: 'spawn', id, file: 'mock', args: [], cwd: root, env: { TERM: 'xterm' }, cols: 80, rows: 24, history: target(name) } })
const output = (id) => messages.filter((message) => message.type === 'output' && message.id === id).map((message) => message.data).join('')
const record = (name) => JSON.parse(readFileSync(join(root, name + '.json'), 'utf8'))
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

writeFileSync(target('a').path, JSON.stringify({ version: 1, cwd: saved, history: 'old line\\r\\n' }))
spawn('a', 'a')
const ptyA = [...ptys.values()].at(-1)
assert.equal(ptyA.options.cwd, saved, 'the shell starts where it was last seen')
assert.equal(messages.find((message) => message.type === 'spawned' && message.id === 'a').cwd, saved)
await settle(30)
assert.equal(output('a'), 'old line\\r\\n\\x1b[0m\\r\\n', 'the old output comes back alone, without a marker')
ptyA.data('new output\\r\\n')
await settle(5300)
const periodic = record('a')
assert.match(periodic.history, /old line[\\s\\S]*new output/)
assert.equal(periodic.cwd, saved)
if (process.platform !== 'win32') assert.equal(statSync(target('a').path).mode & 0o777, 0o600)

writeFileSync(target('b').path, '{not json')
spawn('b', 'b')
const ptyB = [...ptys.values()].at(-1)
assert.equal(ptyB.options.cwd, root, 'an unreadable record starts the shell in the tab directory')
await settle(30)
assert.match(output('b'), /FAILED /, 'an unreadable record is reported in the pane')
port.emit('message', { data: { type: 'close', id: 'b', history: 'discard' } })
assert(ptyB.killed)

spawn('c', 'c')
const ptyC = [...ptys.values()].at(-1)
writeFileSync(target('c').path, JSON.stringify({ version: 1, cwd: root, history: '' }))
ptyC.exit({ exitCode: 0, signal: 0 })
port.emit('message', { data: { type: 'close', id: 'c', history: 'discard' } })
assert.equal(ptyC.killed, false, 'an exited shell is not hung up again')

spawn('d', 'd')
const oldD = [...ptys.values()].at(-1)
oldD.data('said just before the reload\\r\\n')
port.emit('message', { data: { type: 'close', id: 'd', history: 'keep' } })
spawn('d', 'd')
port.emit('message', { data: { type: 'resize', id: 'd', cols: 70, rows: 20 } })
assert.equal([...ptys.values()].at(-1), oldD, 'the new shell waits for the final record of the old shell')
oldD.data('after close\\r\\n')
await settle(300)
const newD = [...ptys.values()].at(-1)
assert.notEqual(newD, oldD)
assert(oldD.killed, 'a reloaded window starting the same id still hangs up the old shell')
const dOutput = output('d')
assert.match(dOutput, /said just before the reload/, 'the restart reads the final record, not an older periodic one')
assert.doesNotMatch(dOutput, /after close/, 'a closed shell posts no more output')
oldD.exit({ exitCode: 0, signal: 0 })
assert(!messages.some((message) => message.type === 'exit' && message.id === 'd'), 'nor its exit, which main would take for the new shell')
port.emit('message', { data: { type: 'resize', id: 'd', cols: 90, rows: 20 } })
newD.resize = () => { newD.resized = true }
port.emit('message', { data: { type: 'resize', id: 'd', cols: 91, rows: 20 } })
assert(newD.resized, 'the old shell exiting leaves the new one under the same id')

ptyA.data('last words\\r\\n')
port.emit('message', { data: { type: 'close', id: 'a', history: 'keep' } })
assert.equal(ptyA.killed, false, 'the final record is written before the hang-up')
const complete = once(port, 'shutdown-complete')
port.emit('message', { data: { type: 'shutdown' } })
await complete
assert(ptyA.killed)
assert.match(record('a').history, /last words/, 'the record written at close holds output received just before it')
assert.equal(existsSync(target('b').path), false, 'a closed tab discards its record')
assert.equal(existsSync(target('c').path), false, 'a tab closed after its shell exited discards its record too')
ptyC.data('late\\r\\n')
await settle(100)
assert.equal(existsSync(target('c').path), false, 'no late save recreates a discarded record')
console.log('verified')
`

test.skipIf(process.platform === 'win32')('terminal worker restores, saves and discards the restart record', async () => {
  const child = Bun.spawn([process.execPath, '-e', historyFixture], { stdout: 'pipe', stderr: 'pipe', timeout: 12_000 })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  assert.equal(code, 0, stderr)
  assert.match(stdout, /verified/)
}, 15_000)
