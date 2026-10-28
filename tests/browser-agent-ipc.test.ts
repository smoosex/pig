/** Agent tab requests round-trip through the session's UI window and only accept tabs that window created. */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

async function fixture(): Promise<void> {
  const handlers = new Map<string, (...args: any[]) => any>()
  const agents = new Map<string, string | null>()
  const makeWindow = () => {
    const sent: unknown[][] = []
    return Object.assign(new EventEmitter(), {
      sent,
      webContents: Object.assign(new EventEmitter(), {
        mainFrame: {}, isDestroyed: () => false, send: (...args: unknown[]) => { sent.push(args) }
      }),
      isDestroyed: () => false
    })
  }
  const win = makeWindow()
  const other = makeWindow()
  mock.module('electron', () => ({
    app: { isPackaged: false, getAppPath: () => process.cwd() },
    View: class {},
    session: { fromPartition: () => ({ cookies: {} }) },
    clipboard: { writeText: () => {} },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) },
    BrowserWindow: { fromWebContents: (sender: unknown) => sender === other.webContents ? other : win },
    WebContentsView: class {}
  }))
  mock.module('../src/main/open-project-sessions', () => ({ saveBrowserTabUrl: async () => {} }))
  mock.module('../src/main/browser/host', () => ({
    BrowserHost: class {
      getState(_win: unknown, id: string) { return { browserId: id, url: '', title: '', agentSessionId: agents.get(id) ?? null } }
      agentOf(_win: unknown, id: string) { return agents.get(id) ?? null }
      setAgent(_win: unknown, id: string, sessionId: string | null) { agents.set(id, sessionId) }
      close(_win: unknown, id: string) { agents.delete(id) }
      closeWindow() {}
    }
  }))
  const { registerBrowserIpc } = await import('../src/main/ipc/browser')
  const { browserAgentHost, closeSessionBrowserControl } = await import('../src/main/plugins/pig-browser-host')
  registerBrowserIpc({ sessionWindow: (id) => id === 's1' ? win as never : undefined, isSessionLive: (id) => id === 's1' })
  const agent = browserAgentHost()!
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
  const foreign = { sender: other.webContents, senderFrame: other.webContents.mainFrame }
  const answer = handlers.get('browser:agent-open-answer')!
  const lastRequest = () => win.sent.at(-1)![1] as { requestId: string; sessionId: string }

  const opening = agent.open('s1', {})
  const { requestId, sessionId } = lastRequest()
  assert.equal(sessionId, 's1')
  assert.equal(win.sent.at(-1)![0], 'browser:agent-open-request')
  assert.throws(() => answer(event, 'unknown', { browserId: 'browser:x' }), /Unknown browser open request/)
  assert.throws(() => answer(foreign, requestId, { browserId: 'browser:x' }), /Unknown browser open request/, 'another window cannot answer')
  handlers.get('browser:create')!(foreign, 'browser:foreign')
  assert.throws(() => answer(event, requestId, { browserId: 'browser:foreign' }), /Invalid browser open answer/, 'only tabs of the requesting window')
  await assert.rejects(opening, /Invalid browser open answer/)

  const second = agent.open('s1', {})
  handlers.get('browser:create')!(event, 'browser:agent')
  answer(event, lastRequest().requestId, { browserId: 'browser:agent' })
  assert.match((await second).text, /Tab: browser:agent/)
  assert.equal(agents.get('browser:agent'), 's1')
  assert.throws(() => handlers.get('browser:release-agent')!(foreign, 'browser:agent'), /does not belong/)
  assert.throws(() => handlers.get('browser:release-agent')!(event, 'browser:agent', 'other-session'))
  assert.equal(agents.get('browser:agent'), 's1', 'a stale confirmation must not release a new controller')
  handlers.get('browser:release-agent')!(event, 'browser:agent', 's1')
  assert.equal(agents.get('browser:agent'), null)

  handlers.get('browser:create')!(event, 'browser:second')
  const activating = agent.switchTab('s1', 'browser:second', true)
  await Promise.resolve()
  const activatingRequest = lastRequest() as ReturnType<typeof lastRequest> & { action: string; browserId: string }
  assert.equal(activatingRequest.action, 'activate')
  assert.equal(activatingRequest.browserId, 'browser:second')
  assert.throws(() => answer(event, activatingRequest.requestId, { browserId: 'browser:agent' }), /Invalid browser open answer/, 'activation acknowledgement must match the exact requested tab')
  await assert.rejects(activating, /Invalid browser open answer/)
  const retryActivation = agent.switchTab('s1', 'browser:second', true)
  await Promise.resolve()
  answer(event, lastRequest().requestId, { browserId: 'browser:second' })
  await retryActivation
  const closing = agent.close('s1')
  const closingRequest = lastRequest() as ReturnType<typeof lastRequest> & { action: string; browserId: string }
  assert.equal(closingRequest.action, 'close')
  assert.equal(agents.has('browser:second'), false, 'main ownership retires before the UI round-trip')
  await assert.rejects(agent.open('s1', { browserId: 'browser:second' }), /No browser tab/)
  answer(event, closingRequest.requestId, { browserId: 'browser:second' })
  await closing
  await assert.rejects(agent.close('s1'), /no browser tab/)

  await agent.open('s1', { browserId: 'browser:agent' })
  agents.set('browser:foreign', 'foreign-session')
  closeSessionBrowserControl('s1')
  assert.equal(agents.get('browser:agent'), null, 'session teardown releases control without closing the tab')
  assert.equal(agents.get('browser:foreign'), 'foreign-session', 'other sessions retain control')

  const refused = agent.open('s1', {})
  answer(event, lastRequest().requestId, { error: 'The session is not open in this window' })
  await assert.rejects(refused, /not open in this window/)

  const controller = new AbortController()
  const aborted = agent.open('s1', {}, controller.signal)
  const abortedId = lastRequest().requestId
  controller.abort(new Error('stopped'))
  await assert.rejects(aborted, /stopped/)
  assert.throws(() => answer(event, abortedId, { browserId: 'browser:agent' }), /Unknown browser open request/, 'late answers are refused')

  const interrupted = agent.open('s1', {})
  win.webContents.emit('did-start-navigation', {}, 'https://ui.test/', false, true)
  await assert.rejects(interrupted, /reloaded or closed/)
  await assert.rejects(agent.open('s1', {}), /reloading/)
  await assert.rejects(agent.tabs('subagent'), /not subagents/)
}

if (process.argv.includes('--browser-agent-ipc-fixture')) await fixture()
else test('agent browser tabs are requested from and answered by the session window only', async () => {
  const child = Bun.spawn([process.execPath, import.meta.path, '--browser-agent-ipc-fixture'], { stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => child.kill(), 10_000)
  try {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    assert.equal(code, 0, err || out)
  } finally { clearTimeout(timer) }
})
