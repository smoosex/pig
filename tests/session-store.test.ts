import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { DisplayTurnsResult, OpenSessionRef, ProjectGroup, SessionControls, SessionMeta } from '../src/shared/api'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const controls = (input = 0): SessionControls => ({
  model: null, models: [], thinkingLevel: 'off', thinkingLevels: ['off'],
  contextUsage: null,
  followUpMessages: []
})

const tokenStats = (input: number) => ({ input, output: 1, cacheRead: 2, cacheWrite: 0, total: input + 3 })

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
  let prepareCalls = 0
  let processCalls = 0
  let tokenCalls = 0
  const api = {
    createSession: async () => ({ sessionId: meta.id, cwd: meta.cwd }),
    openSession: async (): Promise<OpenSessionRef> => {
      openCalls++
      return { sessionId: meta.id, cwd: meta.cwd, display: await api.getDisplayTurns() }
    },
    prepareSession: async () => { prepareCalls++; return { sessionId: meta.id, cwd: meta.cwd } },
    closeSession: async () => {},
    getControls: async () => controls(),
    getDisplayTurns: async () => history('current'),
    getTurnMessages: async (): Promise<unknown[]> => { processCalls++; return [] },
    getTurnWindow: async (): Promise<DisplayTurnsResult> => history('older'),
    getTokenStats: async () => { tokenCalls++; return tokenStats(7) },
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

  if (name === 'open-lazy') {
    state().closeTab(meta.id)
    await state().openExisting(meta)
    // Opening renders the persisted projection without paying for the SDK build.
    assert.equal(prepareCalls, 0)
    assert.equal(runtime().turns[0].id, 'current')
  } else if (name === 'open-controls-failure') {
    state().closeTab(meta.id)
    const failure = new Error('controls failed')
    api.getControls = async () => { throw failure }
    await assert.rejects(state().openExisting(meta), (error) => error === failure)
    assert.equal(runtime().turns[0].id, 'current')
  } else if (name === 'closed') {
    const response = deferred<DisplayTurnsResult>()
    api.getDisplayTurns = () => response.promise
    const pending = state().hydrateTurns(meta.id)
    state().setControlsStatus(meta.id, { controlsPending: true, controlsError: 'Model failed' })
    state().closeTab(meta.id)
    response.resolve(history('stale'))
    assert.equal(await pending, false)
    state().setStreaming(meta.id, true)
    state().setThinkingLevel(meta.id, 'high')
    // The toolbar status lives in the runtime, so closing the tab takes it away for good.
    state().setControlsStatus(meta.id, { controlsPending: false, controlsError: null })
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
    assert.equal(runtime().contextUsage, null)
  } else if (name === 'stale-guards-quiet') {
    const window = (leafId: string, startIndex: number, totalTurns: number, id: string): DisplayTurnsResult => ({
      leafId, startIndex, totalTurns,
      turns: [{ id, answer: [{ type: 'text', text: id }], startedAt: 1, endedAt: 2, hasProcess: true }]
    })
    api.getDisplayTurns = async () => window('A', 40, 300, 'A40')
    await state().hydrateTurns(meta.id)
    // A page that belongs to a branch the reader already left must not rebuild the runtime: nothing
    // about the held window changed, so there is nothing for the view to re-render.
    const page = deferred<DisplayTurnsResult>()
    api.getTurnWindow = () => page.promise
    const loading = state().loadOlderTurns(meta.id)
    api.viewBranch = async (_id: string, tip: string) => window(tip, 40, 300, 'B40')
    await state().viewBranch(meta.id, 'branch-b')
    const settled = runtime()
    page.resolve(window('A', 0, 300, 'A0'))
    await loading
    assert.deepEqual(runtime().turns.map((turn) => turn.id), ['B40'],
      'another branch\'s page is not spliced in')
    assert.equal(runtime().turnStart, settled.turnStart, 'the window stays where the reader left it')
    // A window push for a window the reader already moved is not a change either.
    const quiet = runtime()
    state().applySessionWindow({ sessionId: meta.id, leafId: 'branch-b', startIndex: 0, totalTurns: 5 })
    assert.equal(runtime(), quiet, 'a stale window push does not replace the runtime')
    // A token read that belongs to a replaced instance cannot write into the new one.
    const stats = deferred<ReturnType<typeof tokenStats>>()
    api.getTokenStats = () => stats.promise
    const loadingTokens = state().loadTokenStats(meta.id)
    state().closeTab(meta.id)
    await state().openExisting(meta)
    const reopened = runtime()
    stats.resolve(tokenStats(11))
    await loadingTokens
    assert.equal(runtime(), reopened, 'a stale token response does not replace the runtime')
    assert.equal(runtime().tokens, null)
  } else if (name === 'placeholder-not-spliced') {
    const list = (from: number, count: number) => Array.from({ length: count }, (_, offset) => ({
      id: `t${from + offset}`, answer: [{ type: 'text', text: 'x' }], startedAt: 1, endedAt: 2, hasProcess: true
    }))
    // The first paint of a long file: 60 turns of the tail with a provisional offset of 0.
    api.getDisplayTurns = async () => ({ leafId: 'A', startIndex: 0, totalTurns: 100, indexPending: true, turns: list(40, 60) })
    await state().hydrateTurns(meta.id)
    assert.equal(runtime().turnStart, 0)
    assert.equal(runtime().turnPending, true)
    assert.equal(runtime().turnIndexTrusted, false, 'a provisional tail does not carry the branch numbering')
    // The index fails: the window is still the provisional tail, and saying so is not a correction.
    state().applySessionWindow({ sessionId: meta.id, error: 'index died' })
    assert.equal(runtime().turnPending, false)
    assert.equal(runtime().turnIndexTrusted, false, 'a failure does not make the numbering authoritative')
    // A later refresh with confirmed counts must replace the window instead of splicing the tail into it.
    api.getDisplayTurns = async () => ({ leafId: 'A', startIndex: 40, totalTurns: 100, turns: list(40, 60) })
    await state().hydrateTurns(meta.id, { keepOlderTurns: true })
    const ids = runtime().turns.map((turn) => turn.id)
    assert.equal(new Set(ids).size, ids.length, `turns are not duplicated: ${ids.length} ids for ${new Set(ids).size} turns`)
    assert.equal(runtime().turnStart, 40, 'the window takes the authoritative offset')
    assert.equal(runtime().turnIndexTrusted, true)
  } else if (name === 'placeholder-self-heals') {
    const list = (from: number, count: number) => Array.from({ length: count }, (_, offset) => ({
      id: `t${from + offset}`, answer: [{ type: 'text', text: 'x' }], startedAt: 1, endedAt: 2, hasProcess: true
    }))
    api.getDisplayTurns = async () => ({ leafId: 'A', startIndex: 0, totalTurns: 100, indexPending: true, turns: list(40, 60) })
    await state().hydrateTurns(meta.id)
    // A reader who asks for older turns while the window is provisional can only be answered by the
    // authoritative window: there is no page above an offset that is not known.
    let fetches = 0
    api.getDisplayTurns = async () => {
      fetches++
      return { leafId: 'A', startIndex: 40, totalTurns: 100, turns: list(40, 60) }
    }
    await state().loadOlderTurns(meta.id)
    assert.equal(fetches, 1, 'the retry hydrates the window instead of paging the branch')
    assert.equal(runtime().turnStart, 40)
    assert.equal(runtime().turnIndexTrusted, true)
    assert.equal(runtime().turnError, null)
    // A hydrate that fails must leave the view a reason instead of an unhandled rejection.
    api.getDisplayTurns = async () => ({ leafId: 'A', startIndex: 0, totalTurns: 100, indexPending: true, turns: list(40, 60) })
    state().closeTab(meta.id)
    await state().openExisting(meta)
    assert.equal(runtime().turnIndexTrusted, false, 'the reopened session starts provisional again')
    api.getDisplayTurns = async () => { throw new Error('dial failed') }
    await state().loadOlderTurns(meta.id)
    assert.equal(runtime().turnError, 'dial failed')
    assert.equal(runtime().turnLoading, false)
  } else if (name === 'paging-converges') {
    const page = (startIndex: number, id: string): DisplayTurnsResult => ({
      leafId: 'A', startIndex, totalTurns: 700,
      turns: [{ id, answer: [{ type: 'text', text: id }], startedAt: 1, endedAt: 2, hasProcess: true }]
    })
    api.getDisplayTurns = async () => page(600, 'A600')
    await state().hydrateTurns(meta.id)
    const reads: number[] = []
    api.getTurnWindow = async (_id: string, from: number) => { reads.push(from); return page(from, `A${from}`) }
    // Two readers for the same window: the second one joins the page in flight, and the window it
    // waited for is not the one its target needs, so it has to be able to ask for another.
    const first = state().loadOlderTurns(meta.id, 200)
    const second = state().loadOlderTurns(meta.id, 200)
    await Promise.all([first, second])
    assert.deepEqual(reads, [400, 200], `each caller pages once, from the window it holds: ${reads.join(', ')}`)
    assert.equal(runtime().turnStart, 200, 'the second caller reaches its target')
    // A caller whose page did not move the window stops instead of spinning.
    api.getTurnWindow = async () => page(200, 'same')
    await state().loadOlderTurns(meta.id, 0)
    assert.equal(runtime().turnStart, 200)
    // A page for a session that already holds the branch start is never requested.
    api.getTurnWindow = async () => { reads.push(-1); return page(0, 'A0') }
    api.getDisplayTurns = async () => page(0, 'A0')
    await state().hydrateTurns(meta.id)
    await state().loadOlderTurns(meta.id)
    assert.equal(reads.at(-1), 200, 'a window at the branch start asks for nothing')
  } else if (name === 'token-stats') {
    // The whole-file spend is only requested while the usage popover is open.
    assert.equal(runtime().tokens, null)
    assert.equal(tokenCalls, 0)
    const response = deferred<ReturnType<typeof tokenStats>>()
    api.getTokenStats = () => { tokenCalls++; return response.promise }
    const pending = state().loadTokenStats(meta.id)
    await state().loadTokenStats(meta.id)
    assert.equal(tokenCalls, 1, 'a second open while the first is loading does not duplicate the read')
    response.resolve(tokenStats(11))
    await pending
    assert.equal(runtime().tokens?.total, 14)
    assert.equal(runtime().tokensLoading, false)
    state().closeTab(meta.id)
    api.getTokenStats = async () => { tokenCalls++; return tokenStats(3) }
    const closing = state().loadTokenStats(meta.id)
    await closing
    assert.equal(runtime(), undefined, 'a closed session is not written back')
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

    const next = deferred<SessionControls>()
    api.getControls = () => next.promise
    const reloading = state().loadControls(meta.id)
    state().setFollowUpMessages(meta.id, ['new queue'])
    next.resolve(controls(100))
    await reloading
    assert.deepEqual(runtime().followUpMessages, ['new queue'])
  } else if (name === 'duplicate-open') {
    state().closeTab(meta.id)
    const response = deferred<OpenSessionRef>()
    api.openSession = () => { openCalls++; return response.promise }
    const first = state().openExisting(meta)
    const second = state().openExisting(meta)
    await Promise.resolve()
    response.resolve({ sessionId: meta.id, cwd: meta.cwd, display: history('current') })
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
  } else if (name === 'reopen-during-open') {
    state().closeTab(meta.id)
    const controlsResponse = deferred<SessionControls>()
    const started = deferred<void>()
    api.getControls = () => { started.resolve(); return controlsResponse.promise }
    const first = state().openExisting(meta)
    await started.promise
    // The tab is mounted and history is hydrated while controls are still loading.
    assert.equal(state().openTabs.length, 1)
    const closed = deferred<void>()
    api.closeSession = () => closed.promise
    state().closeTab(meta.id)
    api.getDisplayTurns = async () => history('reopened')
    api.getControls = async () => controls()
    const second = state().openExisting(meta)
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(state().openTabs.length, 0)
    assert.equal(openCalls, 1)
    closed.resolve()
    await second
    controlsResponse.resolve(controls())
    await first
    assert.equal(openCalls, 2)
    assert.equal(runtime().turns[0].id, 'reopened')
  } else if (
    name.startsWith('older-turns-') ||
    name === 'refresh-keeps-window' ||
    name === 'load-failures-reported' ||
    name === 'window-update-stale' ||
    name === 'stale-window-failure' ||
    name === 'summary-cleared'
  ) {
    const window = (leafId: string, startIndex: number, totalTurns: number, id: string): DisplayTurnsResult => ({
      leafId,
      startIndex,
      totalTurns,
      turns: [{ id, answer: [{ type: 'text', text: id }], startedAt: 1, endedAt: 2, hasProcess: true }]
    })
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

    if (name === 'older-turns-guard') {
      api.getDisplayTurns = async () => window('A', 40, 200, 'A40')
      await state().hydrateTurns(meta.id)
      assert.equal(runtime().turnStart, 40)
      const page = deferred<DisplayTurnsResult>()
      api.getTurnWindow = () => page.promise
      const loading = state().loadOlderTurns(meta.id)
      // The reader switches branch while the page is on its way, onto one that starts at the same turn.
      api.viewBranch = async (_id: string, tip: string) => window(tip, 40, 300, 'B40')
      await state().viewBranch(meta.id, 'branch-b')
      assert.equal(runtime().turnStart, 40)
      page.resolve(window('A', 0, 200, 'A0'))
      await loading
      assert.deepEqual(runtime().turns.map((turn) => turn.id), ['B40'], 'another branch\'s page is not spliced in')
      assert.equal(runtime().turnLoading, false)
    } else if (name === 'older-turns-shared') {
      api.getDisplayTurns = async () => window('A', 40, 200, 'A40')
      await state().hydrateTurns(meta.id)
      const page = deferred<DisplayTurnsResult>()
      let calls = 0
      api.getTurnWindow = () => { calls++; return page.promise }
      const first = state().loadOlderTurns(meta.id)
      let secondSettled = false
      const second = state().loadOlderTurns(meta.id, 20).then(() => { secondSettled = true })
      await settle()
      assert.equal(calls, 1, 'a page already on its way is shared, not restarted')
      assert.equal(secondSettled, false, 'a second reader waits for that page instead of returning at once')
      page.resolve(window('A', 0, 200, 'A0'))
      await Promise.all([first, second])
      assert.equal(secondSettled, true)
      assert.equal(runtime().turnStart, 0)
    } else if (name === 'older-turns-bound') {
      api.getDisplayTurns = async () => window('A', 1769, 1769, 'newest')
      await state().hydrateTurns(meta.id)
      const requests: number[][] = []
      api.getTurnWindow = async (_id: string, from: number, count: number) => {
        requests.push([from, count])
        return window('A', from, 1769, `A${from}`)
      }
      // A jump into the far past pages: one request never pulls the whole gap.
      await state().loadOlderTurns(meta.id, 0)
      assert.deepEqual(requests, [[1769 - 200, 200]])
      assert.equal(runtime().turnStart, 1569)
    } else if (name === 'refresh-keeps-window') {
      const held = (startIndex: number, count: number): DisplayTurnsResult => ({
        leafId: 'A',
        startIndex,
        totalTurns: 1000,
        turns: Array.from({ length: count }, (_, offset) => ({
          id: `A${startIndex + offset}`,
          answer: [{ type: 'text', text: '' }],
          startedAt: 1,
          endedAt: 2,
          hasProcess: false
        }))
      })
      api.getDisplayTurns = async () => held(900, 100)
      await state().hydrateTurns(meta.id)
      assert.equal(runtime().turnStart, 900)
      // A finished answer refreshes the same branch: the tail moved, the paged-in prefix must stay.
      api.getDisplayTurns = async () => held(940, 60)
      await state().hydrateTurns(meta.id, { keepOlderTurns: true })
      assert.equal(runtime().turnStart, 900, 'the history the reader paged in stays loaded')
      assert.equal(runtime().turns.length, 100, 'the fresh tail is spliced onto the held prefix')
      assert.equal(runtime().turns[40]?.id, 'A940', 'the tail starts exactly where the prefix ends')
      assert.equal(runtime().turns[99]?.id, 'A999')
      // A different branch replaces the window instead of keeping a prefix that may not be its own.
      await state().hydrateTurns(meta.id)
      assert.equal(runtime().turnStart, 940)
      assert.equal(runtime().turns.length, 60)
    } else if (name === 'load-failures-reported') {
      api.getDisplayTurns = async () => ({
        ...window('A', 0, 2, 'tail'),
        indexPending: true
      })
      await state().hydrateTurns(meta.id)
      assert.equal(runtime().turnPending, true)
      state().applySessionWindow({ sessionId: meta.id, error: 'Session file is not valid' })
      assert.equal(runtime().turnPending, false, 'a failed index stops promising older turns')
      assert.equal(runtime().turnError, 'Session file is not valid')

      api.getDisplayTurns = async () => window('A', 1769, 1769, 'newest')
      await state().hydrateTurns(meta.id)
      assert.equal(runtime().turnError, null, 'a fresh window clears the previous failure')
      api.getTurnWindow = async () => { throw new Error('Session not found: s1') }
      await state().loadOlderTurns(meta.id)
      assert.equal(runtime().turnError, 'Session not found: s1', 'a page that cannot be read says so')
      assert.equal(runtime().turnLoading, false)
      api.getTurnWindow = async (_id, from, count) => window('A', from, 1769, `A${from}`)
      await state().loadOlderTurns(meta.id)
      assert.equal(runtime().turnError, null, 'a page that arrives clears it again')

      api.getTokenStats = async () => { throw new Error('Session not found: s1') }
      await state().loadTokenStats(meta.id)
      assert.equal(runtime().tokensError, 'Session not found: s1')
      assert.equal(runtime().tokensLoading, false)
      api.getTokenStats = async () => ({ input: 1, output: 2, cacheRead: 3, cacheWrite: 0, total: 6 })
      await state().loadTokenStats(meta.id)
      assert.equal(runtime().tokensError, null)
      assert.equal(runtime().tokens?.total, 6)
    } else if (name === 'stale-window-failure') {
      api.getDisplayTurns = async () => window('A', 0, 3, 'tail')
      await state().hydrateTurns(meta.id)
      assert.equal(runtime().leafId, 'A')
      // The file moved while the index was building, and the refetch for the new branch fails too.
      api.getDisplayTurns = async () => { throw new Error('session file is gone') }
      state().applySessionWindow({ sessionId: meta.id, leafId: 'B', startIndex: 5, totalTurns: 9, summary: [] })
      await settle()
      assert.equal(runtime().turnPending, false, 'the window stops claiming turns it cannot load')
      assert.match(String(runtime().turnError), /session file is gone/)
      api.getDisplayTurns = async () => window('B', 0, 5, 'fresh')
      await state().hydrateTurns(meta.id)
      assert.equal(runtime().turnError, null, 'a window that arrives clears the failure again')
    } else if (name === 'window-update-stale') {
      api.getDisplayTurns = async () => window('A', 0, 3, 'tail')
      await state().hydrateTurns(meta.id)
      assert.equal(runtime().leafId, 'A')
      let refetches = 0
      api.getDisplayTurns = async () => { refetches++; return window('B', 0, 5, 'fresh') }
      state().applySessionWindow({ sessionId: meta.id, leafId: 'B', startIndex: 0, totalTurns: 5, summary: [] })
      await settle()
      assert.equal(refetches, 1, 'a push for another branch refetches the tail instead of being dropped')
      assert.equal(runtime().leafId, 'B')
      assert.equal(runtime().turns[0]?.id, 'fresh')
      assert.equal(runtime().turnPending, false, 'the provisional window does not stay pending')
    } else {
      api.getDisplayTurns = async () => ({
        ...window('A', 0, 2, 'one'),
        summary: [{ id: 'u0', bytes: 5, hasImages: false }]
      })
      await state().hydrateTurns(meta.id)
      assert.equal(runtime().turnSummary.length, 1)
      await state().hydrateTurns(meta.id, { display: window('A', 0, 2, 'one'), expectedLeafId: 'A' })
      assert.deepEqual(runtime().turnSummary, [], 'a window without weights clears the ones of the branch before it')
    }
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
    const response = deferred<OpenSessionRef>()
    api.openSession = () => response.promise
    const opening = state().openExisting({ ...meta, id: 'other', path: '/other.jsonl' })
    state().setActive(meta.id)
    response.resolve({ sessionId: 'other', cwd: '/other', display: history('other') })
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
    'open-lazy': 'opening renders the persisted projection without preparing',
    'open-controls-failure': 'control loading errors propagate from opening',
    'token-stats': 'usage stats load on demand and never outlive their session',
    'placeholder-not-spliced': 'a provisional tail is replaced, never spliced into, by the index',
    'placeholder-self-heals': 'a provisional window hydrates when asked for older turns',
    'paging-converges': 'a reader that joined a page still reaches its target',
    'stale-guards-quiet': 'responses for a window that moved on do not rebuild the runtime',
    closed: 'late requests and events do not recreate a closed session',
    reopened: 'old responses cannot overwrite a reopened instance of the same session',
    'history-order': 'only the latest history request can commit',
    'new-stream': 'starting a prompt invalidates an older history snapshot',
    'controls-order': 'stale controls preserve new choices and queue events',
    'duplicate-open': 'concurrent opens share one SDK request and one tab',
    'close-reopen': 'reopening waits for the previous SDK instance to close',
    'reopen-during-open': 'closing during opening cannot reuse an already opened SDK reference',
    'process-dedup': 'process requests are shared and cannot recreate a closed session',
    'older-turns-guard': 'a page that arrives after a branch switch cannot splice into it',
    'older-turns-shared': 'two readers share the page that is already on its way',
    'older-turns-bound': 'a jump into the far past pages instead of reading the whole gap',
    'refresh-keeps-window': 'a refresh keeps the history the reader already paged in',
    'load-failures-reported': 'a page, an index or the token stats that fail reach the view',
    'window-update-stale': 'an index update for another branch refetches the window',
    'stale-window-failure': 'a refetch that fails for a moved window reports instead of staying pending',
    'summary-cleared': 'a window without weights clears an older branch summary',
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
