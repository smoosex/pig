import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { OpenTab } from '../src/renderer/src/stores/sessions/types'
import { persistableIds, sameScopeTabs, neighbourTab } from '../src/renderer/src/stores/sessions/tab-order'
import { halfSwitch, visibleTabsFor } from '../src/renderer/src/components/tab-strip'

const tab = (id: string, kind: OpenTab['kind'], cwd = '/project'): OpenTab => ({
  id, kind, cwd, title: id, loadState: 'ready'
})

if (!process.argv.includes('--browser-tabs-fixture')) test('browser tabs share their strip scope without becoming persisted sessions', () => {
  const project = tab('project', 'project')
  const browser = tab('browser:project', 'browser')
  const chat = tab('chat', 'chat', '/chats/chat')
  const chatBrowser = tab('browser:chat', 'browser', '')
  const other = tab('browser:other', 'browser', '/other')
  const terminal = tab('terminal:project', 'terminal')
  const chatTerminal = tab('terminal:chat', 'terminal', '')
  assert.deepEqual(persistableIds([project, terminal, chatTerminal]), ['project'])
  assert.deepEqual(sameScopeTabs([project, terminal, chat, chatTerminal], chatTerminal), [chat, chatTerminal])
  const tabs = [project, browser, chat, chatBrowser, other]
  assert.deepEqual(persistableIds(tabs), ['project', 'chat'])
  assert.deepEqual(sameScopeTabs(tabs, browser), [project, browser])
  assert.deepEqual(sameScopeTabs(tabs, chatBrowser), [chat, chatBrowser])
  assert.deepEqual(visibleTabsFor(tabs, 'chats', '/project'), [chat, chatBrowser])
  assert.deepEqual(visibleTabsFor(tabs, 'projects', '/project'), [project, browser])
  assert.equal(neighbourTab(tabs, chatBrowser)?.id, chat.id)
  assert.equal(neighbourTab(tabs, project)?.id, browser.id)
  assert.deepEqual(halfSwitch(tabs, 'projects', chatBrowser.id, null, chatBrowser.id, '/project', new Set()), { kind: 'project', cwd: '/project' })
  assert.deepEqual(halfSwitch(tabs, 'chats', browser.id, '/project', chatBrowser.id, '/project', new Set()), { kind: 'chat', tabId: chatBrowser.id })
  assert.deepEqual(halfSwitch(tabs, 'chats', chatBrowser.id, null, null, null, new Set()), { kind: 'none' })
})

