import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { DisplayTurnsResult, ProjectGroup, SessionControls, SessionMeta } from '../src/shared/api'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const controls = (input = 0): SessionControls => ({
  model: null, models: [], thinkingLevel: 'off', thinkingLevels: ['off'],
  contextUsage: null, tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0, total: input },
  followUpMessages: []
})

const history = (id: string): DisplayTurnsResult => ({
  leafId: id,
  turns: [{ id, answer: [{ type: 'text', text: id }], startedAt: 1, endedAt: 2, hasProcess: true }]
})

const meta: SessionMeta = {
  id: 'session', path: '/project/session.jsonl', cwd: '/project',
  created: '', modified: '', firstMessage: '', messageCount: 1
}

async function runFixture(name: string): Promise<void> {
  let openCalls = 0
  let processCalls = 0
  const api = {
    createSession: async () => ({ sessionId: meta.id, cwd: meta.cwd }),
    openSession: async () => { openCalls++; return { sessionId: meta.id, cwd: meta.cwd } },
    closeSession: async () => {},
    getControls: async () => controls(),
    getDisplayTurns: async () => history('current'),
    getTurnMessages: async (): Promise<unknown[]> => { processCalls++; return [] },
    listChats: async (): Promise<ProjectGroup[]> => [],
    listProjects: async (): Promise<ProjectGroup[]> => [],
    listProject: async (): Promise<ProjectGroup | null> => null,
    isChatCwd: async () => true,
    deleteChat: async () => {},
    viewBranch: async (_id: string, tip: string) => ({ leafId: tip })
  }
  Object.assign(globalThis, { window: { api } })
  const { useSessionsStore: store } = await import('../src/renderer/src/stores/sessions')
  const state = () => store.getState()
  const runtime = () => state().runtime[meta.id]
  await state().newSession(meta.cwd)

  if (name === 'closed') {
    const response = deferred<DisplayTurnsResult>()
    api.getDisplayTurns = () => response.promise
    const pending = state().hydrateTurns(meta.id)
    state().closeTab(meta.id)
    response.resolve(history('stale'))
    assert.equal(await pending, false)
    state().setStreaming(meta.id, true)
    state().setThinkingLevel(meta.id, 'high')
    assert.equal(runtime(), undefined)
    assert.equal(state().openTabs.length, 0)
  } else if (name === 'reopened') {
    const response = deferred<DisplayTurnsResult>()
    const controlResponse = deferred<SessionControls>()
    api.getDisplayTurns = () => response.promise
    api.getControls = () => controlResponse.promise
    const oldInstance = runtime().instanceId
    const pending = state().hydrateTurns(meta.id)
    const pendingControls = state().loadControls(meta.id)
    state().closeTab(meta.id)
    api.getDisplayTurns = async () => history('new')
    api.getControls = async () => controls(42)
    await state().openExisting(meta)
    response.resolve(history('stale'))
    controlResponse.resolve(controls(1))
    await Promise.all([pending, pendingControls])
    assert.notEqual(runtime().instanceId, oldInstance)
    assert.equal(runtime().turns[0].id, 'new')
    assert.equal(runtime().tokens.input, 42)
  } else if (name === 'history-order') {
    const first = deferred<DisplayTurnsResult>()
    const second = deferred<DisplayTurnsResult>()
    api.getDisplayTurns = () => first.promise
    const older = state().hydrateTurns(meta.id)
    api.getDisplayTurns = () => second.promise
    const newer = state().hydrateTurns(meta.id)
    second.resolve(history('new'))
    assert.equal(await newer, true)
    first.resolve(history('old'))
    assert.equal(await older, false)
    assert.equal(runtime().turns[0].id, 'new')
  } else if (name === 'new-stream') {
    const response = deferred<DisplayTurnsResult>()
    api.getDisplayTurns = () => response.promise
    const pending = state().hydrateTurns(meta.id)
    state().beginPrompt(meta.id, { role: 'user', content: 'new question', timestamp: 10 })
    response.resolve(history('before-send'))
    assert.equal(await pending, false)
    assert.equal(runtime().turns.length, 0)
    assert.equal(runtime().liveMessages.length, 1)
    assert.equal(runtime().isStreaming, true)
  } else if (name === 'controls-order') {
    const response = deferred<SessionControls>()
    api.getControls = () => response.promise
    const pending = state().loadControls(meta.id)
    state().applyControls(meta.id, { ...controls(42), thinkingLevel: 'high' })
    response.resolve(controls(1))
    await pending
    assert.equal(runtime().thinkingLevel, 'high')
    assert.equal(runtime().tokens.input, 42)

    const next = deferred<SessionControls>()
    api.getControls = () => next.promise
    const reloading = state().loadControls(meta.id)
    state().setFollowUpMessages(meta.id, ['new queue'])
    next.resolve(controls(100))
    await reloading
    assert.deepEqual(runtime().followUpMessages, ['new queue'])
    assert.equal(runtime().tokens.input, 100)
  } else if (name === 'duplicate-open') {
    state().closeTab(meta.id)
    const response = deferred<{ sessionId: string; cwd: string }>()
    api.openSession = () => { openCalls++; return response.promise }
    const first = state().openExisting(meta)
    const second = state().openExisting(meta)
    await Promise.resolve()
    response.resolve({ sessionId: meta.id, cwd: meta.cwd })
    await Promise.all([first, second])
    assert.equal(openCalls, 1)
    assert.equal(state().openTabs.length, 1)
    assert.equal(state().activeSessionId, meta.id)
  } else if (name === 'close-reopen') {
    const closed = deferred<void>()
    api.closeSession = () => closed.promise
    state().closeTab(meta.id)
    const opening = state().openExisting(meta)
    await Promise.resolve()
    assert.equal(openCalls, 0)
    closed.resolve()
    await opening
    assert.equal(openCalls, 1)
    assert.ok(runtime())
  } else if (name === 'process-dedup') {
    const response = deferred<unknown[]>()
    api.getTurnMessages = () => { processCalls++; return response.promise }
    const first = state().loadTurnProcess(meta.id, 'turn')
    const second = state().loadTurnProcess(meta.id, 'turn')
    assert.equal(processCalls, 1)
    state().closeTab(meta.id)
    response.resolve([])
    await Promise.all([first, second])
    assert.equal(runtime(), undefined)
  } else if (name === 'reopen-during-hydration') {
    state().closeTab(meta.id)
    const initialHistory = deferred<DisplayTurnsResult>()
    api.getDisplayTurns = () => initialHistory.promise
    const added = deferred<void>()
    const off = store.subscribe((current) => {
      if (current.openTabs.length) added.resolve()
    })
    const first = state().openExisting(meta)
    await added.promise
    off()
    const closed = deferred<void>()
    api.closeSession = () => closed.promise
    state().closeTab(meta.id)
    api.getDisplayTurns = async () => history('reopened')
    const second = state().openExisting(meta)
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(state().openTabs.length, 0)
    assert.equal(openCalls, 1)
    closed.resolve()
    await second
    initialHistory.resolve(history('stale'))
    await first
    assert.equal(openCalls, 2)
    assert.equal(runtime().turns[0].id, 'reopened')
  } else if (name === 'message-identity') {
    const result = (id: string) => ({
      role: 'toolResult' as const, toolCallId: id, toolName: 'read',
      content: [{ type: 'text' as const, text: id }], timestamp: 10, isError: false
    })
    state().appendLiveMessage(meta.id, result('first'))
    state().replaceLiveMessage(meta.id, result('second'))
    assert.equal(runtime().liveMessages.length, 2)
    state().replaceLiveMessage(meta.id, { ...result('first'), isError: true })
    assert.equal(runtime().liveMessages.length, 2)
    assert.equal((runtime().liveMessages[0] as ReturnType<typeof result>).isError, true)
    assert.equal((runtime().liveMessages[1] as ReturnType<typeof result>).toolCallId, 'second')
  } else if (name === 'consecutive-prompts') {
    state().appendLiveMessage(meta.id, { role: 'user', content: 'previous', timestamp: 1 })
    state().setStreaming(meta.id, false)
    state().beginPrompt(meta.id, { role: 'user', content: 'optimistic', timestamp: 10 })
    state().appendLiveMessage(meta.id, { role: 'user', content: 'accepted', timestamp: 11 })
    assert.equal(runtime().pendingUserMessage, false)
    assert.deepEqual(runtime().liveMessages.map((message) => message.timestamp), [1, 11])
    state().setStreaming(meta.id, false)
    state().beginPrompt(meta.id, { role: 'user', content: 'failed', timestamp: 20 })
    state().rollbackPrompt(meta.id)
    assert.deepEqual(runtime().liveMessages.map((message) => message.timestamp), [1, 11])
  } else if (name === 'selection-order') {
    const response = deferred<{ sessionId: string; cwd: string }>()
    api.openSession = () => response.promise
    const opening = state().openExisting({ ...meta, id: 'other', path: '/other.jsonl' })
    state().setActive(meta.id)
    response.resolve({ sessionId: 'other', cwd: '/other' })
    await opening
    assert.equal(state().activeSessionId, meta.id)
    assert.equal(state().openTabs.length, 2)
  } else if (name === 'deleted-chat') {
    const chat = { cwd: meta.cwd, name: 'chat', sessions: [meta] }
    store.setState({ chats: [chat] })
    const response = deferred<ProjectGroup[]>()
    const refresh = deferred<ProjectGroup | null>()
    api.listChats = () => response.promise
    api.listProject = () => refresh.promise
    const loading = state().loadChats()
    const refreshing = state().refreshCwd(meta.cwd)
    await Promise.resolve()
    await state().deleteChat(meta.cwd)
    response.resolve([chat])
    refresh.resolve(chat)
    await Promise.all([loading, refreshing])
    assert.deepEqual(state().chats, [])
    assert.equal(runtime(), undefined)
  } else if (name === 'project-load-order') {
    const first = deferred<ProjectGroup[]>()
    const second = deferred<ProjectGroup[]>()
    api.listProjects = () => first.promise
    const older = state().loadProjects()
    api.listProjects = () => second.promise
    const newer = state().loadProjects()
    second.resolve([{ cwd: '/new', name: 'new', sessions: [] }])
    await newer
    first.resolve([{ cwd: '/old', name: 'old', sessions: [] }])
    await older
    assert.equal(state().projects[0].cwd, '/new')
  } else {
    throw new Error(`Unknown fixture: ${name}`)
  }
}

