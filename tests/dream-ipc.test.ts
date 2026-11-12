import { test, mock } from 'bun:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { runSelf } from './helpers/subprocess'

if (process.argv.includes('--dream-ipc-fixture')) {
  const handlers = new Map<string, (...args: any[]) => unknown>()
  const contents = Object.assign(new EventEmitter(), { id: 9 })
  const calls: unknown[][] = []
  let owned = true
  mock.module('electron', () => ({ ipcMain: { handle: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler) } }))
  mock.module('../src/main/ipc/window', () => ({ windowForEvent: () => ({ webContents: contents }) }))
  mock.module('../src/main/browser/validation', () => ({ assertBrowserSender: (event: { main: boolean; sender: unknown }) => {
    if (!event.main || event.sender !== contents || !owned) throw new Error('Only the owning UI main frame may control Dream')
  } }))
  mock.module('../src/main/features/memory/dream/service', () => ({
    validateDreamRequest: (request: { topic?: string }) => { if (!request || !request.topic) throw new Error('Invalid Dream request') },
    dreamService: {
      status: () => ({ state: 'idle' }),
      start: (...args: unknown[]) => { calls.push(['start', ...args]); return { state: 'running' } },
      stop: async (...args: unknown[]) => { calls.push(['stop', ...args]); return { state: 'cancelled' } },
      cancelOwner: (...args: unknown[]) => { calls.push(['cancel', ...args]) }
    }
  }))
  mock.module('../src/main/features/memory/dream/records', () => ({
    listDreamRecords: (offset?: number) => { calls.push(['list', offset]); return { items: [] } },
    readDreamRecord: (id: string) => { calls.push(['read', id]); return { id } }
  }))
  const { registerDreamIpc } = await import('../src/main/ipc/dream')
  registerDreamIpc()
  const event = { main: true, sender: contents }
  assert.equal(handlers.has('memory:dream:conversations'), false)
  assert.throws(() => handlers.get('memory:dream:start')!({ ...event, main: false }, { topic: 'Permission lessons' }), /main frame/)
  assert.throws(() => handlers.get('memory:dream:start')!(event, { mode: 'invalid' }), /Invalid/)
  handlers.get('memory:dream:start')!(event, { topic: 'Permission lessons' })
  assert.deepEqual(calls[0], ['start', 9, { topic: 'Permission lessons' }])
  contents.emit('did-start-navigation', {}, 'http://host', true, true)
  assert.equal(calls.length, 1, 'same-document changes do not cancel')
  contents.emit('did-start-navigation', {}, 'http://frame', false, false)
  assert.equal(calls.length, 1, 'subframe changes do not cancel')
  contents.emit('did-start-navigation', {}, 'http://host', false, true)
  assert.deepEqual(calls.at(-1), ['cancel', 9])
  contents.emit('render-process-gone')
  assert.deepEqual(calls.at(-1), ['cancel', 9])
  await handlers.get('memory:dream:stop')!(event)
  assert.deepEqual(calls.at(-1), ['stop', 9])
  handlers.get('memory:dream:list')!(event, 30)
  assert.deepEqual(calls.at(-1), ['list', 30])
  handlers.get('memory:dream:read')!(event, 'record-id')
  assert.deepEqual(calls.at(-1), ['read', 'record-id'])
  for (const channel of ['memory:dream:list', 'memory:dream:read']) {
    assert.throws(() => handlers.get(channel)!({ ...event, main: false }), /main frame/)
  }
  owned = false
  assert.throws(() => handlers.get('memory:dream:status')!(event), /owning/)
} else test('Dream IPC rejects foreign/guest senders and cancels only on owning document teardown', async () => {
  const result = await runSelf(import.meta.path, ['--dream-ipc-fixture'])
  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
})
