import { expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { SessionAgentUiTransport } from '../src/main/pi/session-agent'
import { runSelf } from './helpers/subprocess'

async function fixture() {
  const handlers = new Map<string, (...args: any[]) => unknown>()
  const owners = new Map<string, { win: any }>()
  let transport: SessionAgentUiTransport | undefined
  const window = () => {
    const wc = Object.assign(new EventEmitter(), { isDestroyed: () => false, mainFrame: {}, sent: [] as any[], send(_channel: string, payload: unknown) { this.sent.push(payload) } })
    return Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: wc })
  }
  const win = window()
  const foreign = window()
  const event = (owner = win, frame = owner.webContents.mainFrame) => ({ win: owner, sender: owner.webContents, senderFrame: frame })
  mock.module('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: any[]) => unknown) => handlers.set(name, fn) } }))
  mock.module('../src/main/pi/session-registry', () => ({ getLive: (id: string) => owners.get(id) }))
  mock.module('../src/main/pi/session-agent', () => ({ registerSessionController: (ui: SessionAgentUiTransport) => { transport = ui } }))
  mock.module('../src/main/ipc/window', () => ({ windowForEvent: (event: { win: unknown }) => event.win }))
  const { registerSessionAgentIpc } = await import('../src/main/ipc/session-agent')
  registerSessionAgentIpc()
  const ui = transport!
  const answer = handlers.get('session:agent-answer')!
  owners.set('caller', { win })
  const action = { action: 'refresh' as const, sessionId: 'target' }
  const first = ui.request('caller', action)
  const request = win.webContents.sent.at(-1)
  expect(request.sessionId).toBe('target')
  expect(() => answer(event(foreign), request.requestId, { ok: true })).toThrow('another window')
  expect(() => answer(event(win, {}), request.requestId, { ok: true })).toThrow('main frame')
  answer(event(), request.requestId, { ok: true })
  await first
  expect(() => answer(event(), request.requestId, { ok: true })).toThrow('expired')

  const replaced = ui.request('caller', action).catch(error => error as Error)
  const replacedId = win.webContents.sent.at(-1).requestId
  owners.set('caller', { win })
  expect(() => answer(event(), replacedId, { ok: true })).toThrow('replaced')
  expect(String(await replaced)).toContain('replaced')

  const reload = ui.request('caller', action).catch(error => error as Error)
  win.webContents.emit('did-start-navigation', {}, 'file://ui', false, true)
  expect(String(await reload)).toContain('reloaded')
  await expect(ui.request('caller', action)).rejects.toThrow('reloading')
  win.webContents.emit('dom-ready')
  const signal = new AbortController()
  const aborted = ui.request('caller', action, signal.signal).catch(error => error as Error)
  const abortedId = win.webContents.sent.at(-1).requestId
  signal.abort()
  expect(String(await aborted)).toContain('cancelled')
  expect(() => answer(event(), abortedId, { ok: true })).toThrow('expired')
  ui.remove(win as any, 'orphan')
  expect(win.webContents.sent.at(-1).action).toBe('remove')
}

if (process.argv.includes('--ipc-fixture')) await fixture()
else test('session UI answers are main-frame/window/instance bound and cancelled on reload or abort', async () => {
  const result = await runSelf(import.meta.path, ['--ipc-fixture'], { timeoutMs: 15000 })
  expect(result.exitCode, result.stderr).toBe(0)
})
