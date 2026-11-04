import { expect, mock, test } from 'bun:test'
import { runSelf } from './helpers/subprocess'
import type { BrowserWindow } from 'electron'
import type { PermissionMode } from '../src/shared/permissions'
import type { SessionAgentConfig } from '../src/shared/session-agent'

async function fixture() {
const cases: Array<{ name: string; run: () => Promise<void> | void }> = []
let setup: () => void = () => {}
let cleanup: () => void = () => {}
const test = (name: string, run: () => Promise<void> | void) => { cases.push({ name, run }) }
const beforeEach = (fn: () => void) => { setup = fn }
const afterEach = (fn: () => void) => { cleanup = fn }
const win = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: () => {} } } as unknown as BrowserWindow
const states = new Map<string, ReturnType<typeof fakeState>>()
const modes = new Map<string, PermissionMode>()
const listeners = new Set<() => void>()
let approvals = 0
let approval: (() => Promise<void>) | undefined
let prepare: (() => void) | undefined
let sent = 0
let lastBeforeSubmit: (() => void) | undefined
let preflight: (() => Promise<void>) | undefined
let created = 0
let uiFailure = false
let projectCheck: (() => void) | undefined
const runningProcesses = new Set<string>()
const pendingChildren = new Set<string>()
const order: string[] = []
const patches: unknown[] = []
const model = { provider: 'test', id: 'model' }
const capabilities = { tools: [{ id: 'subagent', enabled: true }], mcp: [], skills: [], busy: false }
function fakeState(id: string, owner = win) {
  const entries: unknown[] = []
  return {
    sessionId: id, cwd: '/project', win: owner,
    agentSession: {
      isIdle: true, isBashRunning: false, isCompacting: false, model,
      sessionManager: { getSessionName: () => id, getEntries: () => entries },
      subscribe: () => () => {},
      setModel: async () => { order.push('model') },
      setThinkingLevel: () => { order.push('thinking') },
      abort: async () => { order.push('abort') },
    }
  }
}
mock.module('../src/main/permissions/approval', () => ({ approve: async () => { approvals++; await approval?.() } }))
mock.module('../src/main/permissions/store', () => ({
  sessionPermission: (id: string) => ({ mode: modes.get(id) ?? 'default' }),
  onPermissionsChanged: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
  saveSessionPermission: async (id: string, mode: PermissionMode) => { modes.set(id, mode); for (const fn of listeners) fn() },
}))
mock.module('../src/main/extension-ui', () => ({ hasPendingApproval: () => false }))
mock.module('../src/main/project-directory-browser', () => ({ resolveProjectDirectory: async (path: string) => path }))
mock.module('../src/main/project-open', () => ({ openProjectDirectory: async () => ({ cwd: '/project', name: 'Project', sessions: [] }) }))
mock.module('../src/main/project-worktrees', () => ({
  loadOpenedWorktreeProjects: async () => [{ cwd: '/project', name: 'Project', sessions: [] }],
  requireOpenedProject: async (cwd: string) => { if (cwd !== '/project') throw new Error('Project not open'); return cwd },
  forgetProjectBranches: () => { order.push('forgetBranches') },
  worktrees: {
    discover: async () => [{ cwd: '/worktree' }],
    exclusive: async (_cwd: string, fn: () => Promise<unknown>) => fn(),
    withBlockedCwds: async (_cwds: string[], fn: () => Promise<unknown>) => fn()
  }
}))
mock.module('../src/main/opened-projects', () => ({ removeOpenedProject: async () => { order.push('unpin') } }))
mock.module('../src/main/processes', () => ({ hasRunningSessionProcesses: (id: string) => runningProcesses.has(id) }))
mock.module('../src/main/open-project-sessions', () => ({ rememberOpenProjectSession: async () => { order.push('remember') }, forgetOpenProjectSession: async () => {}, removeOpenProjectWorkspaces: async () => { order.push('forgetWorkspaces') } }))
mock.module('../src/main/chats', () => ({ isChatCwd: () => false }))
mock.module('../src/main/subagents/service', () => ({ manager: { snapshot: () => [], hasPendingWork: (id: string) => pendingChildren.has(id), abortAllAndWait: async () => { order.push('abortChildren') } } }))
mock.module('../src/main/pi/session-registry', () => ({
  getLive: (id: string) => states.get(id),
  sessionState: (id: string) => { const state = states.get(id); if (!state) throw new Error('Session not found'); return state },
  openSessions: () => [...states.values()],
  prepareSession: async (id: string) => { prepare?.(); return states.get(id) },
  isNavigatingSessionBranch: () => false,
  getSessionCapabilities: async () => capabilities,
  getSessionControls: async () => ({ model, thinkingLevel: 'medium' }),
  setSessionCapability: async (_id: string, group: unknown, id: unknown, enabled: unknown) => { order.push('patch'); patches.push({ group, id, enabled }); return capabilities },
  createPendingSession: () => { const id = 'created-' + (++created); const state = fakeState(id); states.set(id, state); order.push('create'); return state },
  activateSession: async (id: string) => { order.push('publish'); return { session: states.get(id) } },
  promoteDraftSession: () => { order.push('promote') },
  renameSession: async () => {},
  discardDraftSession: async (id: string) => { order.push('discard'); states.delete(id) },
  closeSession: async (id: string) => { order.push('close'); states.delete(id) },
  closeSessionsForCwd: async (cwd: string) => {
    order.push('closeCwd:' + cwd)
    for (const [id, state] of states) if (state.cwd === cwd) states.delete(id)
  },
}))
mock.module('../src/main/pi/event-bridge', () => ({ isSessionRunActive: () => false }))
mock.module('../src/main/pi/session-prompt', () => ({ promptSession: async (_id: string, _input: unknown, options: { beforeSubmit: () => void }) => {
  lastBeforeSubmit = options.beforeSubmit
  options.beforeSubmit()
  await preflight?.()
  options.beforeSubmit()
  sent++
} }))
mock.module('../src/main/pi/model-settings', () => ({
  startModelRuntime: async () => ({ getModel: () => model, getAvailableSnapshot: () => [model] }),
  thinkingLevelsFor: () => ['low', 'medium', 'xhigh'],
}))
const { SessionAgentController } = await import('../src/main/pi/session-agent')
let controller: InstanceType<typeof SessionAgentController>
beforeEach(() => {
  states.clear(); states.set('caller', fakeState('caller')); states.set('target', fakeState('target'))
  modes.clear(); listeners.clear(); approvals = 0; sent = 0; created = 0
  approval = undefined; prepare = undefined; uiFailure = false; lastBeforeSubmit = undefined; preflight = undefined
  order.length = 0; patches.length = 0
  projectCheck = undefined; runningProcesses.clear(); pendingChildren.clear()
  controller = new SessionAgentController({
    assertWindow: () => {},
    request: async (_caller, request) => { order.push('ui:' + request.action); if (uiFailure) throw new Error('UI failed'); if (request.action === 'remove-project' && request.phase === 'check') projectCheck?.() },
    remove: () => { order.push('removeUi') },
  })
})
afterEach(() => controller.tasks.dispose())

