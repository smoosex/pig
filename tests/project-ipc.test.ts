import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const modulePath = (path: string) => fileURLToPath(new URL(path, import.meta.url))

async function runFixture(): Promise<void> {
  const handlers = new Map<string, (...args: any[]) => unknown>()
  const discoveryError = new Error('cannot discover worktrees')
  let closeCalls = 0
  let discoveryCalls = 0
  let sessionListCalls = 0
  let removeWorkspaceCalls = 0
  let removeProjectCalls = 0

  mock.module('electron', () => ({
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
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
  mock.module(modulePath('../src/main/pi/session-loader.ts'), () => ({
    removeProjectDir: async () => {}
  }))
  mock.module(modulePath('../src/main/opened-projects.ts'), () => ({
    addOpenedProject: async (cwd: string) => cwd,
    removeOpenedProject: async () => { removeProjectCalls++ },
    reorderOpenedProjects: async () => {}
  }))
  mock.module(modulePath('../src/main/worktrees.ts'), () => ({
    canonicalProject: async (cwd: string) => cwd
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
    loadWorktreeProject: async () => null,
    requireOpenedProject: async () => '/project',
    worktrees: {
      discover: async () => { throw discoveryError },
      exclusive: async () => {}
    }
  }))
  mock.module(modulePath('../src/main/chats.ts'), () => ({
    createChatDir: async () => '/chat',
    isChatCwd: () => false,
    isChatsRoot: () => false,
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
}

if (process.argv[2] === '--project-ipc-fixture') {
  await runFixture()
} else {
  test('project IPC: failed worktree discovery aborts unpin before cleanup', async () => {
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
