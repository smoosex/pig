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
      activeChatTabId: null, tools: []
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
      activeChatTabId: null, tools: []
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
      activeChatTabId: null, tools: []
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
      activeChatTabId: null, tools: []
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
      activeChatTabId: null, tools: []
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
      activeChatTabId: null, tools: []
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
      activeChatTabId: null, tools: []
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
      activeChatTabId: null, tools: []
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
      activeChatTabId: null, tools: []
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
      activeChatTabId: 'a', tools: []
    })

    // An active tab that is not among the open ones is no active tab: the half falls to its home instead
    // of restoring a pane for a chat that has no place on the strip.
    await state.saveOpenChatTabs(['b'], 'gone')
    expect(await state.loadOpenProjectSessions()).toMatchObject({
      chatOrder: ['b'],
      activeChatTabId: null, tools: []
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

  test('browser and terminal tabs join the end of their strip and keep the page main last saw', async () => {
    const cwd = resolve(join(root, 'project'))
    await state.rememberOpenProjectSession(cwd, 'one')
    await state.saveOpenChatTabs(['chat'], 'chat')
    await state.saveOpenToolTabs([
      { id: 'browser:b', kind: 'browser', cwd, targetSessionId: 'one' },
      { id: 'terminal:t', kind: 'terminal', cwd: '' }
    ])
    // Pages commit in bursts; the latest one wins and a browser nobody recorded gets nothing written.
    await Promise.all([
      state.saveBrowserTabUrl('browser:b', 'https://a.test/1'),
      state.saveBrowserTabUrl('browser:b', 'https://a.test/2'),
      state.saveBrowserTabUrl('browser:unknown', 'https://a.test/x')
    ])
    await state.rememberOpenProjectSession(cwd, 'two')
    await state.selectOpenProjectWorkspace(cwd, 'one', 'browser:b')

    let loaded = await state.loadOpenProjectSessions()
    expect(loaded.tools).toEqual([
      { id: 'browser:b', kind: 'browser', cwd, url: 'https://a.test/2', targetSessionId: 'one' },
      { id: 'terminal:t', kind: 'terminal', cwd: '' }
    ])
    expect(loaded.workspaces[0]).toMatchObject({ tabOrder: ['one', 'browser:b', 'two'], activeTabId: 'browser:b' })
    expect(loaded.chatOrder).toEqual(['chat', 'terminal:t'])

    // The renderer never states a URL, so restating membership keeps it; closing drops the tab everywhere.
    await state.saveOpenToolTabs([{ id: 'browser:b', kind: 'browser', cwd, targetSessionId: null }])
    loaded = await state.loadOpenProjectSessions()
    expect(loaded.tools).toEqual([{ id: 'browser:b', kind: 'browser', cwd, url: 'https://a.test/2', targetSessionId: null }])
    expect(loaded.chatOrder).toEqual(['chat'])

    await state.forgetOpenProjectSession('one')
    await state.forgetOpenProjectSession('two')
    expect((await state.loadOpenProjectSessions()).workspaces.map((item) => item.tabOrder)).toEqual([['browser:b']])
    await state.removeOpenProjectWorkspaces([cwd])
    expect(await state.loadOpenProjectSessions()).toMatchObject({ workspaces: [], tools: [] })
  })

  test('a failed read does not stop later browser pages from being saved', async () => {
    const path = join(root, 'open-project-sessions.json')
    await state.saveOpenToolTabs([{ id: 'browser:b', kind: 'browser', cwd: '' }])
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    const saved = await readFile(path, 'utf8')
    await rm(path)
    await mkdir(path)
    await expect(state.saveBrowserTabUrl('browser:b', 'https://a.test/lost')).rejects.toThrow()
    await rm(path, { recursive: true })
    await writeFile(path, saved)
    await state.saveBrowserTabUrl('browser:b', 'https://a.test/kept')
    expect((await state.loadOpenProjectSessions()).tools).toEqual([
      { id: 'browser:b', kind: 'browser', cwd: '', url: 'https://a.test/kept', targetSessionId: null }
    ])
  })

  test('the split layout is written whole, cleared when unsplit, and refused when malformed', async () => {
    const layout = {
      root: { id: 's', direction: 'vertical' as const, sizes: [50, 50], children: [{ id: 'p1', tabId: 'browser:a' }, { id: 'p2', tabId: 'one' }] },
      activePaneId: 'p2'
    }
    await state.saveOpenSplitLayout(layout)
    expect((await state.loadOpenProjectSessions()).split).toEqual(layout)
    for (const invalid of [
      { ...layout, activePaneId: 'missing' },
      { root: { id: 'p1', tabId: 'one' }, activePaneId: null },
      { ...layout, root: { ...layout.root, sizes: [50] } },
      { ...layout, root: { ...layout.root, children: [{ id: 'p1', tabId: 'a' }, { id: 'p1', tabId: 'b' }] } }
    ]) expect(() => state.saveOpenSplitLayout(invalid)).toThrow('Invalid split layout')
    await state.saveOpenSplitLayout(null)
    expect(await state.loadOpenProjectSessions()).not.toHaveProperty('split')

    const path = join(root, 'open-project-sessions.json')
    await writeFile(path, JSON.stringify({ version: 5, split: { ...layout, root: { ...layout.root, direction: 'diagonal' } } }))
    expect(await state.loadOpenProjectSessions(), 'a damaged saved layout reads as no split').not.toHaveProperty('split')
  })

  test('a saved tool tab that navigation would refuse does not come back as one', async () => {
    await writeFile(join(root, 'open-project-sessions.json'), JSON.stringify({
      version: 5, currentCwd: null, workspaces: [], activeChatTabId: null,
      chatOrder: ['browser:gone', 'browser:ok'],
      tools: [
        { id: 'browser:ok', kind: 'browser', cwd: '', url: 'file:///etc/passwd' },
        { id: 'browser:gone', kind: 'terminal', cwd: '' },
        { id: 'not-a-tab', kind: 'browser', cwd: '' }
      ]
    }))
    expect(await state.loadOpenProjectSessions()).toMatchObject({
      chatOrder: ['browser:ok'],
      tools: [{ id: 'browser:ok', kind: 'browser', cwd: '', targetSessionId: null }]
    })
    expect((await state.loadOpenProjectSessions()).tools[0]).not.toHaveProperty('url')
    expect(() => state.saveOpenToolTabs([{ id: 'terminal:x', kind: 'browser', cwd: '' }])).toThrow('Invalid open tool tabs')
  })
})
