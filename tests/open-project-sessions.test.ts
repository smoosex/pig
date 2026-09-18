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
        activeTabId: 'two'
      }]
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
        activeTabId: 'one'
      }]
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
        activeTabId: 'two'
      }]
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
        activeTabId: `diff:${resolve(cwd)}`
      }]
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
        activeTabId: 'one'
      }]
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
        activeTabId: 'one'
      }]
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
      activeTabId: `diff:${cwd}`
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
      }]
    }))

    expect(await state.loadOpenProjectSessions()).toEqual({
      currentCwd: resolve(cwd),
      workspaces: [{
        cwd: resolve(cwd),
        sessionIds: [],
        activeSessionId: null,
        changesOpen: true,
        activeTabId: 'diff:unstaged:src/a.ts'
      }]
    })
  })

  test('an unreadable file fails the write instead of replacing it', async () => {
    const path = join(root, 'open-project-sessions.json')
    await mkdir(path)

    await expect(state.rememberOpenProjectSession(join(root, 'project'), 'one')).rejects.toThrow()
    await expect(state.loadOpenProjectSessions()).rejects.toThrow()
    expect((await stat(path)).isDirectory()).toBe(true)
  })

  test('a corrupt file is set aside rather than silently overwritten', async () => {
    const path = join(root, 'open-project-sessions.json')
    await writeFile(path, '{"version": 1, "workspaces": [')

    expect(await state.loadOpenProjectSessions()).toEqual({ currentCwd: null, workspaces: [] })
    expect((await readFile(`${path}.corrupt`, 'utf8')).startsWith('{"version": 1')).toBe(true)

    await state.rememberOpenProjectSession(join(root, 'project'), 'one')
    expect(JSON.parse(await readFile(path, 'utf8')).workspaces).toEqual([{
      cwd: resolve(join(root, 'project')),
      sessionIds: ['one'],
      activeSessionId: 'one',
      changesOpen: false,
      activeTabId: 'one'
    }])
  })
})
