import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'

mock.module('electron', () => ({ app: { isPackaged: false } }))
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

type StateModule = typeof import('../src/main/open-project-sessions')

let root = ''
let state: StateModule
const previousPigDir = process.env.PIG_DIR

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'pig-open-project-sessions-'))
  process.env.PIG_DIR = root
  state = await import('../src/main/open-project-sessions')
})

beforeEach(async () => {
  await rm(join(root, 'open-project-sessions.json'), { force: true, recursive: true })
  await rm(join(root, 'open-project-sessions.json.corrupt'), { force: true })
})

afterAll(async () => {
  if (previousPigDir === undefined) delete process.env.PIG_DIR
  else process.env.PIG_DIR = previousPigDir
  await rm(root, { recursive: true, force: true })
})

describe('open project sessions', () => {
  test('serializes concurrent opens and keeps workspace order', async () => {
    const cwd = join(root, 'project')
    await Promise.all([
      state.rememberOpenProjectSession(cwd, 'one'),
      state.rememberOpenProjectSession(cwd, 'two')
    ])
    await state.selectOpenProjectWorkspace(cwd, 'two', 'two')

    expect(await state.loadOpenProjectSessions()).toEqual({
      currentCwd: resolve(cwd),
      workspaces: [{
        cwd: resolve(cwd),
        sessionIds: ['one', 'two'],
        activeSessionId: 'two',
        changesOpen: false,
        activeTabId: 'two',
        tabOrder: ['one', 'two']
      }],
      chatOrder: [],
      activeChatTabId: null
    })
  })

  test('closing is not deletion and picks the last remaining session', async () => {
    const cwd = join(root, 'project')
    await state.rememberOpenProjectSession(cwd, 'one')
    await state.rememberOpenProjectSession(cwd, 'two')
    await state.selectOpenProjectWorkspace(cwd, 'two', 'two')
    await state.forgetOpenProjectSession('two')

    expect(await state.loadOpenProjectSessions()).toEqual({
      currentCwd: resolve(cwd),
      workspaces: [{
        cwd: resolve(cwd),
        sessionIds: ['one'],
        activeSessionId: 'one',
        changesOpen: false,
        activeTabId: 'one',
        tabOrder: ['one']
      }],
      chatOrder: [],
      activeChatTabId: null
    })
  })

  test('removes deleted worktrees and their current selection', async () => {
    const first = join(root, 'first')
    const second = join(root, 'second')
    await state.rememberOpenProjectSession(first, 'one')
    await state.rememberOpenProjectSession(second, 'two')
    await state.selectOpenProjectWorkspace(first, 'one', 'one')
    await state.removeOpenProjectWorkspaces([first])

    expect(await state.loadOpenProjectSessions()).toEqual({
      currentCwd: null,
      workspaces: [{
        cwd: resolve(second),
        sessionIds: ['two'],
        activeSessionId: 'two',
        changesOpen: false,
        activeTabId: 'two',
        tabOrder: ['two']
      }],
      chatOrder: [],
      activeChatTabId: null
    })
  })

  // The strip's selection is not the active session: a worktree can be left reading its changes tab, and
  // that is what has to come back — not the session behind it.
  test('remembers a changes tab as the active tab of its worktree', async () => {
    const cwd = join(root, 'project')
    await state.rememberOpenProjectSession(cwd, 'one')
    await state.selectOpenProjectWorkspace(cwd, 'one', `diff:${resolve(cwd)}`)

    expect(await state.loadOpenProjectSessions()).toEqual({
      currentCwd: resolve(cwd),
      workspaces: [{
        cwd: resolve(cwd),
        sessionIds: ['one'],
        activeSessionId: 'one',
        changesOpen: false,
        activeTabId: `diff:${resolve(cwd)}`,
        tabOrder: ['one']
      }],
      chatOrder: [],
      activeChatTabId: null
    })
  })

  test('normalizes malformed persisted state without throwing', async () => {
    await writeFile(join(root, 'open-project-sessions.json'), JSON.stringify({
      version: 1,
      currentCwd: 42,
      workspaces: [
        { cwd: join(root, 'project'), sessionIds: ['one', 'one', null], activeSessionId: 'missing' },
        { cwd: '', sessionIds: ['bad'] }
      ]
    }))

    expect(await state.loadOpenProjectSessions()).toEqual({
      currentCwd: null,
      workspaces: [{
        cwd: resolve(join(root, 'project')),
        sessionIds: ['one'],
        activeSessionId: 'one',
        changesOpen: false,
        activeTabId: 'one',
        tabOrder: ['one']
      }],
      chatOrder: [],
      activeChatTabId: null
    })
  })

  test('a version 1 file restores with no changes tab and keeps the active session', async () => {
    const cwd = join(root, 'legacy')
    await writeFile(join(root, 'open-project-sessions.json'), JSON.stringify({
      version: 1,
      currentCwd: cwd,
      workspaces: [{ cwd, sessionIds: ['one'], activeSessionId: 'one' }]
    }))

    expect(await state.loadOpenProjectSessions()).toEqual({
      currentCwd: resolve(cwd),
      workspaces: [{
        cwd: resolve(cwd),
        sessionIds: ['one'],
        activeSessionId: 'one',
        changesOpen: false,
        activeTabId: 'one',
        tabOrder: ['one']
      }],
      chatOrder: [],
      activeChatTabId: null
    })
  })

  test('keeps an open changes tab for a worktree that has no session left', async () => {
    const cwd = join(root, 'changes-only')
    await state.saveOpenProjectChangesTab(cwd, true, `diff:${cwd}`)

    const loaded = await state.loadOpenProjectSessions()
    expect(loaded.currentCwd).toBe(resolve(cwd))
    expect(loaded.workspaces).toEqual([{
      cwd: resolve(cwd),
      sessionIds: [],
      activeSessionId: null,
      changesOpen: true,
      activeTabId: `diff:${cwd}`,
      tabOrder: [`diff:${resolve(cwd)}`]
    }])

    await state.forgetOpenProjectSession('nothing')
    expect((await state.loadOpenProjectSessions()).workspaces).toHaveLength(1)

    await state.saveOpenProjectChangesTab(cwd, false, null)
    await state.forgetOpenProjectSession('nothing')
    expect((await state.loadOpenProjectSessions()).workspaces).toEqual([])
  })

  test('a version 2 file restores its diff tabs as one open changes tab', async () => {
    const cwd = join(root, 'legacy-diffs')
    await writeFile(join(root, 'open-project-sessions.json'), JSON.stringify({
      version: 2,
      currentCwd: cwd,
      workspaces: [{
        cwd,
        sessionIds: [],
        activeSessionId: null,
        diffTabs: [{ path: 'src/a.ts', scope: 'unstaged' }],
        activeTabId: 'diff:unstaged:src/a.ts'
      }],
      chatOrder: [],
      activeChatTabId: null
    }))

    expect(await state.loadOpenProjectSessions()).toEqual({
      currentCwd: resolve(cwd),
      workspaces: [{
        cwd: resolve(cwd),
        sessionIds: [],
        activeSessionId: null,
        changesOpen: true,
        activeTabId: 'diff:unstaged:src/a.ts',
        tabOrder: [`diff:${resolve(cwd)}`]
      }],
      chatOrder: [],
      activeChatTabId: null
    })
  })

  test('an unreadable file fails the write instead of replacing it', async () => {
    const path = join(root, 'open-project-sessions.json')
    await mkdir(path)

    await expect(state.rememberOpenProjectSession(join(root, 'project'), 'one')).rejects.toThrow()
    await expect(state.loadOpenProjectSessions()).rejects.toThrow()
    expect((await stat(path)).isDirectory()).toBe(true)
  })

  // The order a strip was dragged into is only an arrangement of the tabs that can come back: writing it
  // must never be a way to open or close one, and a file never written here must not disturb the rest.
  test('a dragged order arranges the members it has and ignores the ones it does not', async () => {
    const cwd = join(root, 'project')
    await state.rememberOpenProjectSession(cwd, 'one')
    await state.rememberOpenProjectSession(cwd, 'two')
    await state.saveOpenProjectChangesTab(cwd, true, null)
    await state.saveOpenProjectTabOrder(cwd, ['two', 'file:' + resolve(cwd) + '\u0000src/a.ts', 'ghost', `diff:${resolve(cwd)}`, 'one'])

    expect((await state.loadOpenProjectSessions()).workspaces[0].tabOrder).toEqual([
      'two',
      `diff:${resolve(cwd)}`,
      'one'
    ])

    // A member the order never mentioned is appended rather than dropped, so a stale drag cannot close a tab.
    await state.rememberOpenProjectSession(cwd, 'three')
    expect((await state.loadOpenProjectSessions()).workspaces[0]).toMatchObject({
      sessionIds: ['one', 'two', 'three'],
      tabOrder: ['two', `diff:${resolve(cwd)}`, 'one', 'three']
    })
  })

  test('a worktree nobody dragged reads back the shape ordering never existed in', async () => {
    const cwd = join(root, 'legacy-order')
    await writeFile(join(root, 'open-project-sessions.json'), JSON.stringify({
      version: 3,
      currentCwd: cwd,
      workspaces: [{
        cwd,
        sessionIds: ['one', 'two'],
        activeSessionId: 'one',
        changesOpen: true,
        activeTabId: `diff:${cwd}`
      }]
    }))

    expect(await state.loadOpenProjectSessions()).toEqual({
      currentCwd: resolve(cwd),
      workspaces: [{
        cwd: resolve(cwd),
        sessionIds: ['one', 'two'],
        activeSessionId: 'one',
        changesOpen: true,
        activeTabId: `diff:${resolve(cwd)}`,
        // sessions in arrival order, then the changes tab: exactly what the restore built before dragging.
        tabOrder: ['one', 'two', `diff:${resolve(cwd)}`]
      }],
      chatOrder: [],
      activeChatTabId: null
    })
  })

    test('closing a worktree’s changes tab takes it out of the order with it', async () => {
    const cwd = join(root, 'project')
    await state.rememberOpenProjectSession(cwd, 'one')
    await state.saveOpenProjectChangesTab(cwd, true, `diff:${resolve(cwd)}`)
    await state.saveOpenProjectTabOrder(cwd, [`diff:${resolve(cwd)}`, 'one'])
    await state.saveOpenProjectChangesTab(cwd, false, 'one')

    expect((await state.loadOpenProjectSessions()).workspaces[0].tabOrder).toEqual(['one'])
  })

  test('the chats half keeps its order, its membership and the chat it was showing', async () => {
    await state.saveOpenChatTabs(['b', 'a', 'b'], 'a')
    expect(await state.loadOpenProjectSessions()).toMatchObject({
      chatOrder: ['b', 'a'],
      activeChatTabId: 'a'
    })

    // An active tab that is not among the open ones is no active tab: the half falls to its home instead
    // of restoring a pane for a chat that has no place on the strip.
    await state.saveOpenChatTabs(['b'], 'gone')
    expect(await state.loadOpenProjectSessions()).toMatchObject({
      chatOrder: ['b'],
      activeChatTabId: null
    })

    // An empty list is a strip with nothing open, which is what lets the last chat be closed for good.
    await state.saveOpenChatTabs([], null)
    expect(await state.loadOpenProjectSessions()).toMatchObject({ chatOrder: [], activeChatTabId: null })
  })

  test('a corrupt file is reported and set aside rather than silently overwritten', async () => {
    const path = join(root, 'open-project-sessions.json')
    await writeFile(path, '{"version": 1, "workspaces": [')

    await expect(state.loadOpenProjectSessions()).rejects.toThrow('Invalid open-project-sessions JSON')
    expect((await readFile(`${path}.corrupt`, 'utf8')).startsWith('{"version": 1')).toBe(true)

    await state.rememberOpenProjectSession(join(root, 'project'), 'one')
    expect(JSON.parse(await readFile(path, 'utf8')).workspaces).toEqual([{
      cwd: resolve(join(root, 'project')),
      sessionIds: ['one'],
      activeSessionId: 'one',
      changesOpen: false,
      activeTabId: 'one',
      tabOrder: ['one']
    }])
  })
})