if (process.argv[2] === '--session-store-fixture') {
  await runFixture(process.argv[3])
} else {
  const cases = {
    closed: 'late requests and events do not recreate a closed session',
    reopened: 'old responses cannot overwrite a reopened instance of the same session',
    'history-order': 'only the latest history request can commit',
    'new-stream': 'starting a prompt invalidates an older history snapshot',
    'controls-order': 'stale controls preserve new choices and queue events',
    'duplicate-open': 'concurrent opens share one SDK request and one tab',
    'close-reopen': 'reopening waits for the previous SDK instance to close',
    'reopen-during-hydration': 'closing during initial hydration cannot reuse an already opened SDK reference',
    'process-dedup': 'process requests are shared and cannot recreate a closed session',
    'message-identity': 'tool results with the same timestamp retain separate identities',
    'consecutive-prompts': 'sending before history refresh preserves completed live messages',
    'selection-order': 'a delayed open does not override a later tab selection',
    'deleted-chat': 'late directory scans do not restore a deleted chat',
    'project-load-order': 'a slow project scan cannot replace a newer list'
  }
  for (const [name, description] of Object.entries(cases)) {
    test(`session store: ${description}`, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--session-store-fixture', name], {
        stdout: 'pipe', stderr: 'pipe'
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
      ])
      assert.equal(code, 0, stdout + stderr)
    })
  }
}
