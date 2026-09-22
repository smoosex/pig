import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type {
  DisplayTurn,
  DisplayTurnsResult,
  OpenProjectSessionsState,
  OpenSessionRef,
  ProjectGroup,
  ProjectWorktreeDiscovery,
  SessionApi,
  SessionControls,
  SessionMeta
} from '../src/shared/api'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const controls = (_input = 0): SessionControls => ({
  model: null, models: [], thinkingLevel: 'off', thinkingLevels: ['off'],
  contextUsage: null,
  followUpMessages: []
})

const tokenStats = (input: number) => ({ input, output: 1, cacheRead: 2, cacheWrite: 0, total: input + 3 })

const history = (id: string): DisplayTurnsResult => ({
  leafId: id,
  startIndex: 0,
  totalTurns: 1,
  turns: [{ id, answer: [{ type: 'text', text: id }], startedAt: 1, endedAt: 2, hasProcess: true }]
})

const meta: SessionMeta = {
  id: 'session', path: '/project/session.jsonl', cwd: '/project',
  created: '', modified: '', firstMessage: '', size: 1
}

async function runFixture(name: string): Promise<void> {
  let openCalls = 0
  let prepareCalls = 0
  let processCalls = 0
  let tokenCalls = 0
  let promoteCalls = 0
  let discardCalls = 0
  const renameCalls: Array<{ sessionId: string; name: string; path?: string }> = []
  const createdIds: string[] = []
  let persistedOpenProjectSessions: OpenProjectSessionsState = { currentCwd: null, workspaces: [] }
  const api: SessionApi = {
    // Main answers with the session it made. This mock keeps one fixed id for every fixture and only
    // records the id the renderer hands over, which the draft cases below assert on.
    createSession: async (_cwd: string, sessionId?: string) => {
      createdIds.push(sessionId ?? meta.id)
      return { sessionId: meta.id, cwd: meta.cwd }
    },
    promoteSession: async () => { promoteCalls++ },
    discardDraftSession: async () => { discardCalls++ },
    openSession: async (): Promise<OpenSessionRef> => {
      openCalls++
      return { sessionId: meta.id, cwd: meta.cwd, display: await api.getDisplayTurns(meta.id) }
    },
    prepareSession: async () => { prepareCalls++; return { sessionId: meta.id, cwd: meta.cwd } },
    closeSession: async () => {},
    getControls: async () => controls(),
    getDisplayTurns: async () => history('current'),
    getTurnMessages: async (): Promise<unknown[]> => { processCalls++; return [] },
    getTurnWindow: async (): Promise<DisplayTurnsResult> => history('older'),
    getTokenStats: async () => { tokenCalls++; return tokenStats(7) },
    getOpenProjectSessions: async () => persistedOpenProjectSessions,
    selectOpenProjectWorkspace: async (
      cwd: string,
      sessionId: string | null,
      activeTabId: string | null
    ) => {
      persistedOpenProjectSessions.currentCwd = cwd
      const workspace = persistedOpenProjectSessions.workspaces.find((item) => item.cwd === cwd)
      if (workspace) {
        workspace.activeSessionId = sessionId
        workspace.activeTabId = activeTabId ?? sessionId
      }
    },
    // Main writes the strip's selection here too, which is how a changes tab is recorded at all.
    saveOpenProjectChangesTab: async (cwd: string, open: boolean, activeTabId: string | null) => {
      const workspace = persistedOpenProjectSessions.workspaces.find((item) => item.cwd === cwd)
      if (workspace) {
        workspace.changesOpen = open
        workspace.activeTabId = activeTabId
      }
    },
    listChats: async (): Promise<ProjectGroup[]> => [],
    listProjects: async (): Promise<ProjectGroup[]> => [],
    discoverOpenedWorktrees: async (): Promise<ProjectWorktreeDiscovery[]> => [],
    listWorktreeSessions: async (): Promise<SessionMeta[]> => [],
    listProject: async (): Promise<ProjectGroup | null> => null,
    isChatCwd: async () => true,
    deleteChat: async () => {},
    renameSession: async (sessionId: string, name: string, path?: string) => {
      renameCalls.push({ sessionId, name, path })
    },
    viewBranch: async (_id: string, tip: string) => ({ leafId: tip })
  } as unknown as SessionApi
  Object.assign(globalThis, { window: { api } })
  const { useSessionsStore: store, selectActiveSessionId } = await import('../src/renderer/src/stores/sessions')
  const state = () => store.getState()
  const runtime = () => state().runtime[meta.id]

  if (name === 'workspace-restore-lazy') {
    const first = { ...meta, id: 'first', path: '/project/first.jsonl', firstMessage: '' }
    const second = { ...meta, id: 'second', path: '/project/second.jsonl', firstMessage: 'Second' }
    const other = { ...meta, id: 'other', path: '/other/other.jsonl', cwd: '/other', firstMessage: 'Other' }
    const projectCatalog: ProjectGroup[] = [{
      cwd: '/project',
      name: 'project',
      sessions: [first, second, other],
      worktrees: [
        { cwd: '/project', branch: 'main', isPrimary: true, locked: false, missing: false, managed: false, sessions: [first, second] },
        { cwd: '/other', branch: 'other', isPrimary: false, locked: false, missing: false, managed: true, sessions: [other] }
      ]
    }]
    const firstProjectScan = deferred<ProjectGroup[]>()
    const competingProjectScan = deferred<ProjectGroup[]>()
    let projectScans = 0
    api.listProjects = () => ++projectScans === 1
      ? firstProjectScan.promise
      : competingProjectScan.promise
    persistedOpenProjectSessions = {
      currentCwd: '/project',
      workspaces: [
        { cwd: '/project', sessionIds: ['first', 'missing', 'second'], activeSessionId: 'second', changesOpen: false, activeTabId: 'second' },
        { cwd: '/other', sessionIds: ['other'], activeSessionId: 'other', changesOpen: false, activeTabId: 'other' },
        { cwd: '/temporarily-unavailable', sessionIds: ['unavailable'], activeSessionId: 'unavailable', changesOpen: false, activeTabId: 'unavailable' }
      ]
    }
    api.openSession = async (path: string) => {
      openCalls++
      const selected = [first, second, other].find((item) => item.path === path)!
      return { sessionId: selected.id, cwd: selected.cwd, display: history(selected.id) }
    }

    const initialization = state().initializeProjectWorkspaces()
    const competingLoad = state().loadProjects()
    firstProjectScan.resolve(projectCatalog)
    await Promise.resolve()
    competingProjectScan.resolve(projectCatalog)
    await Promise.all([initialization, competingLoad])
    assert.equal(projectScans, 2, 'the fixture reproduces competing startup scans')
    assert.equal(openCalls, 1, 'only the selected workspace active tab is opened')
    assert.deepEqual(
      persistedOpenProjectSessions.workspaces.map((workspace) => [workspace.cwd, workspace.sessionIds]),
      [
        ['/project', ['first', 'missing', 'second']],
        ['/other', ['other']],
        ['/temporarily-unavailable', ['unavailable']]
      ],
      'startup must not erase entries missing from one scan'
    )
    assert.equal(state().currentProjectCwd, '/project')
    assert.equal(state().activeTabId, 'second')
    assert.equal(state().openTabs.find((tab) => tab.id === 'first')?.loadState, 'cold')
    assert.equal(state().openTabs.find((tab) => tab.id === 'first')?.title, '新对话')
    assert.ok(state().runtime.second)
    assert.equal(state().runtime.first, undefined)
    assert.equal(state().runtime.other, undefined)

    await state().selectProjectCwd('/other')
    assert.equal(openCalls, 2)
    assert.equal(state().currentProjectCwd, '/other')
    assert.equal(state().activeTabId, 'other')
    assert.ok(state().runtime.other)
    return
  }

  if (name === 'workspace-restore-retry') {
    const first = { ...meta, id: 'first', path: '/project/first.jsonl', firstMessage: 'First' }
    const catalog: ProjectGroup[] = [{
      cwd: '/project',
      name: 'project',
      sessions: [first],
      worktrees: [{
        cwd: '/project', branch: 'main', isPrimary: true, locked: false, missing: false,
        managed: false, sessions: [first]
      }]
    }]
    let scans = 0
    api.listProjects = async () => {
      if (++scans === 1) throw new Error('scan failed')
      return catalog
    }
    api.getOpenProjectSessions = async () => ({
      currentCwd: '/project',
      workspaces: [{ cwd: '/project', sessionIds: ['first'], activeSessionId: 'first', changesOpen: false, activeTabId: 'first' }]
    })
    api.openSession = async () => ({ sessionId: 'first', cwd: '/project', display: history('first') })

    await state().initializeProjectWorkspaces()
    assert.equal(state().workspaceRestoreReady, false, 'a failed restore stays retryable')
    assert.equal(state().workspaceRestoreError, 'scan failed')
    assert.equal(state().openTabs.length, 0)

    await state().initializeProjectWorkspaces()
    assert.equal(scans, 2, 'the retry scans again')
    assert.equal(state().workspaceRestoreReady, true)
    assert.equal(state().workspaceRestoreError, null)
    assert.equal(state().currentProjectCwd, '/project')
    assert.equal(state().activeTabId, 'first')
    assert.equal(state().openTabs[0]?.loadState, 'ready')
    return
  }

  if (name === 'rename-session') {
    const chat: SessionMeta = { ...meta, id: 'chat', cwd: '/chat', path: '/chat/chat.jsonl', firstMessage: 'Chat first' }
    const project: SessionMeta = { ...meta, id: 'project-session', firstMessage: 'Another message' }
    api.listChats = async () => [{ cwd: '/chat', name: 'chat', sessions: [chat] }]
    api.listProjects = async () => [{ cwd: '/project', name: 'project', sessions: [project] }]
    api.openSession = async () => ({ sessionId: project.id, cwd: project.cwd, display: history(project.id) })
    await Promise.all([state().loadChats(), state().loadProjects()])
    await state().openExisting(project)

    await state().renameSession(project.id, '  重命名  ', project.path)
    assert.deepEqual(renameCalls, [{ sessionId: project.id, name: '重命名', path: project.path }])
    assert.equal(state().openTabs[0]?.title, '重命名')
    assert.equal(state().openTabs[0]?.meta?.name, '重命名')
    assert.equal(state().projects[0]?.sessions[0]?.name, '重命名')

    // An empty name clears the override: the first message owns the title again.
    await state().renameSession(project.id, '')
    assert.equal(state().openTabs[0]?.title, 'Another message')
    assert.equal(state().projects[0]?.sessions[0]?.name, undefined)

    // A chat row names the same session whether or not it is open in the strip.
    await state().renameSession(chat.id, '聊天名字', chat.path)
    assert.equal(state().chats[0]?.sessions[0]?.name, '聊天名字')
    return
  }

  if (name === 'late-session-names') {
    const chat: SessionMeta = { ...meta, id: 'chat', cwd: '/chat', path: '/chat/chat.jsonl', firstMessage: 'Chat first' }
    const project: SessionMeta = { ...meta, id: 'project-session', firstMessage: 'Another message' }
    api.listChats = async () => [{ cwd: '/chat', name: 'chat', sessions: [chat] }]
    api.listProjects = async () => [{ cwd: '/project', name: 'project', sessions: [project] }]
    api.openSession = async () => ({ sessionId: project.id, cwd: project.cwd, display: history(project.id) })
    await Promise.all([state().loadChats(), state().loadProjects()])
    await state().openExisting(project)
    assert.equal(state().openTabs[0]?.title, 'Another message', 'the first message stands in until the name arrives')

    // A background scan names a session long after its listing showed the first message instead.
    state().applySessionNames([
      { sessionId: project.id, path: project.path, name: '深处的名字' },
      { sessionId: chat.id, path: chat.path, name: '聊天的名字' },
      { sessionId: 'not-listed', path: '/project/gone.jsonl', name: '无人认领' }
    ])
    assert.equal(state().openTabs[0]?.title, '深处的名字')
    assert.equal(state().openTabs[0]?.meta?.name, '深处的名字')
    assert.equal(state().projects[0]?.sessions[0]?.name, '深处的名字')
    assert.equal(state().chats[0]?.sessions[0]?.name, '聊天的名字')
    state().applySessionNames([])
    assert.equal(state().openTabs[0]?.title, '深处的名字')
    return
  }

  if (name === 'worktree-topology-sync') {
    const primary = { ...meta, id: 'primary' }
    const removed = { ...meta, id: 'removed', cwd: '/old' }
    api.listProjects = async () => [{
      cwd: '/project', name: 'project', hasGit: false, sessions: [primary, removed],
      worktrees: [
        { cwd: '/project', branch: 'main', isPrimary: true, locked: false, missing: false, managed: false, sessions: [primary] },
        { cwd: '/old', branch: 'old', isPrimary: false, locked: false, missing: false, managed: false, sessions: [removed] }
      ]
    }]
    await state().loadProjects()
    let scans = 0
    api.listProject = async () => { scans++; return null }
    const response = deferred<ProjectWorktreeDiscovery[]>()
    let discoveries = 0
    api.discoverOpenedWorktrees = () => { discoveries++; return response.promise }
    const first = state().syncProjectWorktrees()
    const second = state().syncProjectWorktrees()
    assert.equal(discoveries, 1, 'focuses joining one discovery do not start another IPC')
    response.resolve([{
      cwd: '/project',
      hasGit: true,
      worktrees: [
        { cwd: '/project', branch: 'trunk', isPrimary: true, locked: false, missing: false, managed: false },
        { cwd: '/new', branch: 'new', isPrimary: false, locked: false, missing: false, managed: false }
      ]
    }])
    await Promise.all([first, second])
    const project = state().projects[0]
    assert.equal(scans, 0, 'topology discovery never asks for session JSONL')
    assert.equal(project?.hasGit, true)
    assert.deepEqual(project?.worktrees?.map((worktree) => [
      worktree.cwd,
      worktree.branch,
      worktree.sessions.map((session) => session.id)
    ]), [
      ['/project', 'trunk', ['primary']],
      ['/new', 'new', []]
    ])
    assert.deepEqual(project?.sessions.map((session) => session.id), ['primary'])
    assert.equal(project?.worktrees?.[1]?.sessionsLoaded, false)

    const discovered = { ...meta, id: 'discovered', cwd: '/new' }
    let worktreeScans = 0
    api.listWorktreeSessions = async (projectCwd, cwd) => {
      worktreeScans++
      assert.equal(projectCwd, '/project')
      assert.equal(cwd, '/new')
      return [discovered]
    }
    await state().selectProjectCwd('/new')
    assert.equal(worktreeScans, 1, 'entering a new worktree scans only that cwd once')
    assert.deepEqual(
      state().projects[0]?.worktrees?.find((worktree) => worktree.cwd === '/new')?.sessions,
      [discovered]
    )
    assert.deepEqual(state().projects[0]?.sessions.map((session) => session.id), ['primary', 'discovered'])
    const loadedWorktrees = state().projects[0]?.worktrees

    api.discoverOpenedWorktrees = async () => [{
      cwd: '/project', hasGit: false, worktrees: null, gitError: 'git failed'
    }]
    await state().syncProjectWorktrees()
    assert.equal(state().projects[0]?.hasGit, false)
    assert.equal(state().projects[0]?.gitError, 'git failed')
    assert.deepEqual(state().projects[0]?.worktrees, loadedWorktrees, 'a failed discovery keeps the last topology')
    return
  }

  // A worktree the reader has not visited yet has no memory of its own: the restore has to seed it from
  // what each workspace persisted, or the first switch to it lands on nothing.
  if (name === 'worktree-restore-tabs') {
    const catalog: ProjectGroup[] = [{
      cwd: '/project',
      name: 'project',
      sessions: [],
      worktrees: [
        { cwd: '/project', branch: 'main', isPrimary: true, locked: false, missing: false, managed: false, sessions: [] },
        { cwd: '/other', branch: 'other', isPrimary: false, locked: false, missing: false, managed: true, sessions: [] }
      ]
    }]
    api.listProjects = async () => catalog
    persistedOpenProjectSessions = {
      currentCwd: '/project',
      workspaces: [
        { cwd: '/project', sessionIds: [], activeSessionId: null, changesOpen: true, activeTabId: 'diff:/project' },
        { cwd: '/other', sessionIds: [], activeSessionId: null, changesOpen: true, activeTabId: 'diff:/other' }
      ]
    }

    await state().initializeProjectWorkspaces()
    assert.equal(state().activeTabId, 'diff:/project', 'the restored worktree opens the tab it was left on')
    assert.equal(
      state().activeTabByCwd['/other'],
      'diff:/other',
      'and every other worktree carries its own restored tab'
    )

    await state().selectProjectCwd('/other')
    assert.equal(state().activeTabId, 'diff:/other', 'switching to a worktree never visited lands on its tab')
    return
  }

  // Switching worktrees and coming back has to return to the tab that worktree was left on. A changes tab
  // has no session behind it, so a session id cannot stand in for it: the strip's selection is remembered
  // per worktree, and it is that selection — not the session — that reaches the persisted workspace.
  if (name === 'worktree-tab-remembered') {
    const changesTab = 'diff:/other'
    persistedOpenProjectSessions = {
      currentCwd: '/other',
      workspaces: [{
        cwd: '/other',
        sessionIds: ['other'],
        activeSessionId: 'other',
        changesOpen: true,
        activeTabId: 'other'
      }]
    }
    store.setState({
      projects: [],
      openTabs: [
        { id: 'other', cwd: '/other', title: 'Other', kind: 'project', loadState: 'ready' },
        { id: changesTab, cwd: '/other', title: '全部变更', kind: 'diff', loadState: 'ready' }
      ],
      activeSessionByCwd: { '/other': 'other' },
      activeTabByCwd: {},
      currentProjectCwd: '/other',
      activeTabId: 'other'
    })

    await state().activateTab(changesTab)
    assert.equal(state().activeTabId, changesTab)
    assert.equal(
      persistedOpenProjectSessions.workspaces[0]?.activeTabId,
      changesTab,
      'reading the changes tab is what the workspace records'
    )

    await state().selectProjectCwd('/project')
    await state().selectProjectCwd('/other')
    assert.equal(state().activeTabId, changesTab, 'the worktree comes back to the tab it was left on')
    assert.equal(
      persistedOpenProjectSessions.workspaces[0]?.activeTabId,
      changesTab,
      'and switching back does not overwrite that with the session'
    )
    assert.equal(state().activeSessionByCwd['/other'], 'other', 'the active session is still remembered')

    // Closing it hands the strip back to the session, and the memory follows the strip.
    state().closeTab(changesTab)
    assert.equal(state().activeTabId, 'other')
    assert.equal(state().activeTabByCwd['/other'], 'other')
    return
  }

  if (name === 'project-draft-lifecycle') {
    state().acquireProjectDraft(meta.cwd)
    state().acquireProjectDraft(meta.cwd)
    const draftId = state().draftSessionByCwd[meta.cwd]
    assert.ok(draftId, 'the draft owns a session id before the create resolves')
    assert.equal(draftId, createdIds[0], 'main receives the id the home already uses')
    await Bun.sleep(0)
    assert.equal(state().draftSessionByCwd[meta.cwd], draftId)
    assert.equal(state().activeTabId, null)
    assert.equal(state().openTabs.length, 0)
    assert.equal(state().runtime[draftId]?.controlsRevision, 1)

    state().releaseProjectDraft(meta.cwd)
    assert.equal(state().draftSessionByCwd[meta.cwd], draftId)
    assert.equal(discardCalls, 0)
    state().releaseProjectDraft(meta.cwd)
    await Bun.sleep(0)
    assert.equal(state().draftSessionByCwd[meta.cwd], undefined)
    assert.equal(state().runtime[draftId], undefined)
    assert.equal(discardCalls, 1)

    state().acquireProjectDraft(meta.cwd)
    const nextDraftId = state().draftSessionByCwd[meta.cwd]
    assert.ok(nextDraftId)
    await Bun.sleep(0)
    assert.equal(await state().promoteProjectDraft(meta.cwd, nextDraftId), true)
    assert.equal(promoteCalls, 1)
    assert.equal(state().activeTabId, nextDraftId)
    assert.equal(state().openTabs[0]?.id, nextDraftId)
    assert.equal(state().openTabs[0]?.title, '新对话')
    state().previewSessionTitle(nextDraftId, 'First prompt')
    assert.equal(state().openTabs[0]?.title, 'First prompt')
    assert.ok(state().runtime[nextDraftId])
    state().releaseProjectDraft(meta.cwd)
    assert.equal(discardCalls, 1)
    return
  }

  if (name === 'project-draft-id-first') {
    const gate = deferred<void>()
    api.createSession = async (cwd: string, sessionId?: string) => {
      createdIds.push(sessionId ?? meta.id)
      await gate.promise
      return { sessionId: sessionId ?? meta.id, cwd }
    }
    state().acquireProjectDraft(meta.cwd)
    const draftId = state().draftSessionByCwd[meta.cwd]
    assert.match(draftId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    assert.ok(state().runtime[draftId!], 'the slot runtime exists before the session does')
    state().releaseProjectDraft(meta.cwd)
    state().acquireProjectDraft(meta.cwd)
    assert.equal(state().draftSessionByCwd[meta.cwd], draftId, 're-leasing keeps the same slot')
    gate.resolve()
    await Bun.sleep(0)
    assert.equal(state().draftSessionByCwd[meta.cwd], draftId)
    assert.equal(createdIds.at(-1), draftId)
    assert.equal(discardCalls, 0)
    assert.equal(state().runtime[draftId!]?.controlsRevision, 1)
    return
  }

  if (name === 'project-draft-promoted-while-creating') {
    const gate = deferred<void>()
    api.createSession = async (cwd: string, sessionId?: string) => {
      createdIds.push(sessionId ?? meta.id)
      await gate.promise
      return { sessionId: sessionId ?? meta.id, cwd }
    }
    state().acquireProjectDraft(meta.cwd)
    const draftId = state().draftSessionByCwd[meta.cwd]!
    // The promote waits for the session to exist rather than racing the create.
    const promoting = state().promoteProjectDraft(meta.cwd, draftId)
    await Bun.sleep(0)
    assert.equal(state().draftSessionByCwd[meta.cwd], draftId, 'the slot stays until main answers')
    assert.equal(state().openTabs.length, 0)
    gate.resolve()
    assert.equal(await promoting, true)
    assert.equal(state().activeTabId, draftId)
    assert.equal(state().openTabs[0]?.id, draftId)
    state().releaseProjectDraft(meta.cwd)
    await Bun.sleep(0)
    assert.equal(discardCalls, 0, 'a promote during the round trip must not discard the session')
    assert.ok(state().runtime[draftId], 'the promoted tab keeps its runtime')
    assert.equal(state().runtime[draftId]?.controlsRevision, 1)
    return
  }

  if (name === 'project-draft-abandoned-while-creating') {
    const gate = deferred<void>()
    api.createSession = async (cwd: string, sessionId?: string) => {
      createdIds.push(sessionId ?? meta.id)
      await gate.promise
      return { sessionId: sessionId ?? meta.id, cwd }
    }
    state().acquireProjectDraft(meta.cwd)
    const draftId = state().draftSessionByCwd[meta.cwd]!
    state().releaseProjectDraft(meta.cwd)
    assert.equal(state().draftSessionByCwd[meta.cwd], draftId, 'an in-flight create keeps its slot')
    assert.equal(discardCalls, 0)
    gate.resolve()
    await Bun.sleep(0)
    assert.equal(state().draftSessionByCwd[meta.cwd], undefined)
    assert.equal(state().runtime[draftId], undefined)
    assert.equal(discardCalls, 1)
    return
  }

  if (name === 'project-draft-abandoned-create-failure') {
    const gate = deferred<void>()
    api.createSession = async () => {
      await gate.promise
      throw new Error('create failed')
    }
    state().acquireProjectDraft(meta.cwd)
    const draftId = state().draftSessionByCwd[meta.cwd]!
    state().releaseProjectDraft(meta.cwd)
    gate.resolve()
    await Bun.sleep(0)
    // Nobody is on the home any more, so there is nothing to keep the dead slot for.
    assert.equal(state().draftSessionByCwd[meta.cwd], undefined)
    assert.equal(state().runtime[draftId], undefined)
    assert.equal(state().draftSessionErrorByCwd[meta.cwd], undefined)
    assert.equal(discardCalls, 1, 'a session main may have half-made is discarded once')
    // Coming back mints a fresh one instead of resurrecting the failed id.
    api.createSession = async (cwd: string, sessionId?: string) => {
      createdIds.push(sessionId ?? meta.id)
      return { sessionId: sessionId ?? meta.id, cwd }
    }
    state().acquireProjectDraft(meta.cwd)
    const nextId = state().draftSessionByCwd[meta.cwd]
    assert.ok(nextId && nextId !== draftId, 'the returned home starts a new session')
    assert.equal(createdIds.at(-1), nextId)
    await Bun.sleep(0)
    assert.equal(state().draftSessionErrorByCwd[meta.cwd], undefined)
    assert.equal(state().runtime[nextId]?.controlsRevision, 1)
    return
  }

  if (name === 'project-draft-promote-without-lease') {
    const gate = deferred<void>()
    api.createSession = async (cwd: string, sessionId?: string) => {
      createdIds.push(sessionId ?? meta.id)
      await gate.promise
      return { sessionId: sessionId ?? meta.id, cwd }
    }
    state().acquireProjectDraft(meta.cwd)
    const draftId = state().draftSessionByCwd[meta.cwd]!
    // The reader sends and leaves the home before main answers: the promote still owns the draft.
    const promoting = state().promoteProjectDraft(meta.cwd, draftId)
    state().releaseProjectDraft(meta.cwd)
    gate.resolve()
    assert.equal(await promoting, true, 'the create must not sweep the session a promote is waiting for')
    assert.equal(state().activeTabId, draftId)
    assert.equal(state().openTabs[0]?.id, draftId)
    assert.equal(discardCalls, 0)
    assert.ok(state().runtime[draftId])
    return
  }

  if (name === 'project-draft-create-failure') {
    api.createSession = async () => { throw new Error('create failed') }
    state().acquireProjectDraft(meta.cwd)
    const draftId = state().draftSessionByCwd[meta.cwd]
    assert.ok(draftId, 'a failed create keeps the slot so the home keeps its text')
    assert.ok(state().runtime[draftId], 'the home stays editable while the session is missing')
    await Bun.sleep(0)
    assert.equal(state().draftSessionErrorByCwd[meta.cwd], 'create failed')
    // The next acquire retries with the same id instead of throwing the slot away.
    api.createSession = async (cwd: string, sessionId?: string) => {
      createdIds.push(sessionId ?? meta.id)
      return { sessionId: sessionId ?? meta.id, cwd }
    }
    state().acquireProjectDraft(meta.cwd)
    await Bun.sleep(0)
    assert.equal(state().draftSessionByCwd[meta.cwd], draftId)
    assert.equal(state().draftSessionErrorByCwd[meta.cwd], undefined, 'a healed create clears the failure')
    assert.equal(createdIds.at(-1), draftId)
    assert.equal(discardCalls, 0)
    return
  }

  if (name === 'project-draft-promote-retry') {
    api.createSession = async () => { throw new Error('create failed') }
    state().acquireProjectDraft(meta.cwd)
    const draftId = state().draftSessionByCwd[meta.cwd]!
    await Bun.sleep(0)
    api.createSession = async (cwd: string, sessionId?: string) => {
      createdIds.push(sessionId ?? meta.id)
      return { sessionId: sessionId ?? meta.id, cwd }
    }
    // Neither call can reach a session main does not have; both have to leave the slot standing.
    api.promoteSession = async () => { throw new Error('draft is gone') }
    await assert.rejects(state().promoteProjectDraft(meta.cwd, draftId), /draft is gone/)
    assert.equal(state().draftSessionByCwd[meta.cwd], draftId, 'a failed promote puts the slot back')
    api.promoteSession = async () => { promoteCalls++ }
    assert.equal(await state().promoteProjectDraft(meta.cwd, draftId), true)
    assert.equal(createdIds.at(-1), draftId, 'the retry creates the session main never had')
    assert.equal(state().activeTabId, draftId)
    assert.equal(state().openTabs[0]?.id, draftId)
    assert.equal(state().draftSessionErrorByCwd[meta.cwd], undefined)
    return
  }

  if (name === 'open-project-draft') {
    state().acquireProjectDraft(meta.cwd)
    const draftId = state().draftSessionByCwd[meta.cwd]!
    const materialized = { ...meta, id: draftId, path: `/project/${draftId}.jsonl` }
    await Bun.sleep(0)
    await state().openExisting(materialized, 'project')
    assert.equal(promoteCalls, 1)
    assert.equal(openCalls, 0)
    assert.equal(state().draftSessionByCwd[meta.cwd], undefined)
    assert.equal(state().activeTabId, draftId)
    assert.equal(state().openTabs[0]?.meta, materialized)
    assert.equal(state().openTabs[0]?.title, '新对话')
    assert.ok(state().runtime[draftId])
    state().releaseProjectDraft(meta.cwd)
    await Bun.sleep(0)
    assert.equal(discardCalls, 0)
    assert.ok(state().runtime[draftId])
    return
  }

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
    const list = (from: number, count: number): DisplayTurn[] => Array.from({ length: count }, (_, offset) => ({
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
    const list = (from: number, count: number): DisplayTurn[] => Array.from({ length: count }, (_, offset) => ({
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
    assert.equal(state().activeTabId, meta.id)
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
      api.getTurnWindow = async (_id, from, _count) => window('A', from, 1769, `A${from}`)
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
    assert.equal(state().activeTabId, meta.id)
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
  } else if (name === 'chat-session-delete-keeps-diff') {
    const { useDiffStore } = await import('../src/renderer/src/stores/diff')
    const forgotten: string[] = []
    useDiffStore.setState({ forgetWorktree: (cwd) => { forgotten.push(cwd) } })
    api.deleteSession = async () => {}
    const chatCwd = '/chat-only'
    const chatMeta = { ...meta, cwd: chatCwd }
    store.setState({ chats: [{ cwd: chatCwd, name: 'chat', sessions: [chatMeta] }] })
    await state().deleteChat(chatCwd)
    await state().deleteSession(chatMeta)
    assert.deepEqual(forgotten, [], 'chat and session deletion never clear worktree diff state')
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
  } else if (name === 'file-tabs') {
    let closes = 0
    api.closeSession = async () => { closes++ }
    const sessionTab = {
      id: meta.id,
      cwd: '/project',
      title: '新对话',
      kind: 'project' as const,
      loadState: 'ready' as const
    }
    store.setState({
      openTabs: [sessionTab],
      activeTabId: meta.id,
      currentProjectCwd: '/project',
      activeSessionByCwd: { '/project': meta.id }
    })

    await state().openFileTab('/project', 'src/one.ts')
    const fileTabId = `file:/project\u0000src/one.ts`
    assert.equal(openCalls, 0, 'a file tab opens no session')
    assert.equal(state().activeTabId, fileTabId)
    assert.equal(selectActiveSessionId(state()), null, 'a file tab is not a session, whoever asks')
    assert.equal(state().currentProjectCwd, '/project', 'the column keeps the worktree it belongs to')
    assert.equal(state().openTabs.length, 2)
    assert.equal(state().openTabs.at(-1)?.title, 'one.ts', 'the tab is named after the file')
    assert.equal(state().openTabs.at(-1)?.path, 'src/one.ts')

    // Opening the same file again reveals the tab it already has; the same path in another worktree
    // is another file, and gets a tab of its own.
    await state().openFileTab('/project', 'src/one.ts')
    assert.equal(state().openTabs.length, 2)
    await state().openFileTab('/other', 'src/one.ts')
    assert.equal(state().openTabs.length, 3)
    assert.equal(state().currentProjectCwd, '/other')
    assert.equal(persistedOpenProjectSessions.workspaces.length, 0, 'a file tab is not remembered across launches')

    // Closing one hands the strip back to a tab of its own worktree, and closes no session with it.
    await state().activateTab(fileTabId)
    assert.equal(state().currentProjectCwd, '/project')
    assert.equal(selectActiveSessionId(state()), null)
    state().closeTab(fileTabId)
    assert.equal(state().activeTabId, meta.id)
    assert.equal(selectActiveSessionId(state()), meta.id, 'the session is back behind the strip')
    assert.equal(state().activeTabByCwd['/project'], meta.id)
    assert.equal(closes, 0, 'a file tab owns no session to close')
  } else {
    throw new Error(`Unknown fixture: ${name}`)
  }
}

if (process.argv[2] === '--session-store-fixture') {
  await runFixture(process.argv[3])
} else {
  const cases = {
    'workspace-restore-lazy': 'restored workspaces open only the selected active session',
    'workspace-restore-retry': 'a failed workspace restore stays retryable',
    'worktree-topology-sync': 'focus discovery preserves sessions without scanning their files',
    'rename-session': 'a rename reaches the tab, the project rows and the chats, and clearing it restores the title',
    'late-session-names': 'a name found after the listing patches the tab, the project rows and the chats',
    'worktree-tab-remembered': 'a worktree returns to the changes tab it was left on',
    'worktree-restore-tabs': 'a restored worktree opens the tab it was left on',
    'project-draft-lifecycle': 'a leased project draft stays hidden and promotion reuses its runtime',
    'project-draft-id-first': 'the home owns its session id before the create resolves',
    'project-draft-promoted-while-creating': 'a promote during the create round trip keeps the session',
    'project-draft-abandoned-while-creating': 'an abandoned in-flight draft is discarded once it exists',
    'project-draft-abandoned-create-failure': 'a create that fails for nobody leaves no slot behind',
    'project-draft-promote-without-lease': 'a promote outlives the create it waited for',
    'project-draft-create-failure': 'a failed create keeps the slot and heals on the next acquire',
    'project-draft-promote-retry': 'a failed promote keeps the slot and heals on the next promote',
    'open-project-draft': 'opening a materialized project draft promotes it before leaving the home view',
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
    'chat-session-delete-keeps-diff': 'deleting a chat or session does not clear worktree diff state',
    'file-tabs': 'a file tab opens no session and is remembered per worktree',
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
