import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { TerminalHost, type PtyHostProcess } from '../src/main/terminal/host'
import { exitAfterCleanup } from '../src/main/shutdown'
import type { PtyHostRequest } from '../src/shared/terminal'

const history = (id: string) => ({ path: `/history/${id}`, failed: 'failed: {message}' })

class Worker extends EventEmitter {
  sent: PtyHostRequest[] = []
  postMessage(message: PtyHostRequest) { this.sent.push(message) }
  kill(): boolean { throw new Error('Must not kill worker before its cleanup timers finish') }
}

test('quit waits for the worker acknowledgement even after the session teardown deadline', async () => {
  const worker = new Worker()
  const host = new TerminalHost(() => worker as PtyHostProcess, '1', history)
  const win = { isDestroyed: () => true, webContents: { send() {} } }
  const starting = host.create(win, 'terminal:a', '/tmp', 80, 24)
  const rejected = assert.rejects(starting, /Terminal closed/)
  const shutdown = host.shutdown()
  assert.equal(host.shutdown(), shutdown)
  await rejected
  assert.deepEqual(worker.sent.slice(1), [{ type: 'close', id: 'terminal:a', history: 'keep' }, { type: 'shutdown' }])
  assert.throws(() => host.create(win, 'terminal:b', '/tmp', 80, 24), /shutting down/)
  const exits: number[] = []
  const quit = exitAfterCleanup(shutdown, Promise.resolve('deadline reached'), (code) => exits.push(code))
  worker.emit('message', { type: 'exit', id: 'terminal:a', exitCode: 0, signal: 1 })
  await Promise.resolve()
  assert.deepEqual(exits, [], 'shell exit does not complete pending group cleanup')
  worker.emit('message', { type: 'shutdown-complete' })
  await quit
  assert.deepEqual(exits, [0])
})

test('worker exit before its acknowledgement rejects shutdown rather than reporting success', async () => {
  const worker = new Worker()
  const host = new TerminalHost(() => worker as PtyHostProcess, '1', history)
  const win = { isDestroyed: () => true, webContents: { send() {} } }
  const starting = host.create(win, 'terminal:a', '/tmp', 80, 24)
  const rejected = assert.rejects(starting, /Terminal closed/)
  const shutdown = host.shutdown()
  const failed = assert.rejects(shutdown, /exited before shutdown completed/)
  worker.emit('exit', 1)
  await Promise.all([rejected, failed])
})

test('shutdown without a worker does not fork one', async () => {
  const host = new TerminalHost(() => { throw new Error('Unexpected fork') }, '1', history)
  await host.shutdown()
})