test('rejects self and foreign-window targets', async () => {
  await expect(controller.configuration('caller', 'caller')).rejects.toThrow('current session')
  states.set('foreign', fakeState('foreign', { ...win } as BrowserWindow))
  await expect(controller.configuration('caller', 'foreign')).rejects.toThrow('same window')
})
test('read-only mutations are refused without asking; full access does not ask', async () => {
  modes.set('caller', 'read-only')
  await expect(controller.openProject('caller', '/project', {})).rejects.toThrow('Read-only')
  expect(approvals).toBe(0)
  modes.set('caller', 'full-access')
  await controller.openProject('caller', '/project', {})
  expect(approvals).toBe(0)
})
test('default mode asks and does not silently raise a target permission mode', async () => {
  modes.set('target', 'full-access')
  await expect(controller.send('caller', 'target', 'hello', {})).rejects.toThrow('broader permissions')
  expect(sent).toBe(0)
  modes.set('target', 'default')
  await controller.configure('caller', 'target', { thinking: 'medium' }, {})
  expect(approvals).toBe(1)
  expect(order).toEqual(['thinking', 'ui:refresh'])
})
test('mode changes during approval remain cancelled even after switching back', async () => {
  approval = async () => {
    modes.set('caller', 'read-only'); for (const fn of listeners) fn()
    modes.set('caller', 'default'); for (const fn of listeners) fn()
  }
  await expect(controller.configure('caller', 'target', { thinking: 'medium' }, {})).rejects.toThrow()
  expect(order).toEqual([])
  expect(listeners.size).toBe(0)
})
test('caller close during preparation prevents sending', async () => {
  prepare = () => { states.delete('caller') }
  await expect(controller.send('caller', 'target', 'hello', {})).rejects.toThrow()
  expect(sent).toBe(0)
  expect(listeners.size).toBe(0)
})
test('busy target is rejected rather than steering or queueing', async () => {
  states.get('target')!.agentSession.isIdle = false
  await expect(controller.send('caller', 'target', 'hello', {})).rejects.toThrow('busy')
  expect(sent).toBe(0)
})
test('ordered capability patches and model/thinking are applied before UI create', async () => {
  const config: SessionAgentConfig = { model, thinking: 'medium', capabilities: [{ group: 'tools', id: null, enabled: false }, { group: 'tools', id: 'subagent', enabled: true }] }
  const result = await controller.create('caller', { cwd: '/project', ...config }, {})
  expect(result.sessionId).toBe('created-1')
  expect(order.indexOf('model')).toBeLessThan(order.indexOf('thinking'))
  expect(order.filter(item => item === 'patch')).toHaveLength(2)
  expect(order.indexOf('patch')).toBeLessThan(order.indexOf('ui:create'))
  expect(patches).toEqual(config.capabilities!)
  expect(modes.get('created-1')).toBe('default')
  expect(sent).toBe(0)
})
test('unknown capability and unsupported thinking fail before model mutation', async () => {
  await expect(controller.configure('caller', 'target', { model, thinking: 'max' }, {})).rejects.toThrow('not supported')
  await expect(controller.configure('caller', 'target', { model, capabilities: [{ group: 'tools', id: 'missing', enabled: true }] }, {})).rejects.toThrow('Unknown')
  expect(order).toEqual([])
})
test('UI failure reclaims new sessions and releases setup gate', async () => {
  uiFailure = true
  await expect(controller.create('caller', { cwd: '/project', model }, {})).rejects.toThrow('UI failed')
  expect(states.has('created-1')).toBe(false)
  expect(order).toContain('removeUi')
  expect(listeners.size).toBe(0)
})
test('send returns a caller-owned task and registers a final pre-submit authorization check', async () => {
  const task = await controller.send('caller', 'target', 'hello', {})
  expect(task.status).toBe('running')
  expect(sent).toBe(1)
  expect(lastBeforeSubmit).toBeFunction()
  await expect(controller.status('target', task.taskId)).rejects.toThrow('belongs')
})
test('full-access controller authorizes typed target approvals without changing its mode, and revocation is final', async () => {
  const { hasSessionGrant } = await import('../src/main/permissions/grants')
  modes.set('caller', 'full-access')
  await controller.send('caller', 'target', 'hello', {})
  expect(hasSessionGrant('target', ['unsandboxed:sleep 3'])).toBe(true)
  expect(hasSessionGrant('target', [])).toBe(false)
  expect(modes.get('target') ?? 'default').toBe('default')
  modes.set('caller', 'read-only'); for (const fn of listeners) fn()
  modes.set('caller', 'full-access'); for (const fn of listeners) fn()
  expect(hasSessionGrant('target', ['unsandboxed:sleep 3'])).toBe(false)
})
test('default controller borrows only precise grants; replacement invalidates the route', async () => {
  const { grantSession, hasSessionGrant, forgetSessionGrants } = await import('../src/main/permissions/grants')
  grantSession('caller', 'unsandboxed:sleep 3')
  try {
    await controller.send('caller', 'target', 'hello', {})
    expect(hasSessionGrant('target', ['unsandboxed:sleep 3'])).toBe(true)
    expect(hasSessionGrant('target', ['unsandboxed:sleep 30'])).toBe(false)
    states.set('caller', fakeState('caller'))
    expect(hasSessionGrant('target', ['unsandboxed:sleep 3'])).toBe(false)
  } finally { forgetSessionGrants('caller') }
})
test('project removal only unregisters and closes idle sessions across its worktrees', async () => {
  states.get('caller')!.cwd = '/caller'
  const branch = fakeState('branch'); branch.cwd = '/worktree'; states.set('branch', branch)
  const result = await controller.removeProject('caller', '/project', {})
  expect(result).toEqual({ cwd: '/project', cwds: ['/project', '/worktree'] })
  expect(approvals).toBe(1)
  expect(states.has('caller')).toBe(true)
  expect(states.has('target')).toBe(false)
  expect(states.has('branch')).toBe(false)
  expect(order).toEqual(['ui:remove-project', 'closeCwd:/project', 'closeCwd:/worktree', 'forgetWorkspaces', 'unpin', 'forgetBranches', 'ui:remove-project'])
})
test('project removal refuses self, busy children/processes, foreign windows and broader modes', async () => {
  await expect(controller.removeProject('caller', '/project', {})).rejects.toThrow('calling session')
  states.get('caller')!.cwd = '/caller'
  states.get('target')!.agentSession.isIdle = false
  await expect(controller.removeProject('caller', '/project', {})).rejects.toThrow('busy')
  states.get('target')!.agentSession.isIdle = true
  pendingChildren.add('target')
  await expect(controller.removeProject('caller', '/project', {})).rejects.toThrow('busy')
  pendingChildren.clear(); runningProcesses.add('target')
  await expect(controller.removeProject('caller', '/project', {})).rejects.toThrow('background processes')
  runningProcesses.clear(); states.set('target', fakeState('target', { ...win } as BrowserWindow))
  await expect(controller.removeProject('caller', '/project', {})).rejects.toThrow('same window')
  states.set('target', fakeState('target')); modes.set('target', 'full-access')
  await expect(controller.removeProject('caller', '/project', {})).rejects.toThrow('broader permissions')
  expect(order).toEqual([])
})
test('project removal checks permissions and leases again after UI preparation', async () => {
  states.get('caller')!.cwd = '/caller'
  modes.set('caller', 'read-only')
  await expect(controller.removeProject('caller', '/project', {})).rejects.toThrow('Read-only')
  modes.set('caller', 'default')
  await expect(controller.removeProject('caller', 'relative', {})).rejects.toThrow('absolute')
  await expect(controller.removeProject('caller', '/missing', {})).rejects.toThrow('not open')
  projectCheck = () => { modes.set('target', 'full-access') }
  await expect(controller.removeProject('caller', '/project', {})).rejects.toThrow('broader permissions')
  expect(order).toEqual(['ui:remove-project'])
  const { reserveSessionControl } = await import('../src/main/pi/session-control-lock')
  const lease = reserveSessionControl('target'); lease.release()
  expect(states.has('target')).toBe(true)
})
test('failed removal preparation does not close sessions or unregister the project', async () => {
  states.get('caller')!.cwd = '/caller'; uiFailure = true
  await expect(controller.removeProject('caller', '/project', {})).rejects.toThrow('UI failed')
  expect(order).toEqual(['ui:remove-project'])
  expect(states.has('target')).toBe(true)
  expect(listeners.size).toBe(0)
})
test('committed removal reports a UI failure without pretending to roll back persistence', async () => {
  states.get('caller')!.cwd = '/caller'
  projectCheck = () => { uiFailure = true }
  await expect(controller.removeProject('caller', '/project', {})).rejects.toThrow('Project was removed from Pig, but UI cleanup failed')
  expect(order).toContain('unpin')
  expect(states.has('target')).toBe(false)
  expect(states.has('caller')).toBe(true)
  expect(listeners.size).toBe(0)
})
test('stop invalidates a blocked submission, waits for it to exit, and permits a later task', async () => {
  const entered = Promise.withResolvers<void>()
  const blocked = Promise.withResolvers<void>()
  preflight = async () => { entered.resolve(); await blocked.promise }
  const task = await controller.send('caller', 'target', 'must not start after stop', {})
  await entered.promise
  let stopped = false
  const stopping = controller.stop('caller', 'target', {}).then(() => { stopped = true })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(stopped).toBe(false)
  expect(sent).toBe(0)
  blocked.resolve()
  await stopping
  expect(sent).toBe(0)
  expect((await controller.wait('caller', task.taskId, 1000)).task.status).toBe('aborted')
  expect(listeners.size).toBe(0)
  preflight = undefined
  await controller.send('caller', 'target', 'a new task is allowed', {})
  expect(sent).toBe(1)
})
test('stop aborts both parent and children without closing the tab', async () => {
  await controller.stop('caller', 'target', {})
  expect(order).toContain('abortChildren')
  expect(order.filter(item => item === 'abort')).toHaveLength(2)
  expect(states.has('target')).toBe(true)
})
for (const item of cases) {
  setup()
  try { await item.run() } finally { cleanup() }
}
console.log(`controller checks: ${cases.length}`)
}

if (process.argv.includes('--controller-fixture')) {
  await fixture()
} else {
  test('session controller validates ownership, permissions, ordered setup and task dispatch', async () => {
    const result = await runSelf(import.meta.path, ['--controller-fixture'], { timeoutMs: 15000 })
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toContain('controller checks: 19')
  })
}