async function fixture() {
  const browserCreates: string[] = []
  const browserCloses: string[] = []
  const writes: unknown[] = []
  const piCalls: string[] = []
  const answers: unknown[][] = []
  let create: (id: string) => Promise<unknown> = async () => ({})
  const api = new Proxy({
    browser: {
      create: async (id: string) => { browserCreates.push(id); return create(id) },
      close: async (id: string) => { browserCloses.push(id) },
      answerAgentOpen: async (...args: unknown[]) => { answers.push(args) }
    },
    saveOpenProjectTabOrder: async (...args: unknown[]) => { writes.push(args) },
    saveOpenProjectChangesTab: async (...args: unknown[]) => { writes.push(args) },
    selectOpenProjectWorkspace: async (...args: unknown[]) => { writes.push(args) },
    saveOpenChatTabs: async (...args: unknown[]) => { writes.push(args) },
    listWorktreeSessions: async () => []
  }, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key)
      return async () => { piCalls.push(String(key)); throw new Error(`Unexpected Pi call: ${String(key)}`) }
    }
  })
  Object.assign(globalThis, { window: { api } })
  const { useSessionsStore: store, selectActiveSessionId } = await import('../src/renderer/src/stores/sessions')
  const { useSplitLayoutStore: split } = await import('../src/renderer/src/stores/split-layout')
  store.setState({ workspaceRestoreReady: true })
  const state = () => store.getState()
  await state().openBrowserTab('/project')
  const first = state().openTabs[0]
  assert.equal(first.kind, 'browser')
  assert.match(first.id, /^browser:/)
  assert.equal(state().activeTabId, first.id)
  assert.equal(selectActiveSessionId(state()), null)
  assert.deepEqual(state().runtime, {})
  await state().openBrowserTab('/project')
  const second = state().openTabs[1]
  assert.notEqual(first.id, second.id)
  store.setState({ openTabs: state().openTabs.map((item) => ({ ...item, loadState: 'cold' })) })
  await state().activateTab(first.id)
  assert.equal(state().activeTabId, first.id)
  assert.deepEqual(state().runtime, {})
  state().reorderTabs([second.id, first.id])
  await state().selectProjectCwd('/other')
  await state().selectProjectCwd('/project')
  assert.equal(state().activeTabId, first.id)
  assert.equal(state().openTabs.length, 2)
  assert.ok(!JSON.stringify(writes).includes('browser:'))

  const paneId = split.getState().initLayout(first.id)
  split.getState().splitPane(paneId, second.id, 'right')
  state().closeTab(first.id)
  assert.equal(state().activeTabId, second.id)
  assert.deepEqual(browserCloses, [first.id])
  state().closeTab(second.id)
  assert.equal(state().openTabs.length, 0)

  let resolve!: (value: unknown) => void
  create = () => new Promise((done) => { resolve = done })
  const pending = state().openBrowserTab('/project')
  await state().openChangesTab('/other')
  const selected = state().activeTabId
  resolve({})
  await pending
  assert.equal(state().activeTabId, selected)
  assert.equal(state().openTabs.filter((item) => item.kind === 'browser').length, 1)
  create = async () => { throw new Error('creation failed') }
  await assert.rejects(state().openBrowserTab('/project'), /creation failed/)
  assert.equal(state().openTabs.filter((item) => item.kind === 'browser').length, 1)

  create = async () => ({})
  const session = tab('real', 'project')
  const dropped = state().openTabs.find((tab) => tab.kind === 'browser')!.id
  store.setState({ openTabs: [session], activeTabId: session.id, activeSessionByCwd: { '/project': session.id } })
  assert.ok(browserCloses.includes(dropped), 'project/catalog removal also disposes browser resources')
  await state().openBrowserTab('/project')
  assert.equal(state().openTabs.at(-1)?.browserTargetSessionId, session.id)
  const { answerBrowserAgentOpen } = await import('../src/renderer/src/hooks/useBrowserAgentRequests')
  const beforeAgent = { active: state().activeTabId, cwd: state().currentProjectCwd }
  await answerBrowserAgentOpen({ requestId: 'r1', sessionId: session.id })
  const agentTab = state().openTabs.at(-1)!
  assert.deepEqual(answers.at(-1), ['r1', { browserId: agentTab.id }])
  assert.equal(agentTab.kind, 'browser')
  assert.equal(agentTab.cwd, '/project', 'agent tabs open in the session worktree')
  assert.equal(agentTab.browserTargetSessionId, session.id)
  assert.deepEqual({ active: state().activeTabId, cwd: state().currentProjectCwd }, beforeAgent, 'agent tabs open in the background')
  await answerBrowserAgentOpen({ requestId: 'activate', sessionId: session.id, action: 'activate', browserId: agentTab.id })
  assert.equal(state().activeTabId, agentTab.id, 'only an explicit activation changes the visible tab')
  assert.deepEqual(answers.at(-1), ['activate', { browserId: agentTab.id }])
  await answerBrowserAgentOpen({ requestId: 'missing', sessionId: session.id, action: 'activate', browserId: 'browser:missing' })
  assert.deepEqual(answers.at(-1), ['missing', { error: 'The browser tab is no longer open' }])
  await answerBrowserAgentOpen({ requestId: 'close', sessionId: 'closed-session', action: 'close', browserId: agentTab.id })
  assert.equal(state().openTabs.some(tab => tab.id === agentTab.id), false, 'authorized cleanup still removes the browser if its requesting session closed')
  assert.ok(browserCloses.includes(agentTab.id))
  assert.deepEqual(answers.at(-1), ['close', { browserId: agentTab.id }])
  await answerBrowserAgentOpen({ requestId: 'closed-again', sessionId: session.id, action: 'close', browserId: agentTab.id })
  assert.deepEqual(answers.at(-1), ['closed-again', { browserId: agentTab.id }], 'late UI cleanup is idempotent')
  await answerBrowserAgentOpen({ requestId: 'r2', sessionId: 'closed-session' })
  assert.deepEqual(answers.at(-1), ['r2', { error: 'The session is not open in this window' }])
  create = async () => { throw new Error('view refused') }
  await answerBrowserAgentOpen({ requestId: 'r3', sessionId: session.id })
  assert.deepEqual(answers.at(-1), ['r3', { error: 'view refused' }])
  create = async () => ({})
  await state().openBrowserTab()
  const chatBrowser = state().openTabs.at(-1)!
  assert.equal(chatBrowser.cwd, '')
  assert.equal(state().currentProjectCwd, null)
  state().reorderTabs([chatBrowser.id])
  state().closeTab(chatBrowser.id)
  assert.equal(state().currentProjectCwd, null)
  assert.deepEqual(piCalls, [])
  assert.deepEqual(state().runtime, {})
  assert.ok(!JSON.stringify(writes).includes('browser:'))
  assert.equal(new Set(browserCreates).size, browserCreates.length)

  const terminal = state().openTerminalTab('/project')
  assert.match(terminal, /^terminal:/)
  assert.equal(state().activeTabId, terminal)
  assert.equal(state().currentProjectCwd, '/project')
  assert.equal(selectActiveSessionId(state()), null, 'a terminal owns no Pi session')
  state().closeTab(terminal)
  assert.equal(state().openTabs.some((item) => item.id === terminal), false)
  const homeTerminal = state().openTerminalTab(null)
  assert.equal(state().openTabs.find((item) => item.id === homeTerminal)?.cwd, '', 'outside a project the terminal starts at home')
  assert.equal(state().currentProjectCwd, null)
  state().closeTab(homeTerminal)
  assert.deepEqual(piCalls, [])
  assert.ok(!JSON.stringify(writes).includes('terminal:'), 'terminal tabs are never persisted')
}

if (process.argv.includes('--browser-tabs-fixture')) {
  await fixture()
} else {
  test('browser lifecycle creates independent views, never Pi sessions, and supports split and stale selection', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--browser-tabs-fixture'], { stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
    ])
    assert.equal(code, 0, stdout + stderr)
  })
}
