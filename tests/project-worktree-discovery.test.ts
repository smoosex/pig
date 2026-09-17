import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const modulePath = (path: string) => fileURLToPath(new URL(path, import.meta.url))

async function runFixture(): Promise<void> {
  let sessionScans = 0

  mock.module('electron', () => ({
    BrowserWindow: { getAllWindows: () => [] }
  }))
  mock.module(modulePath('../src/main/opened-projects.ts'), () => ({
    listOpenedCwds: async () => ['/project', '/broken', '/plain', '/unknown']
  }))
  mock.module(modulePath('../src/main/pig-dir.ts'), () => ({
    pigPath: (name: string) => `/pig/${name}`
  }))
  mock.module(modulePath('../src/main/pi/session-loader.ts'), () => ({
    listProject: async () => { sessionScans++; return null }
  }))
  mock.module(modulePath('../src/main/worktrees.ts'), () => ({
    isGitProject: async (cwd: string) => {
      if (cwd === '/unknown') throw new Error('git probe failed')
      return cwd !== '/plain'
    },
    WorktreeService: class {
      async discover(cwd: string) {
        if (cwd === '/broken') throw new Error('git failed')
        return [{
          cwd,
          branch: 'main',
          isPrimary: true,
          locked: false,
          missing: false,
          managed: false
        }]
      }
    }
  }))

  const { discoverOpenedWorktrees, loadWorktreeSessions } = await import('../src/main/project-worktrees')
  assert.deepEqual(await discoverOpenedWorktrees(), [
    {
      cwd: '/project',
      hasGit: true,
      worktrees: [{
        cwd: '/project',
        branch: 'main',
        isPrimary: true,
        locked: false,
        missing: false,
        managed: false
      }]
    },
    { cwd: '/broken', hasGit: true, worktrees: null, gitError: 'git failed' },
    {
      cwd: '/plain',
      hasGit: false,
      worktrees: [{
        cwd: '/plain',
        branch: 'main',
        isPrimary: true,
        locked: false,
        missing: false,
        managed: false
      }]
    },
    { cwd: '/unknown', hasGit: null, worktrees: null, gitError: 'git probe failed' }
  ])
  assert.equal(sessionScans, 0, 'worktree discovery must not enter the session loader')
  assert.deepEqual(await loadWorktreeSessions('/project', '/project'), [])
  assert.equal(sessionScans, 1, 'entering a discovered worktree scans only its own session directory')
  await assert.rejects(loadWorktreeSessions('/project', '/other'), /不属于已打开项目/)
  assert.equal(sessionScans, 1)
}

if (process.argv[2] === '--project-worktree-discovery-fixture') {
  await runFixture()
} else {
  test('project discovery: focus refresh does not scan session files', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--project-worktree-discovery-fixture'], {
      stdout: 'pipe', stderr: 'pipe'
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
