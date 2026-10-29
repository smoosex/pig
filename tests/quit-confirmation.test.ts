import { afterEach, beforeEach, expect, jest, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import type { QuitConfirmRequest } from '../src/shared/quit'

class FakeContents extends EventEmitter {
  sent: QuitConfirmRequest[] = []
  loading = false
  destroyed = false
  isDestroyed() { return this.destroyed }
  isLoading() { return this.loading }
  send(_channel: string, request: QuitConfirmRequest) { this.sent.push(request) }
}

class FakeWindow extends EventEmitter {
  webContents = new FakeContents()
  destroyed = false
  isDestroyed() { return this.destroyed }
  isMinimized() { return false }
  restore() {}
  show() {}
  focus() {}
  close() {
    this.destroyed = true
    this.emit('closed')
  }
}

const handlers = new Map<string, (event: { win: FakeWindow }, ...args: unknown[]) => unknown>()
let allWindows: FakeWindow[] = []
let nativeAnswers: number[] = []
let running = 1

mock.module('electron', () => ({
  BrowserWindow: { getAllWindows: () => allWindows, getFocusedWindow: () => null },
  dialog: { showMessageBox: async () => ({ response: nativeAnswers.shift() ?? 1 }) },
  ipcMain: { handle: (channel: string, handler: (event: { win: FakeWindow }, ...args: unknown[]) => unknown) => handlers.set(channel, handler) }
}))
const modules: Record<string, Record<string, unknown>> = {
  'i18n': { t: (key: string) => key },
  'pi/session-registry': { runningSessionCount: () => running },
  'subagents/service': { manager: { runningBackgroundCount: () => 0 } },
  'processes/index': { runningProcessCount: () => 0 },
  'ipc/window': { windowForEvent: (event: { win: FakeWindow }) => event.win },
  'browser/validation': { assertBrowserSender: () => {} }
}
for (const [path, exports] of Object.entries(modules)) {
  mock.module(fileURLToPath(new URL(`../src/main/${path}.ts`, import.meta.url)), () => exports)
}
const quit = await import('../src/main/quit-confirmation')
quit.registerQuitConfirmIpc()

const invoke = (channel: string, win: FakeWindow, ...args: unknown[]) => handlers.get(channel)!({ win }, ...args)
const flush = () => new Promise((resolve) => setImmediate(resolve))

function listeningWindow(): FakeWindow {
  const win = new FakeWindow()
  allWindows.push(win)
  invoke('quit:listen', win)
  return win
}

function lastAsk(win: FakeWindow) {
  const request = win.webContents.sent.at(-1)
  if (request?.type !== 'ask') throw new Error('Expected an ask request')
  return request
}

beforeEach(() => {
  allWindows = []
  nativeAnswers = []
  running = 1
})
// The tracker is module state: a window left registered would answer the next test's prompt.
afterEach(() => {
  jest.useRealTimers()
  for (const win of allWindows) if (!win.destroyed) win.close()
})

test('closing the window after the prompt was shown cancels the quit', async () => {
  const win = listeningWindow()
  const answer = quit.confirmQuit(() => {})
  await flush()
  invoke('quit:ack', win, lastAsk(win).requestId)
  win.close()
  expect(await answer).toBe(false)
  expect(quit.needsQuitConfirmation()).toBe(true)
})

test('a renderer that never acknowledges is withdrawn and the native box asks instead', async () => {
  jest.useFakeTimers()
  const win = listeningWindow()
  nativeAnswers = [1]
  const answer = quit.confirmQuit(() => {})
  await flush()
  const { requestId } = lastAsk(win)
  jest.advanceTimersByTime(3_000)
  expect(await answer).toBe(false)
  expect(win.webContents.sent.at(-1)).toEqual({ type: 'dismiss', requestId })
})

test('a crashed renderer does not stall the quit waiting for a window', async () => {
  const win = listeningWindow()
  win.webContents.emit('render-process-gone')
  nativeAnswers = [1]
  let opened = false
  expect(await quit.confirmQuit(() => { opened = true })).toBe(false)
  expect(opened).toBe(false)
})

test('concurrent requests share one prompt and a confirmation stays settled', async () => {
  const win = listeningWindow()
  const first = quit.confirmQuit(() => {})
  const second = quit.confirmQuit(() => {})
  await flush()
  expect(win.webContents.sent.filter((request) => request.type === 'ask')).toHaveLength(1)
  const { requestId } = lastAsk(win)
  invoke('quit:ack', win, requestId)
  invoke('quit:reply', win, requestId, true)
  expect(await first).toBe(true)
  expect(await second).toBe(true)
  expect(quit.needsQuitConfirmation()).toBe(false)
})
