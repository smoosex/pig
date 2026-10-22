import { test } from 'bun:test'
import assert from 'node:assert/strict'

// Exercise the real headless parser with a fake PTY, isolated from other node-pty mocks.
const workerUrl = new URL('../src/main/terminal/pty-host-worker.ts', import.meta.url).href
const fixture = `
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
const port = new EventEmitter()
const messages = []
let failResult = false
port.postMessage = message => {
  if (failResult && message.type === 'snapshot-result') { failResult = false; throw new Error('result failed') }
  messages.push(message); port.emit('reply', message)
}
process.parentPort = port
let output
const writes = []
const sizes = []
mock.module('node-pty', () => ({ spawn: () => ({
  pid: 123, on() {}, onData(fn) { output = fn }, onExit() {},
  write(data) { writes.push(data) }, resize(cols, rows) { sizes.push([cols, rows]) },
  kill() {}, pause() {}, resume() {}
}) }))
await import(${JSON.stringify(workerUrl)})
const send = data => port.emit('message', { data })
send({ type: 'spawn', id: 'test', file: 'mock', args: [], cwd: '/', env: { TERM: 'xterm' }, cols: 10, rows: 3, history: { path: join(mkdtempSync(join(tmpdir(), 'pig-history-')), 'test.json'), failed: '{message}' } })
let next = 0
const snapshot = (lines = 3) => new Promise((resolve, reject) => {
  const requestId = String(++next)
  const listener = message => {
    if (message.requestId !== requestId) return
    port.off('reply', listener)
    if (message.type === 'snapshot-failed') reject(new Error(message.message))
    else resolve(message.snapshot)
  }
  port.on('reply', listener)
  send({ type: 'snapshot', id: 'test', requestId, lines })
})
output('abcdef\\rXY')
let state = await snapshot()
assert.equal(state.text, 'XYcdef\\n\\n')
assert.equal(state.cursorX, 2)
assert.equal(state.cursorY, 0)
assert.equal(state.version, 1)
assert.equal(state.alternateScreen, false)
assert.equal(state.truncated, false)
assert.equal((await snapshot()).version, state.version, 'reads do not change version')
failResult = true
await assert.rejects(snapshot(), /result failed/)
output('\\r\\nafter')
assert.equal((await snapshot()).text, 'XYcdef\\nafter\\n', 'a failed snapshot does not block later parsing')
output('\\x1b[2J\\x1b[HXYcdef\\x1b[1;3H')
output('\\x1b[?1h\\x1b[?2004h')
state = await snapshot()
assert.equal(state.applicationCursor, true)
assert.equal(state.bracketedPaste, true)
output('\\x1b[2J\\x1b[Hclean')
state = await snapshot()
assert.equal(state.text, 'clean\\n\\n', 'erase and cursor movement are parsed before reply')
output('\\x1b[?1049h\\x1b[Halt')
state = await snapshot()
assert.equal(state.alternateScreen, true)
assert.equal(state.text, 'alt\\n\\n')
output('\\x1b[?1049l')
state = await snapshot()
assert.equal(state.text, 'clean\\n\\n')
assert.equal(state.alternateScreen, false)
const version = state.version
send({ type: 'resize', id: 'test', cols: 12, rows: 4 })
state = await snapshot(4)
assert.deepEqual([state.cols, state.rows], [12, 4])
assert.equal(state.version, version + 1)
send({ type: 'resize', id: 'test', cols: 12, rows: 4 })
assert.equal((await snapshot()).version, state.version, 'unchanged resize is not a new version')
assert.deepEqual(sizes, [[12, 4], [12, 4]])
output('\\r\\nold1\\r\\nold2\\r\\ncurrent')
const beforeClear = await snapshot(100)
send({ type: 'clear', id: 'test' })
output('next')
state = await snapshot(100)
assert.equal(state.text, 'currentnext\\n\\n\\n', 'local clear and following PTY output share the same parser order')
assert.equal(state.cursorY, 0)
assert.equal(state.cursorX, 11)
assert.equal(state.version, beforeClear.version + 2)
const clearIndex = messages.findIndex(message => message.type === 'clear')
assert(clearIndex > 0 && messages[clearIndex - 1].type === 'output', 'renderer clear marker follows flushed pre-clear output')
output('\\x1b[2J\\x1b[H' + Array.from({ length: 5100 }, (_, i) => 'line' + i).join('\\r\\n'))
state = await snapshot(500)
assert.equal(state.text.split('\\n').length, 500)
assert.equal(state.truncated, true)
assert(state.text.endsWith('line5099'))
state = await snapshot(1)
assert.equal(state.text, 'line5099')
// Short rows keep this internal storage-bound check below the text response cap.
output('\\x1b[3J\\x1b[2J\\x1b[H' + Array(5100).fill('a').join('\\r\\n'))
state = await snapshot(6000)
assert.equal(state.text.split('\\n').length, 5004, 'scrollback is bounded to 5000 lines plus the viewport')
send({ type: 'resize', id: 'test', cols: 1000, rows: 40 })
output('\\x1b[2J\\x1b[H' + Array(40).fill('x'.repeat(1000)).join('\\r\\n'))
state = await snapshot(40)
assert.equal(state.text.length, 32768)
assert.equal(state.truncated, true)
assert(!state.text.includes('\\x1b'), 'snapshots contain rendered text, not ANSI')
output('\\x1b[6n')
await snapshot()
assert.deepEqual(writes, [], 'terminal response sequences must not become PTY commands or input')
// Let coalesced output finish so this test also exercises the existing transport unchanged.
await new Promise(resolve => setTimeout(resolve, 30))
assert(messages.some(message => message.type === 'output' && message.data.includes('\\x1b')))
console.log('verified')
process.exit(0)
`

test('terminal snapshots parse queued output, alternate screen, resize and bounded scrollback', async () => {
  const child = Bun.spawn([process.execPath, '-e', fixture], { stdout: 'pipe', stderr: 'pipe', timeout: 10_000 })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  assert.equal(code, 0, stderr || stdout)
  assert.match(stdout, /verified/)
}, 15_000)
