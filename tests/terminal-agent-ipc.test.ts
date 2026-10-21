/** Terminal agent UI round-trips only accept initialized PTYs in the requesting window. */
import { expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { PtyHostRequest } from '../src/shared/terminal'

async function fixture() {
  const handlers = new Map<string, (...args: any[]) => any>()
  type Request = import('../src/shared/terminal-agent').TerminalAgentOpenRequest
  let onRequest: ((request: Request) => void) | undefined
  const makeWindow = () => Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: Object.assign(new EventEmitter(), {
      mainFrame: {}, isDestroyed: () => false,
      send(channel: string, payload: any) { if (channel === 'terminal:agent-open-request') onRequest?.(payload) }
    })
  })
  const win = makeWindow()
  const foreign = makeWindow()
  const live = new Set(['s1', 's2'])
  class Worker extends EventEmitter {
    postMessage(message: PtyHostRequest) {
      if (message.type === 'spawn') queueMicrotask(() => this.emit('message', { type: 'spawned', id: message.id, pid: 123 }))
    }
    kill() { return true }
  }
  mock.module('electron', () => ({
    app: { getVersion: () => 'test' },
    ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) },
    BrowserWindow: { fromWebContents: (sender: unknown) => sender === win.webContents ? win : foreign },
    utilityProcess: { fork: () => new Worker() }
  }))
  const { registerTerminalIpc } = await import('../src/main/ipc/terminal')
  const { terminalAgentHost } = await import('../src/main/plugins/pig-terminal-host')
  registerTerminalIpc({ sessionWindow: id => live.has(id) ? win as never : undefined, isSessionLive: id => live.has(id) })
  const agent = terminalAgentHost()!
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
  const other = { sender: foreign.webContents, senderFrame: foreign.webContents.mainFrame }
  const guest = { sender: win.webContents, senderFrame: {} }
  const answer = handlers.get('terminal:agent-open-answer')!
  const create = handlers.get('terminal:create')!
  const request = async <T>(operation: () => Promise<T>) => {
    const requested = new Promise<Request>(resolve => { onRequest = resolve })
    const pending = operation()
    return { pending, request: await requested }
  }
  const start = (signal?: AbortSignal) => request(() => agent.open('s1', undefined, signal))

  expect(() => create(guest, 'terminal:guest', process.cwd(), 120, 30)).toThrow()
  const first = await start()
  expect(first.request.sessionId).toBe('s1')
  expect(() => answer(other, first.request.requestId, { terminalId: 'terminal:foreign' })).toThrow('Unknown terminal open request')
  await create(other, 'terminal:foreign', process.cwd(), 120, 30)
  expect(() => answer(event, first.request.requestId, { terminalId: 'terminal:foreign' })).toThrow('Invalid terminal open answer')
  await expect(first.pending).rejects.toThrow('Invalid terminal open answer')

  const second = await start()
  await create(event, 'terminal:agent', process.cwd(), 120, 30)
  answer(event, second.request.requestId, { terminalId: 'terminal:agent' })
  expect((await second.pending).text).toContain('Control acquired')
  expect(handlers.get('terminal:get-agent-state')!(event, 'terminal:agent').agentSessionId).toBe('s1')
  expect(() => handlers.get('terminal:release-agent')!(other, 'terminal:agent', 's1')).toThrow('Unknown terminal')
  expect(() => handlers.get('terminal:release-agent')!(event, 'terminal:agent', 's2')).toThrow('control changed')
  handlers.get('terminal:release-agent')!(event, 'terminal:agent', 's1')
  expect(handlers.get('terminal:get-agent-state')!(event, 'terminal:agent').agentSessionId).toBeNull()

  await create(event, 'terminal:other', process.cwd(), 120, 30)
  const mismatched = await request(() => agent.switchTab('s1', 'terminal:other', true))
  expect(mismatched.request.action).toBe('activate')
  expect(() => answer(event, mismatched.request.requestId, { terminalId: 'terminal:agent' })).toThrow('Invalid terminal open answer')
  await expect(mismatched.pending).rejects.toThrow('Invalid terminal open answer')

  const transferred = await request(() => agent.switchTab('s1', 'terminal:other', true))
  await agent.release('s1')
  expect(() => answer(event, transferred.request.requestId, { terminalId: 'terminal:other' })).toThrow('released or transferred')
  await expect(transferred.pending).rejects.toThrow('released or transferred')
  const activated = await request(() => agent.switchTab('s1', 'terminal:other', true))
  answer(event, activated.request.requestId, { terminalId: 'terminal:other' })
  await expect(activated.pending).resolves.toMatchObject({ text: expect.stringContaining('activated') })
  await expect(agent.close('s1')).rejects.toThrow('Only terminals this session created')
  await agent.switchTab('s1', 'terminal:agent', false)
  const closing = await request(() => agent.close('s1'))
  expect(closing.request.action).toBe('close')
  expect(() => handlers.get('terminal:get-agent-state')!(event, 'terminal:agent')).toThrow('Unknown terminal')
  await expect(agent.open('s2', 'terminal:agent')).rejects.toThrow('No initialized terminal')
  live.delete('s1')
  answer(event, closing.request.requestId, { terminalId: 'terminal:agent' })
  await expect(closing.pending).resolves.toMatchObject({ text: expect.stringContaining('Closed') })
  live.add('s1')
  expect(() => answer(event, closing.request.requestId, { terminalId: 'terminal:agent' })).toThrow('Unknown terminal open request')

  const abort = new AbortController()
  const cancelled = await start(abort.signal)
  abort.abort(new Error('stopped'))
  await expect(cancelled.pending).rejects.toThrow('stopped')
  expect(() => answer(event, cancelled.request.requestId, { terminalId: 'terminal:agent' })).toThrow('Unknown terminal open request')

  const closingSession = await start()
  live.delete('s1')
  expect(() => answer(event, closingSession.request.requestId, { terminalId: 'terminal:agent' })).toThrow('no longer open')
  await expect(closingSession.pending).rejects.toThrow('no longer open')
  live.add('s1')
  const reload = await start()
  win.webContents.emit('did-start-navigation', {}, 'https://ui.test', false, true)
  await expect(reload.pending).rejects.toThrow('reloaded or closed')
  await expect(agent.open('s1')).rejects.toThrow('reloading')
  expect(() => create(event, 'terminal:late', process.cwd(), 120, 30)).toThrow('reloading')
  win.webContents.emit('dom-ready')
  await create(event, 'terminal:after', process.cwd(), 120, 30)
  await expect(agent.tabs('subagent')).rejects.toThrow('not subagents')
}

if (process.argv.includes('--terminal-agent-ipc-fixture')) await fixture()
else test('terminal agent IPC scopes ownership, confirmations, cancellation and reload to the window', async () => {
  const child = Bun.spawn([process.execPath, import.meta.path, '--terminal-agent-ipc-fixture'], { stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => child.kill(), 15_000)
  try {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code, err || out).toBe(0)
  } finally { clearTimeout(timer) }
}, 20_000)
