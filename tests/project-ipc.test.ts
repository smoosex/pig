import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const modulePath = (path: string) => fileURLToPath(new URL(path, import.meta.url))

async function runFixture(): Promise<void> {
  const handlers = new Map<string, (...args: any[]) => unknown>()
  const discoveryError = new Error('cannot discover worktrees')
  let closeCalls = 0
  let discoveryCalls = 0
  let sessionListCalls = 0
  let removeWorkspaceCalls = 0
  let removeProjectCalls = 0
  let dialogCalls = 0
  let chatPath = ''
  const openCalls: string[] = []

  mock.module('electron', () => ({
    dialog: { showOpenDialog: async () => { dialogCalls++; throw new Error('Native dialog must not be used') } },
    ipcMain: {
      handle: (channel: string, handler: (...args: any[]) => unknown) => {
        handlers.set(channel, handler)
      }
    }
  }))
  mock.module(modulePath('../src/main/pi/session-registry.ts'), () => ({
    closeSessionsForCwd: async () => { closeCalls++ },
    createPendingSession: () => ({ sessionId: 'session', cwd: '/chat' })
  }))
  mock.module(modulePath('../src/main/pi/session-removal.ts'), () => ({
    removeProjectSessions: async () => {}
  }))
  mock.module(modulePath('../src/main/opened-projects.ts'), () => ({
    addOpenedProject: async (cwd: string) => { openCalls.push(`add:${cwd}`); return cwd },
    removeOpenedProject: async () => { removeProjectCalls++ },
    reorderOpenedProjects: async () => {}
  }))
  mock.module(modulePath('../src/main/worktrees.ts'), () => ({
    canonicalProject: async (cwd: string) => { openCalls.push(`canonical:${cwd}`); return cwd }
  }))
  mock.module(modulePath('../src/main/project-worktrees.ts'), () => ({
    discoverOpenedWorktrees: async () => {
      discoveryCalls++
      return [{ cwd: '/project', hasGit: true, worktrees: [] }]
    },
    loadOpenedWorktreeProjects: async () => [],
    loadProjectForCwd: async () => null,
    loadWorktreeSessions: async (projectCwd: string, cwd: string) => {
      sessionListCalls++
      return [{ projectCwd, cwd }]
    },
    loadWorktreeProject: async (cwd: string) => { openCalls.push(`load:${cwd}`); return { cwd } },
    requireOpenedProject: async () => '/project',
    worktrees: {
      discover: async () => { throw discoveryError },
      exclusive: async () => {}
    }
  }))
  mock.module(modulePath('../src/main/chats.ts'), () => ({
    createChatDir: async () => '/chat',
    isChatCwd: (cwd: string) => cwd === chatPath,
    isChatsRoot: (cwd: string) => cwd === join(chatPath, 'root'),
    listChats: async () => [],
    removeChatWorkDir: async () => {}
  }))
  mock.module(modulePath('../src/main/open-project-sessions.ts'), () => ({
    removeOpenProjectWorkspaces: async () => { removeWorkspaceCalls++ }
  }))
  mock.module(modulePath('../src/main/ipc/worktrees.ts'), () => ({
    registerWorktreeIpc: () => {}
  }))
  mock.module(modulePath('../src/main/ipc/window.ts'), () => ({
    windowForEvent: () => ({})
  }))

  const { registerProjectIpc } = await import('../src/main/ipc/projects')
  registerProjectIpc()
  const discover = handlers.get('project:discover-opened-worktrees')
  const listWorktreeSessions = handlers.get('project:list-worktree-sessions')
  const unpin = handlers.get('session:unpin-project')
  assert.ok(discover)
  assert.ok(listWorktreeSessions)
  assert.ok(unpin)

  assert.deepEqual(await discover({}), [{ cwd: '/project', hasGit: true, worktrees: [] }])
  assert.equal(discoveryCalls, 1)
  assert.deepEqual(await listWorktreeSessions({}, '/project', '/worktree'), [{
    projectCwd: '/project', cwd: '/worktree'
  }])
  assert.equal(sessionListCalls, 1)
  await assert.rejects(Promise.resolve().then(() => unpin({}, '/project')), (error) => error === discoveryError)
  assert.equal(closeCalls, 0)
  assert.equal(removeWorkspaceCalls, 0)
  assert.equal(removeProjectCalls, 0)

  const browse = handlers.get('project:browse-directories')
  const open = handlers.get('session:open-project')
  assert.ok(browse)
  assert.ok(open)
  const temp = await mkdtemp(join(tmpdir(), 'pig-project-ipc-'))
  try {
    const path = await realpath(temp)
    const project = join(path, 'project')
    await mkdir(project)
    await mkdir(join(project, '.hidden'))
    await symlink(project, join(path, 'alias'))
    const listing = await browse({}, project, true) as { path: string; directories: { name: string }[] }
    assert.equal(listing.path, project)
    assert.deepEqual(listing.directories.map((item) => item.name), ['.hidden'])
    assert.deepEqual(await open({}, join(path, 'alias')), { cwd: project })
    assert.deepEqual(openCalls, [`canonical:${project}`, `add:${project}`, `load:${project}`])
    openCalls.length = 0
    await writeFile(join(path, 'file'), '')
    for (const invalid of [undefined, '', 'relative', join(path, 'missing'), join(path, 'file')]) {
      await assert.rejects(Promise.resolve().then(() => open({}, invalid)))
    }
    chatPath = project
    await mkdir(join(project, 'root'))
    for (const invalid of [project, join(path, 'alias'), join(project, 'root')]) {
      await assert.rejects(Promise.resolve().then(() => open({}, invalid)), /Chat directories/)
    }
    assert.deepEqual(openCalls, [])
    assert.equal(dialogCalls, 0)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--project-ipc-fixture') {
  await runFixture()
} else {
  test('project IPC: explicit directory browsing/opening and failed discovery aborts cleanup', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--project-ipc-fixture'], {
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const timeout = setTimeout(() => child.kill(), 5_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
      ])
      assert.equal(code, 0, stderr || stdout)
    } finally {
      clearTimeout(timeout)
      child.kill()
    }
  }, 10_000)
}
