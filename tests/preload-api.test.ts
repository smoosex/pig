/**
 * The preload is the one place where the contract turns into channel names and arguments, and nothing
 * else in the repo runs it: a handler that forgets an argument type-checks and still builds, because a
 * function with fewer parameters is assignable to one with more. These calls are the allowlist's test.
 *
 * The electron mock is process-wide, and other files in the suite need the real module, so the checks
 * run in a child process of this file.
 */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import type { SessionApi } from '../src/shared/api'

async function runFixture(): Promise<void> {
  const invokes: { channel: string; args: unknown[] }[] = []
  const listeners: string[] = []
  let exposed: SessionApi | null = null

  mock.module('electron', () => ({
    contextBridge: {
      exposeInMainWorld: (_key: string, api: SessionApi) => {
        exposed = api
      }
    },
    ipcRenderer: {
      invoke: (channel: string, ...args: unknown[]) => {
        invokes.push({ channel, args })
        return Promise.resolve(channel === 'diff:watch' ? 'lease-1' : null)
      },
      on: (channel: string) => { listeners.push(channel) },
      off: () => {}
    }
  }))
  Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true })
  await import('../src/preload/index')
  assert.ok(exposed, 'the preload exposed its api')

  const api = exposed as SessionApi
  await api.readWorktreeDiff('/repo')
  await api.readWorktreePatch('/repo', 'staged')
  await api.readUntrackedFile('/repo', 'src/new.ts')
  const leaseId = await api.watchWorktreeDiff('/repo')
  await api.unwatchWorktreeDiff('/repo', leaseId)
  api.onDiffWatchError(() => {})
  api.onSessionNames(() => {})
  api.onNotificationClick(() => {})
  await api.setCompletionNotifications(false)
  // The trailing argument is the one a short signature silently drops: the changes tab it names is what
  // the workspace records as its active tab.
  await api.selectOpenProjectWorkspace('/repo', 'session-1', 'diff:/repo')

  assert.deepEqual(invokes, [
    { channel: 'diff:read-worktree', args: ['/repo'] },
    { channel: 'diff:read-patch', args: ['/repo', 'staged'] },
    { channel: 'diff:read-untracked', args: ['/repo', 'src/new.ts'] },
    { channel: 'diff:watch', args: ['/repo'] },
    { channel: 'diff:unwatch', args: ['/repo', 'lease-1'] },
    { channel: 'settings:set-completion-notifications', args: [false] },
    {
      channel: 'system:select-open-project-workspace',
      args: ['/repo', 'session-1', 'diff:/repo']
    }
  ])
  assert.ok(listeners.includes('diff:watch-error'), 'the preload exposes watch failures')
  assert.ok(listeners.includes('session:names'), 'the preload exposes names found after a listing')
  assert.ok(listeners.includes('notification:click'), 'the preload exposes completion notification clicks')
}

if (process.argv[2] === '--preload-api-fixture') {
  await runFixture()
} else {
  test('the preload hands every diff call its channel and arguments', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--preload-api-fixture'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const timeout = setTimeout(() => child.kill(), 12_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
      ])
      assert.equal(code, 0, stderr || stdout)
    } finally {
      clearTimeout(timeout)
    }
  })
}
