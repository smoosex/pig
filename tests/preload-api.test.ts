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
import { GLASS_SURFACE_ARGUMENT } from '../src/shared/surface-style'

async function runFixture(supportsGlass: boolean): Promise<void> {
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
  assert.equal(api.supportsGlass, supportsGlass, 'native material capability is synchronous and needs no IPC call')
  assert.equal(invokes.length, 0)
  await api.browseProjectDirectories('/home', true)
  await api.searchProjectDirectories('/home', 'web', false)
  await api.cancelProjectDirectorySearch()
  await api.openProject('/home/project')
  await api.setModelThinkingPreference('session-1', true)
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
  await api.browser.create('browser:one')
  await api.browser.getState('session-1')
  await api.browser.navigate('session-1', 'http://localhost:3000')
  await api.browser.back('session-1')
  await api.browser.forward('session-1')
  await api.browser.reload('session-1')
  await api.browser.setBounds('session-1', { x: 10, y: 20, width: 500, height: 600 })
  await api.browser.setBounds('session-1', null)
  await api.browser.setSelecting('session-1', true)
  await api.browser.removeAnnotations('browser:one', ['note-1', 'note-2'])
  await api.browser.capture('session-1')
  await api.browser.snapshot('browser:one')
  await api.browser.copyUrl('browser:one')
  await api.browser.openExternal('browser:one')
  await api.browser.inspect('browser:one')
  await api.browser.allowCertificate('browser:one', 'sha256/A')
  await api.browser.listCookieSources('browser:one')
  await api.browser.previewCookies('browser:one', 'chrome:profile', 'site')
  await api.browser.importCookies('browser:one', 'chrome:profile', 'all', null)
  await api.browser.clearSiteCookies('browser:one', 'example.com')
  await api.browser.releaseAgent('browser:one', 'session:one')
  await api.browser.answerAgentOpen('request-1', { browserId: 'browser:one' })
  api.browser.onAgentOpenRequest(() => {})()
  await api.browser.close('session-1')
  api.browser.onCloseRequested(() => {})()
  api.browser.onDevtoolsResize(() => {})()
  api.browser.onShortcutRequested(() => {})()
  api.browser.onState(() => {})()
  api.browser.onSelection(() => {})()
  await api.persona.get()
  await api.persona.saveFile({ name: 'SOUL.md', content: 'persona', revision: null })
  await api.persona.setMood({ pleasantness: 0.6, activation: 0.4, energy: 0.8 })
  await api.persona.setObserver({ enabled: true, provider: 'test', modelId: 'observer' })
  await api.persona.setAutomatic(false)
  api.persona.onChanged(() => {})()
  await api.permissions.getPermissions()
  await api.permissions.setDefaultPermissionMode('read-only')
  await api.permissions.removePermissionDomain('/repo/.git', 'example.com')
  await api.permissions.getSessionPermission('session-1')
  await api.permissions.setSessionPermission('session-1', null)
  api.permissions.onPermissionsChanged(() => {})()
  await api.processes.list('session-1')
  await api.processes.stop('session-1', 'proc-1')
  await api.processes.remove('session-1', 'proc-1')
  api.processes.onChanged(() => {})()
  await api.terminal.create('terminal:one', '/repo', 80, 24)
  await api.terminal.create('terminal:two', null, 100, 30)
  await api.terminal.write('terminal:one', 'ls\r')
  await api.terminal.write('terminal:one', '\x00\x80\xff', true)
  await api.terminal.write('terminal:one', '中文', false)
  await api.terminal.clear('terminal:one')
  await api.terminal.resize('terminal:one', 120, 40)
  await api.terminal.ack('terminal:one', 512)
  await api.terminal.close('terminal:one')
  await api.terminal.getAgentState('terminal:one')
  await api.terminal.releaseAgent('terminal:one', 'session-1')
  await api.terminal.answerAgentOpen('request-1', { terminalId: 'terminal:two' })
  api.terminal.onAgentOpenRequest(() => {})()
  api.terminal.onAgentState(() => {})()
  api.terminal.onEvent(() => {})()

  assert.deepEqual(invokes, [
    { channel: 'project:browse-directories', args: ['/home', true] },
    { channel: 'project:search-directories', args: ['/home', 'web', false] },
    { channel: 'project:cancel-directory-search', args: [] },
    { channel: 'session:open-project', args: ['/home/project'] },
    { channel: 'session:set-model-thinking-preference', args: ['session-1', true] },
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
    { channel: 'files:copy-path', args: ['/repo', 'src/entry.ts'] },
    { channel: 'browser:create', args: ['browser:one'] },
    { channel: 'browser:get-state', args: ['session-1'] },
    { channel: 'browser:navigate', args: ['session-1', 'http://localhost:3000'] },
    { channel: 'browser:back', args: ['session-1'] },
    { channel: 'browser:forward', args: ['session-1'] },
    { channel: 'browser:reload', args: ['session-1'] },
    { channel: 'browser:set-bounds', args: ['session-1', { x: 10, y: 20, width: 500, height: 600 }] },
    { channel: 'browser:set-bounds', args: ['session-1', null] },
    { channel: 'browser:set-selecting', args: ['session-1', true, undefined] },
    { channel: 'browser:remove-annotations', args: ['browser:one', ['note-1', 'note-2']] },
    { channel: 'browser:capture', args: ['session-1'] },
    { channel: 'browser:snapshot', args: ['browser:one'] },
    { channel: 'browser:copy-url', args: ['browser:one'] },
    { channel: 'browser:open-external', args: ['browser:one'] },
    { channel: 'browser:inspect', args: ['browser:one'] },
    { channel: 'browser:allow-certificate', args: ['browser:one', 'sha256/A'] },
    { channel: 'browser:list-cookie-sources', args: ['browser:one'] },
    { channel: 'browser:preview-cookies', args: ['browser:one', 'chrome:profile', 'site'] },
    { channel: 'browser:import-cookies', args: ['browser:one', 'chrome:profile', 'all', null] },
    { channel: 'browser:clear-site-cookies', args: ['browser:one', 'example.com'] },
    { channel: 'browser:release-agent', args: ['browser:one', 'session:one'] },
    { channel: 'browser:agent-open-answer', args: ['request-1', { browserId: 'browser:one' }] },
    { channel: 'browser:close', args: ['session-1'] },
    { channel: 'persona:get', args: [] },
    { channel: 'persona:save-file', args: [{ name: 'SOUL.md', content: 'persona', revision: null }] },
    { channel: 'persona:set-mood', args: [{ pleasantness: 0.6, activation: 0.4, energy: 0.8 }] },
    { channel: 'persona:set-observer', args: [{ enabled: true, provider: 'test', modelId: 'observer' }] },
    { channel: 'persona:set-automatic', args: [false] },
    { channel: 'permissions:get', args: [] },
    { channel: 'permissions:set-default-mode', args: ['read-only'] },
    { channel: 'permissions:remove-domain', args: ['/repo/.git', 'example.com'] },
    { channel: 'permissions:get-session', args: ['session-1'] },
    { channel: 'permissions:set-session', args: ['session-1', null] },
    { channel: 'processes:list', args: ['session-1'] },
    { channel: 'processes:stop', args: ['session-1', 'proc-1'] },
    { channel: 'processes:remove', args: ['session-1', 'proc-1'] },
    { channel: 'terminal:create', args: ['terminal:one', '/repo', 80, 24] },
    { channel: 'terminal:create', args: ['terminal:two', null, 100, 30] },
    { channel: 'terminal:write', args: ['terminal:one', 'ls\r'] },
    { channel: 'terminal:write', args: ['terminal:one', '\x00\x80\xff', true] },
    { channel: 'terminal:write', args: ['terminal:one', '中文', false] },
    { channel: 'terminal:clear', args: ['terminal:one'] },
    { channel: 'terminal:resize', args: ['terminal:one', 120, 40] },
    { channel: 'terminal:ack', args: ['terminal:one', 512] },
    { channel: 'terminal:close', args: ['terminal:one'] },
    { channel: 'terminal:get-agent-state', args: ['terminal:one'] },
    { channel: 'terminal:release-agent', args: ['terminal:one', 'session-1'] },
    { channel: 'terminal:agent-open-answer', args: ['request-1', { terminalId: 'terminal:two' }] }
  ])
  assert.ok(listeners.includes('diff:watch-error'), 'the preload exposes watch failures')
  assert.ok(listeners.includes('session:names'), 'the preload exposes names found after a listing')
  assert.ok(listeners.includes('notification:click'), 'the preload exposes completion notification clicks')
  assert.ok(listeners.includes('system-plugins:ui'))
  assert.ok(listeners.includes('browser:close-tab-requested'))
  assert.ok(listeners.includes('browser:devtools-resize'))
  assert.ok(listeners.includes('browser:agent-open-request'))
  assert.ok(listeners.includes('browser:state'))
  assert.ok(listeners.includes('permissions:changed'))
  assert.ok(listeners.includes('persona:changed'), 'open persona settings learn about conversation changes')
  assert.ok(listeners.includes('browser:selection'))
  assert.ok(listeners.includes('terminal:event'))
  assert.ok(listeners.includes('processes:changed'))
  assert.ok(listeners.includes('terminal:agent-open-request'))
  assert.ok(listeners.includes('terminal:agent-state'))
  assert.equal('replyPluginUI' in api, false)
  assert.equal('onPluginUI' in api, false)
}

if (process.argv[2] === '--preload-api-fixture') {
  await runFixture(process.argv[3] === 'true')
} else {
  for (const supportsGlass of [false, true]) test(`the preload exposes material support (${supportsGlass}) and forwards IPC arguments`, async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--preload-api-fixture', String(supportsGlass), ...(supportsGlass ? [GLASS_SURFACE_ARGUMENT] : [])], {
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
