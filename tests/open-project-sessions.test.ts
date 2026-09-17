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
    await state.selectOpenProjectWorkspace(cwd, 'two')

    expect(await state.loadOpenProjectSessions()).toEqual({
      currentCwd: resolve(cwd),
      workspaces: [{ cwd: resolve(cwd), sessionIds: ['one', 'two'], activeSessionId: 'two' }]
    })
  })

  test('closing is not deletion and picks the last remaining session', async () => {
    const cwd = join(root, 'project')
    await state.rememberOpenProjectSession(cwd, 'one')
    await state.rememberOpenProjectSession(cwd, 'two')
    await state.selectOpenProjectWorkspace(cwd, 'two')
    await state.forgetOpenProjectSession('two')

    expect(await state.loadOpenProjectSessions()).toEqual({
      currentCwd: resolve(cwd),
      workspaces: [{ cwd: resolve(cwd), sessionIds: ['one'], activeSessionId: 'one' }]
    })
  })

  test('removes deleted worktrees and their current selection', async () => {
    const first = join(root, 'first')
    const second = join(root, 'second')
    await state.rememberOpenProjectSession(first, 'one')
    await state.rememberOpenProjectSession(second, 'two')
    await state.selectOpenProjectWorkspace(first, 'one')
    await state.removeOpenProjectWorkspaces([first])

    expect(await state.loadOpenProjectSessions()).toEqual({
      currentCwd: null,
      workspaces: [{ cwd: resolve(second), sessionIds: ['two'], activeSessionId: 'two' }]
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
        activeSessionId: 'one'
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
      activeSessionId: 'one'
    }])
  })
})
