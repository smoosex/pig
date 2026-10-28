/** Terminal agent UI round-trips only accept initialized PTYs in the requesting window. */
import { expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PtyHostRequest } from '../src/shared/terminal'

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pig-terminal-approval-'))
  process.env.PIG_DIR = root
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
  const writes: string[] = []
  const snapshot = { text: '', cols: 120, rows: 30, cursorX: 0, cursorY: 0, alternateScreen: false, bracketedPaste: false, applicationCursor: false, version: 0, truncated: false }
  const asks: Array<{ choices: string[]; message: string }> = []
  const workers: Worker[] = []
  let holdSnapshot: ((worker: Worker, message: Extract<PtyHostRequest, { type: 'snapshot' }>) => void) | undefined
  let answerIndex = 0
  let waitForApproval: ((choices: string[], signal?: AbortSignal) => Promise<string | undefined>) | undefined
  mock.module('../src/main/extension-ui', () => ({
    createExtensionUI: async () => ({ select: async (_title: string, choices: string[], opts: { approval: { message: string }; signal?: AbortSignal }) => {
      asks.push({ choices, message: opts.approval.message })
      return waitForApproval ? waitForApproval(choices, opts.signal) : choices[answerIndex]
    } })
  }))
  class Worker extends EventEmitter {
    postMessage(message: PtyHostRequest) {
      if (message.type === 'spawn') queueMicrotask(() => this.emit('message', { type: 'spawned', id: message.id, pid: 123 }))
      if (message.type === 'snapshot') {
        if (holdSnapshot) holdSnapshot(this, message)
        else queueMicrotask(() => this.emit('message', { type: 'snapshot-result', id: message.id, requestId: message.requestId, snapshot }))
      }
      if (message.type === 'write') writes.push(message.data)
    }
    kill() { return true }
  }
  const replySnapshot = (worker: Worker, request: Extract<PtyHostRequest, { type: 'snapshot' }>) =>
    worker.emit('message', { type: 'snapshot-result', id: request.id, requestId: request.requestId, snapshot })
  mock.module('electron', () => ({
    app: { getVersion: () => 'test' },
    ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) },
    BrowserWindow: { fromWebContents: (sender: unknown) => sender === win.webContents ? win : foreign },
    utilityProcess: { fork: () => { const worker = new Worker(); workers.push(worker); return worker } }
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
  const { saveSessionPermission } = await import('../src/main/permissions/store')
  const { applyLocaleSetting } = await import('../src/main/i18n')
  applyLocaleSetting('en')
  await saveSessionPermission('s1', 'read-only')
  await expect(agent.type('s1', 'cannot run', true)).rejects.toThrow('Read-only mode')
  expect(asks).toHaveLength(0)
  expect(writes).toEqual([])
  await saveSessionPermission('s1', 'default')
  let entered!: () => void
  const asking = new Promise<void>(resolve => { entered = resolve })
  waitForApproval = async (_choices, signal) => new Promise(resolve => {
    entered()
    signal!.addEventListener('abort', () => resolve(undefined), { once: true })
  })
  const pendingInput = agent.press('s1', 'Enter')
  await asking
  await saveSessionPermission('s1', 'read-only')
  await expect(pendingInput).rejects.toThrow('Permission mode changed')
  expect(writes).toEqual([])
  waitForApproval = undefined
  await saveSessionPermission('s1', 'default')
  answerIndex = 2
  await expect(agent.press('s1', 'Enter')).rejects.toThrow('did not allow')
  expect(writes).toEqual([])
  answerIndex = 0
  let snapshotReady!: (value: { worker: Worker; message: Extract<PtyHostRequest, { type: 'snapshot' }> }) => void
  const delayedSnapshot = new Promise<{ worker: Worker; message: Extract<PtyHostRequest, { type: 'snapshot' }> }>(resolve => { snapshotReady = resolve })
  holdSnapshot = (worker, message) => snapshotReady({ worker, message })
  const staleInput = agent.type('s1', 'must not run', true).then(() => null, (error: Error) => error)
  const { worker: snapshotWorker, message: snapshotRequest } = await delayedSnapshot
  await saveSessionPermission('s1', 'read-only')
  await saveSessionPermission('s1', 'default')
  expect((await staleInput)?.message).toContain('Permission mode changed')
  holdSnapshot = undefined
  replySnapshot(snapshotWorker, snapshotRequest)
  expect(writes).toEqual([])

  const corruptSnapshot = new Promise<{ worker: Worker; message: Extract<PtyHostRequest, { type: 'snapshot' }> }>(resolve => { snapshotReady = resolve })
  holdSnapshot = (worker, message) => snapshotReady({ worker, message })
  const corruptInput = agent.type('s1', 'also must not run', true).then(() => null, (error: Error) => error)
  const { worker: corruptWorker, message: corruptRequest } = await corruptSnapshot
  writeFileSync(join(root, 'session-permissions', 's1.json'), '{')
  holdSnapshot = undefined
  replySnapshot(corruptWorker, corruptRequest)
  expect(await corruptInput).toBeInstanceOf(SyntaxError)
  expect(writes).toEqual([])
  await saveSessionPermission('s1', 'default')
  await agent.type('s1', 'echo one', true)
  expect(asks.at(-1)?.message).toContain('echo one')
  expect(asks.at(-1)?.message).toContain('current session until it closes')
  expect(asks.at(-1)?.choices).toEqual(['Allow once', 'Allow this terminal (this session)', 'Deny'])
  expect(writes).toEqual(['echo one\r'])
  const longInput = `${'x'.repeat(2100)}last-part\u202e`
  await agent.type('s1', longInput, false)
  expect(asks.at(-1)?.message).toContain('last-part\\u202e')
  expect(writes.at(-1)).toBe(longInput)
  applyLocaleSetting('zh-CN')
  answerIndex = 1
  await agent.press('s1', 'Enter')
  expect(asks.at(-1)?.choices).toEqual(['本次允许', '允许此终端（本会话）', '拒绝'])
  expect(asks.at(-1)?.message).toContain('当前会话可继续向此终端发送输入，会话关闭后失效')
  applyLocaleSetting('en')
  const afterGrant = asks.length
  await agent.type('s1', 'echo again', false)
  expect(asks).toHaveLength(afterGrant)
  const grantedSnapshot = new Promise<{ worker: Worker; message: Extract<PtyHostRequest, { type: 'snapshot' }> }>(resolve => { snapshotReady = resolve })
  holdSnapshot = (worker, message) => snapshotReady({ worker, message })
  const grantedInput = agent.press('s1', 'Enter').then(() => null, (error: Error) => error)
  const { worker: grantedWorker, message: grantedRequest } = await grantedSnapshot
  const writtenBeforeChange = writes.length
  await saveSessionPermission('s1', 'read-only')
  await saveSessionPermission('s1', 'default')
  expect((await grantedInput)?.message).toContain('Permission mode changed')
  holdSnapshot = undefined
  replySnapshot(grantedWorker, grantedRequest)
  expect(writes).toHaveLength(writtenBeforeChange)
  expect(asks).toHaveLength(afterGrant)
  await saveSessionPermission('s1', 'read-only')
  await expect(agent.press('s1', 'Enter')).rejects.toThrow('Read-only mode')
  await saveSessionPermission('s1', 'full-access')
  await agent.press('s1', 'Enter')
  expect(asks).toHaveLength(afterGrant)
  await saveSessionPermission('s1', 'default')
  expect(() => handlers.get('terminal:release-agent')!(other, 'terminal:agent', 's1')).toThrow('Unknown terminal')
  expect(() => handlers.get('terminal:release-agent')!(event, 'terminal:agent', 's2')).toThrow('control changed')
  handlers.get('terminal:release-agent')!(event, 'terminal:agent', 's1')
  expect(handlers.get('terminal:get-agent-state')!(event, 'terminal:agent').agentSessionId).toBeNull()
  await agent.switchTab('s2', 'terminal:agent', false)
  answerIndex = 2
  await expect(agent.press('s2', 'Enter')).rejects.toThrow('did not allow')
  expect(asks).toHaveLength(afterGrant + 1)
  await agent.release('s2')

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
  answerIndex = 2
  await expect(agent.press('s1', 'Enter')).rejects.toThrow('did not allow')
  expect(asks).toHaveLength(afterGrant + 2)
  expect(asks.at(-1)?.message).toContain('terminal:other')
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

  await agent.open('s1', 'terminal:after')
  let startedCrashApproval!: () => void
  const crashApproval = new Promise<void>(resolve => { startedCrashApproval = resolve })
  waitForApproval = async (_choices, signal) => new Promise(resolve => {
    startedCrashApproval()
    signal!.addEventListener('abort', () => resolve(undefined), { once: true })
  })
  const crashInput = agent.type('s1', 'never run', true).then(() => null, (error: Error) => error)
  await crashApproval
  const writtenBeforeCrash = writes.length
  workers.at(-1)!.emit('exit', 42)
  expect((await crashInput)?.message).toContain('Terminal host exited with code 42')
  expect(handlers.get('terminal:get-agent-state')!(event, 'terminal:after').agentSessionId).toBeNull()
  expect(writes).toHaveLength(writtenBeforeCrash)
  waitForApproval = undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const restarted = await Promise.race([
    start(),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Terminal queue stayed blocked after host exit')), 1000) })
  ]).finally(() => clearTimeout(timer))
  await create(event, 'terminal:recovered', process.cwd(), 120, 30)
  answer(event, restarted.request.requestId, { terminalId: 'terminal:recovered' })
  await expect(restarted.pending).resolves.toMatchObject({ text: expect.stringContaining('Control acquired') })
  expect(workers).toHaveLength(2)
  rmSync(root, { recursive: true, force: true })
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
