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
  await api.compactSession('session-1', 'Preserve decisions')
  await api.compactSession('session-2')
  await api.replyReviewUI('review-request', 'commit')
  api.onSystemUI(() => {})
  // The trailing argument is the one a short signature silently drops: the changes tab it names is what
  // the workspace records as its active tab.
  await api.selectOpenProjectWorkspace('/repo', 'session-1', 'diff:/repo')
  // Both take a whole sequence: a reorder replaces the arrangement rather than editing one tab out of it.
  await api.saveOpenProjectTabOrder('/repo', ['diff:/repo', 'session-1'])
  await api.saveOpenChatTabs(['chat-1', 'chat-2'], 'chat-2')
  await api.retryWorktreeNaming('/repo', '/repo-worktree')
  // The tree's own writes: each takes the worktree, the row, and the name a rename is given.
  await api.createFile('/repo', 'src/thing.ts')
  await api.createDirectory('/repo', 'src/nested')
  await api.renameEntry('/repo', 'src/thing.ts', 'entry.ts')
  await api.trashEntry('/repo', 'src/entry.ts')
  await api.copyPath('/repo', 'src/entry.ts')

  assert.deepEqual(invokes, [
    { channel: 'diff:read-worktree', args: ['/repo'] },
    { channel: 'diff:read-patch', args: ['/repo', 'staged'] },
    { channel: 'diff:read-untracked', args: ['/repo', 'src/new.ts'] },
    { channel: 'diff:watch', args: ['/repo'] },
    { channel: 'diff:unwatch', args: ['/repo', 'lease-1'] },
    { channel: 'settings:set-completion-notifications', args: [false] },
    { channel: 'session:compact', args: ['session-1', 'Preserve decisions'] },
    { channel: 'session:compact', args: ['session-2', undefined] },
    { channel: 'system-plugins:review-reply', args: ['review-request', 'commit'] },
    {
      channel: 'system:select-open-project-workspace',
      args: ['/repo', 'session-1', 'diff:/repo']
    },
    {
      channel: 'system:save-open-project-tab-order',
      args: ['/repo', ['diff:/repo', 'session-1']]
    },
    {
      channel: 'system:save-open-chat-tabs',
      args: [['chat-1', 'chat-2'], 'chat-2']
    },
    { channel: 'project:retry-worktree-naming', args: ['/repo', '/repo-worktree'] },
    { channel: 'files:create-file', args: ['/repo', 'src/thing.ts'] },
    { channel: 'files:create-directory', args: ['/repo', 'src/nested'] },
    { channel: 'files:rename', args: ['/repo', 'src/thing.ts', 'entry.ts'] },
    { channel: 'files:trash', args: ['/repo', 'src/entry.ts'] },
    { channel: 'files:copy-path', args: ['/repo', 'src/entry.ts'] }
  ])
  assert.ok(listeners.includes('diff:watch-error'), 'the preload exposes watch failures')
  assert.ok(listeners.includes('session:names'), 'the preload exposes names found after a listing')
  assert.ok(listeners.includes('notification:click'), 'the preload exposes completion notification clicks')
  assert.ok(listeners.includes('system-plugins:ui'))
  assert.equal('replyPluginUI' in api, false)
  assert.equal('onPluginUI' in api, false)
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
