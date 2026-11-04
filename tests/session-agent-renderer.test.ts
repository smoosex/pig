/** Run the real store and UI request bridge in a separate module registry. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { SessionApi, SessionControls } from '../src/shared/api'
import type { SessionAgentUiAnswer, SessionAgentUiRequest } from '../src/shared/session-agent'
import { runSelf } from './helpers/subprocess.ts'

if (process.argv.includes('--session-agent-preload-fixture')) {
  const { mock } = await import('bun:test')
  const invokes: unknown[][] = []
  const handlers = new Map<string, (event: unknown, request: SessionAgentUiRequest) => void>()
  let exposed!: SessionApi
  mock.module('electron', () => ({
    contextBridge: { exposeInMainWorld: (_key: string, api: SessionApi) => { exposed = api } },
    ipcRenderer: {
      invoke: async (...args: unknown[]) => { invokes.push(args) },
      on: (channel: string, handler: (event: unknown, request: SessionAgentUiRequest) => void) => { handlers.set(channel, handler) },
      off: (channel: string, handler: unknown) => {
        assert.equal(handlers.get(channel), handler)
        handlers.delete(channel)
      }
    }
  }))
  Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true })
  await import('../src/preload/index')
  const request: SessionAgentUiRequest = { action: 'refresh', requestId: 'request', callerSessionId: 'caller', sessionId: 'target' }
  let received: SessionAgentUiRequest | undefined
  const unsubscribe = exposed.sessionAgent.onRequest((value) => { received = value })
  handlers.get('session:agent-request')!({}, request)
  assert.equal(received, request)
  await exposed.sessionAgent.answer('request', { ok: true })
  await exposed.sessionAgent.answer('failed', { error: 'cancelled' })
  assert.deepEqual(invokes, [
    ['session:agent-answer', 'request', { ok: true }],
    ['session:agent-answer', 'failed', { error: 'cancelled' }]
  ])
  unsubscribe()
  assert.ok(!handlers.has('session:agent-request'))
} else if (process.argv.includes('--session-agent-renderer-fixture')) {
  const answers: SessionAgentUiAnswer[] = []
  const reads: string[] = []
  const closed: string[] = []
  let rejectAnswer = false
  let controlsRead: () => Promise<SessionControls> = async () => ({
    model: null, thinkingLevel: 'high', thinkingLevels: ['high'], contextUsage: null,
    followUpMessages: [], steeringMessages: []
  })
  Object.assign(globalThis, { window: { api: {
    sessionAgent: {
      answer: async (_id: string, answer: SessionAgentUiAnswer) => {
        answers.push(answer)
        if (rejectAnswer) throw new Error('request cancelled')
      }
    },
    getControls: async (id: string) => { reads.push(id); return controlsRead() },
    closeSession: async (id: string) => { closed.push(id) },
    browser: { close: async () => {} }
  } } })
  const { useSessionsStore: store } = await import('../src/renderer/src/stores/sessions')
  const { emptyRuntime } = await import('../src/renderer/src/stores/sessions/runtime')
  const { answerSessionAgentRequest: answer } = await import('../src/renderer/src/hooks/useSessionAgentRequests')
  store.setState({
    openTabs: [{ id: 'caller', cwd: '/caller', kind: 'project', title: 'Caller', loadState: 'ready' }],
    runtime: { caller: emptyRuntime(), draft: emptyRuntime() },
    activeTabId: 'caller', currentProjectCwd: '/caller',
    activeSessionByCwd: { '/caller': 'caller' }, activeTabByCwd: { '/caller': 'caller' },
    draftSessionByCwd: { '/target': 'draft' }
  })
  const project = { cwd: '/target', name: 'Target', sessions: [] }
  const create = (id: string): SessionAgentUiRequest => ({
    action: 'create', requestId: id, callerSessionId: 'caller', project,
    session: { sessionId: id, cwd: '/target', title: `Title ${id}` }
  })
  await answer({ action: 'project', requestId: 'project', callerSessionId: 'caller', project })
  await answer({ action: 'project', requestId: 'project-again', callerSessionId: 'caller', project: { ...project, name: 'Renamed' } })
  assert.equal(store.getState().projects.length, 1)
  assert.equal(store.getState().projects[0]?.name, 'Renamed')
  assert.equal(store.getState().activeTabId, 'caller')

  const originalRead = controlsRead
  let finish!: (value: SessionControls) => void
  controlsRead = () => new Promise((resolve) => { finish = resolve })
  const before = answers.length
  const pending = answer(create('exact-main-id'))
  assert.equal(store.getState().openTabs.at(-1)?.id, 'exact-main-id')
  assert.equal(store.getState().openTabs.at(-1)?.title, 'Title exact-main-id')
  assert.ok(store.getState().runtime['exact-main-id'])
  assert.equal(answers.length, before, 'ack waits for controls')
  finish(await originalRead())
  await pending
  assert.deepEqual(answers.at(-1), { ok: true })
  assert.equal(store.getState().runtime['exact-main-id']?.thinkingLevel, 'high')
  assert.equal(store.getState().activeTabId, 'caller')
  assert.equal(store.getState().currentProjectCwd, '/caller')
  assert.deepEqual(store.getState().activeSessionByCwd, { '/caller': 'caller' })
  assert.deepEqual(store.getState().activeTabByCwd, { '/caller': 'caller' })
  assert.deepEqual(store.getState().draftSessionByCwd, { '/target': 'draft' })
  controlsRead = originalRead

  await answer({ action: 'refresh', requestId: 'refresh', callerSessionId: 'caller', sessionId: 'exact-main-id' })
  assert.equal(reads.at(-1), 'exact-main-id')
  await answer({ action: 'refresh', requestId: 'missing', callerSessionId: 'caller', sessionId: 'absent' })
  assert.ok('error' in answers.at(-1)!)
  await answer({ ...create('wrong-window'), callerSessionId: 'absent' })
  assert.ok(!store.getState().openTabs.some((tab) => tab.id === 'wrong-window'))
  await answer(create('draft'))
  assert.ok('error' in answers.at(-1)!)
  assert.ok(store.getState().runtime.draft, 'draft survives ID collision')
  await assert.rejects(store.getState().attachAgentSession({ sessionId: 'chat', cwd: '' }, 'Chat'), /Chat/)

  rejectAnswer = true
  await assert.rejects(answer(create('late')), /cancelled/)
  assert.ok(!store.getState().openTabs.some((tab) => tab.id === 'late'))
  assert.ok(!store.getState().runtime.late)
  assert.ok(closed.includes('late'))
  await assert.rejects(answer(create('exact-main-id')), /cancelled/)
  assert.ok(store.getState().openTabs.some((tab) => tab.id === 'exact-main-id'), 'existing tab survives rejected answer')
  assert.ok(!closed.includes('exact-main-id'))
  rejectAnswer = false

  controlsRead = async () => { throw new Error('controls failed') }
  await answer(create('failed'))
  assert.deepEqual(answers.at(-1), { error: 'controls failed' })
  assert.ok(!store.getState().runtime.failed)
  assert.ok(closed.includes('failed'))
  await answer(create('exact-main-id'))
  assert.ok(store.getState().runtime['exact-main-id'], 'existing tab survives controls failure')

  controlsRead = () => new Promise((resolve) => { finish = resolve })
  const callerClosed = answer(create('caller-closed'))
  store.setState((state) => ({ openTabs: state.openTabs.filter((tab) => tab.id !== 'caller') }))
  finish(await originalRead())
  await callerClosed
  assert.ok('error' in answers.at(-1)!)
  assert.ok(!store.getState().runtime['caller-closed'])
  store.setState((state) => ({ openTabs: [...state.openTabs, { id: 'caller', cwd: '/caller', kind: 'project', title: 'Caller', loadState: 'ready' }] }))

  const replaced = answer(create('reopened'))
  const newRuntime = emptyRuntime()
  store.setState((state) => ({ runtime: { ...state.runtime, reopened: newRuntime } }))
  finish(await originalRead())
  await replaced
  assert.ok('error' in answers.at(-1)!)
  assert.equal(store.getState().runtime.reopened, newRuntime, 'cleanup must not close a replacement runtime')
  assert.ok(!closed.includes('reopened'))

  const removal: SessionAgentUiRequest = { action: 'remove-project', requestId: 'remove-project', callerSessionId: 'caller', cwd: '/target', cwds: ['/target', '/branch'], phase: 'check' }
  const beforeRemoval = store.getState().openTabs.length
  await answer(removal)
  assert.deepEqual(answers.at(-1), { ok: true })
  assert.equal(store.getState().openTabs.length, beforeRemoval, 'preflight does not remove anything')
  for (const kind of ['file', 'browser', 'terminal'] as const) {
    store.setState(state => ({ openTabs: [...state.openTabs, { id: 'protected-tab', cwd: '/branch', kind, title: 'Protected', loadState: 'ready' }] }))
    await answer(removal)
    assert.ok('error' in answers.at(-1)!)
    await answer({ ...removal, phase: 'apply' })
    assert.ok('error' in answers.at(-1)!)
    assert.ok(store.getState().projects.some(item => item.cwd === '/target'))
    store.setState(state => ({ openTabs: state.openTabs.filter(tab => tab.id !== 'protected-tab') }))
  }
  await answer({ ...removal, phase: 'apply' })
  assert.deepEqual(answers.at(-1), { ok: true })
  assert.ok(!store.getState().projects.some(item => item.cwd === '/target'))
  assert.ok(!store.getState().openTabs.some(tab => ['/target', '/branch'].includes(tab.cwd)))
  assert.ok(store.getState().openTabs.some(tab => tab.id === 'caller'))
  assert.equal(store.getState().activeTabId, 'caller')
} else {
  test('session agent preload forwards literal channels and removes its request listener', async () => {
    const { exitCode, stdout, stderr } = await runSelf(import.meta.path, ['--session-agent-preload-fixture'])
    assert.equal(exitCode, 0, stdout + stderr)
  })
  test('session agent attaches exact background tabs, refreshes controls and only reclaims its own orphans', async () => {
    const { exitCode, stdout, stderr } = await runSelf(import.meta.path, ['--session-agent-renderer-fixture'])
    assert.equal(exitCode, 0, stdout + stderr)
  })
}
