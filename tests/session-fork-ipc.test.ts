import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import type { ForkedSessionRef, SessionApi, SessionControls } from '../src/shared/api'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

async function fixture(): Promise<void> {
  const handlers = new Map<string, (...args: any[]) => any>()
  let persistence = deferred<void>()
  let enteredPersistence = deferred<void>()
  const remembered: string[] = []
  let forked: ForkedSessionRef = {
    sessionId: 'forked', cwd: '/project',
    display: { leafId: null, turns: [], startIndex: 0, totalTurns: 0 },
    restoredPrompt: { text: 'original prompt', images: [] }
  }
  const noop = () => {}
  const controls: SessionControls = {
    model: null, thinkingLevel: 'off', thinkingLevels: ['off'],
    contextUsage: null, followUpMessages: [], steeringMessages: []
  }
  mock.module('electron', () => ({
    ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) },
    dialog: {},
    nativeTheme: { shouldUseDarkColors: false }
  }))
  mock.module('../src/main/i18n', () => ({ t: (key: string) => key }))
  mock.module('../src/main/pi/session-registry', () => ({
    activateSession: noop, closeSession: noop, createPendingSession: noop, discardDraftSession: noop,
    getSessionCapabilities: noop, setSessionCapability: noop,
    exportSession: noop, getSessionControls: noop, getSessionTokenStats: noop, getSessionTrees: noop,
    listSessionCommands: noop, openSession: noop, prepareSession: noop, promoteDraftSession: noop,
    renameSession: noop, setSessionLabel: noop, setSessionModel: noop,
    setSessionThinking: noop, setSessionModelThinkingPreference: noop, isNavigatingSessionBranch: noop, abortSessionBranchSummary: noop, updateFollowUpMessage: noop, viewSessionBranch: noop,
    forkSessionFromMessage: async () => forked
  }))
  mock.module('../src/main/pi/session-display', () => ({ getDisplayTurns: noop, getTurnMessages: noop, getTurnWindow: noop }))
  mock.module('../src/main/pi/session-removal', () => ({ removeSession: noop }))
  mock.module('../src/main/pi/session-prompt', () => ({ promptSession: noop }))
  mock.module('../src/main/chats', () => ({ isChatCwd: () => false, isChatsRoot: () => false }))
  mock.module('../src/main/ipc/window', () => ({ windowForEvent: noop }))
  mock.module('../src/main/open-project-sessions', () => ({
    forgetOpenProjectSession: noop,
    rememberOpenProjectSession: async (cwd: string, id: string) => {
      assert.equal(cwd, forked.cwd)
      assert.equal(id, forked.sessionId)
      enteredPersistence.resolve()
      await persistence.promise
      remembered.push(id)
    }
  }))
  const { registerSessionIpc } = await import('../src/main/ipc/session')
  registerSessionIpc()
  const handler = handlers.get('session:fork')!
  const api = {
    forkSession: async (id: string, entry: string, position: string) => handler({}, id, entry, position),
    getControls: async () => controls,
    isChatCwd: async () => false,
    listProject: async () => null,
    selectOpenProjectWorkspace: async () => {}
  } as unknown as SessionApi
  Object.assign(globalThis, { window: { api } })
  const { useSessionsStore: store } = await import('../src/renderer/src/stores/sessions')
  const { emptyRuntime } = await import('../src/renderer/src/stores/sessions/runtime')
  const { useComposerDraftsStore: drafts } = await import('../src/renderer/src/stores/composer-drafts')
  store.setState({
    activeTabId: 'source', currentProjectCwd: '/project',
    runtime: { source: emptyRuntime(), other: emptyRuntime() },
    openTabs: ['source', 'other'].map((id) => ({ id, title: id, cwd: '/project', kind: 'project', loadState: 'ready' }))
  })

  const creating = store.getState().forkSession('source', 'user', 'before')
  await enteredPersistence.promise
  assert.equal(store.getState().runtime.forked, undefined, 'the IPC cannot return success before persistence')
  await store.getState().activateTab('other')
  persistence.resolve()
  await creating
  assert.deepEqual(remembered, ['forked'], 'main persists membership even when renderer skips selection persistence')
  assert.equal(store.getState().activeTabId, 'other')
  assert.ok(store.getState().openTabs.some((tab) => tab.id === 'forked'))

  forked = { ...forked, sessionId: 'failed-fork' }
  persistence = deferred<void>()
  enteredPersistence = deferred<void>()
  await store.getState().activateTab('source')
  const failing = store.getState().forkSession('source', 'user', 'before')
  await enteredPersistence.promise
  await store.getState().activateTab('other')
  const error = Object.assign(new Error('Cannot write open project sessions'), { code: 'EACCES' })
  const rejection = assert.rejects(failing, (candidate: unknown) => candidate === error)
  persistence.reject(error)
  await rejection
  assert.equal(store.getState().activeTabId, 'other')
  assert.deepEqual(remembered, ['forked'])
  assert.equal(store.getState().runtime['failed-fork'], undefined)
  assert.equal(drafts.getState().drafts['failed-fork'], undefined)
  assert.ok(!store.getState().openTabs.some((tab) => tab.id === 'failed-fork'))
}

if (process.argv[2] === '--fork-ipc-fixture') {
  await fixture()
} else {
  test('fork IPC awaits tab persistence and propagates failure after selection changes', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--fork-ipc-fixture'], { stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
    ])
    assert.equal(code, 0, stderr || stdout)
  })
}
