/** Keep React, translation mocks and happy-dom isolated from the other test workers. */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { translate } from '../src/shared/i18n'
import { PERMISSION_MODES, type PermissionMode, type PermissionsApi, type PermissionsSnapshot, type SessionPermission } from '../src/shared/permissions'

const scenarios = {
  'button-modes': 'permission button reads the session mode and offers three exclusive modes plus follow-default',
  'button-races': 'permission button follows change notifications rather than stale reads or setter replies',
  'button-errors': 'permission button exposes read and write errors without claiming a mode change',
  'button-partial': 'permission button independently refreshes mode and sandbox and invalidates failed reads',
  'pane-state': 'permissions settings show sandbox, default mode and scoped domains and save changes',
  'pane-errors': 'permissions settings expose failures and retain unsaved mode and domain state',
  'pane-races': 'permissions settings keep newer notifications over late reads and mutation replies'
} as const

type Scenario = keyof typeof scenarios

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

async function fixture(scenario: Scenario) {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  HTMLElement.prototype.scrollIntoView = () => {}
  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate('en', key, params)
  mock.module('../src/renderer/src/hooks/useT', () => ({ useT: () => t }))

  let snapshot: PermissionsSnapshot = {
    defaultMode: 'full-access',
    domains: ['global.example'],
    projects: [{ root: '/workspace/project/.git', domains: ['project.example'] }],
    mcp: {},
    sandbox: { state: 'ready' }
  }
  let permission: SessionPermission = { mode: 'read-only', overridden: true }
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of listeners) listener() }
  let reads = 0
  const sessionReads: string[] = []
  const sessionWrites: Array<[string, PermissionMode | null]> = []
  const defaultWrites: PermissionMode[] = []
  const removals: Array<[string | null, string]> = []
  let readSnapshot: PermissionsApi['getPermissions'] = async () => snapshot
  let readPermission: PermissionsApi['getSessionPermission'] = async () => permission
  let writePermission: PermissionsApi['setSessionPermission'] = async (_id, mode) => {
    permission = { mode: mode ?? snapshot.defaultMode, overridden: mode !== null }
    notify()
    return permission
  }
  let writeDefault: PermissionsApi['setDefaultPermissionMode'] = async (mode) => {
    snapshot = { ...snapshot, defaultMode: mode }
    notify()
    return snapshot
  }
  let removeDomain: PermissionsApi['removePermissionDomain'] = async (project, domain) => {
    snapshot = {
      ...snapshot,
      domains: project === null ? snapshot.domains.filter((host) => host !== domain) : snapshot.domains,
      projects: snapshot.projects.map((item) => item.root === project ? { ...item, domains: item.domains.filter((host) => host !== domain) } : item)
    }
    notify()
    return snapshot
  }
  const permissions: PermissionsApi = {
    getPermissions: () => { reads++; return readSnapshot() },
    getSessionPermission: (id) => { sessionReads.push(id); return readPermission(id) },
    setSessionPermission: (id, mode) => { sessionWrites.push([id, mode]); return writePermission(id, mode) },
    setDefaultPermissionMode: (mode) => { defaultWrites.push(mode); return writeDefault(mode) },
    removePermissionDomain: (project, domain) => { removals.push([project, domain]); return removeDomain(project, domain) },
    setMcpApproval: async () => { throw new Error('not used') },
    onPermissionsChanged: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  }
  Object.assign(window, { api: { permissions } })
  const { PermissionModeButton } = await import('../src/renderer/src/components/composer/PermissionModeButton')
  const { PermissionsPane } = await import('../src/renderer/src/components/settings/PermissionsPane')
  const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
  const { Toaster } = await import('sonner')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const isButton = scenario.startsWith('button-')
  const render = async (sessionId: string | null = 'session-one') => {
    await act(async () => {
      root.render(h(TooltipProvider, null,
        isButton ? h(PermissionModeButton, { sessionId }) : h(PermissionsPane),
        scenario === 'button-errors' ? h(Toaster, { duration: Infinity }) : null))
    })
  }
  const changed = async () => { await act(async () => { notify() }) }
  const click = async (node: HTMLElement) => { await act(async () => { node.click() }) }
  const open = async (node: HTMLElement) => {
    await act(async () => { node.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  }
  const modeLabel = (mode: PermissionMode) => t(`permissions.mode.${mode}`)
  const trigger = () => host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!
  const select = () => host.querySelector<HTMLButtonElement>('[role="combobox"]')!
  const remove = (domain: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.getAttribute('aria-label') === t('permissions.removeHost', { host: domain }))!
  const roleItem = (role: string, label: string) => {
    const node = [...document.querySelectorAll<HTMLElement>(`[role="${role}"]`)].find((item) => item.textContent?.startsWith(label))
    assert.ok(node, `${role}: ${label}`)
    return node
  }
  const radios = (mode: PermissionMode) => {
    assert.equal(document.querySelectorAll('[role="menuitemradio"]').length, 3)
    for (const item of PERMISSION_MODES) {
      assert.equal(roleItem('menuitemradio', modeLabel(item)).getAttribute('aria-checked'), String(item === mode))
    }
  }
  const chooseDefault = async (mode: PermissionMode) => {
    await open(select())
    assert.equal(document.querySelectorAll('[role="option"]').length, 3)
    await click(roleItem('option', modeLabel(mode)))
  }
  const flushToasts = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)) }) }
  const toastText = () => [...document.querySelectorAll('[data-sonner-toast]')].map((node) => node.textContent).join('\n')

  try {
    if (scenario === 'button-modes') {
      await render(null)
      assert.equal(trigger().disabled, true)
      assert.equal(reads, 0)
      assert.equal(listeners.size, 0)
      await render()
      assert.deepEqual(sessionReads, ['session-one'])
      assert.equal(trigger().disabled, false)
      assert.equal(trigger().getAttribute('aria-label'), 'Read-only', 'use the session mode, not the global default')
      for (const mode of ['default', 'full-access', 'read-only'] as const) {
        await open(trigger())
        radios(permission.mode)
        await click(roleItem('menuitemradio', modeLabel(mode)))
        assert.deepEqual(sessionWrites.at(-1), ['session-one', mode])
        assert.equal(trigger().getAttribute('aria-label'), modeLabel(mode))
      }
      await open(trigger())
      radios('read-only')
      await click(roleItem('menuitem', t('permissions.followDefault')))
      assert.deepEqual(sessionWrites.at(-1), ['session-one', null])
      assert.equal(trigger().getAttribute('aria-label'), 'Full access')
      await open(trigger())
      radios('full-access')
      assert.equal(roleItem('menuitem', t('permissions.followDefault')).getAttribute('aria-disabled'), 'true')
    } else if (scenario === 'button-races') {
      const stale = deferred<SessionPermission>()
      readPermission = () => stale.promise
      await render()
      assert.equal(trigger().disabled, true)
      permission = { mode: 'full-access', overridden: true }
      readPermission = async () => permission
      await changed()
      assert.equal(trigger().getAttribute('aria-label'), 'Full access')
      await act(async () => { stale.resolve({ mode: 'read-only', overridden: true }) })
      assert.equal(trigger().getAttribute('aria-label'), 'Full access', 'a late initial read cannot undo the push')
      const pending = deferred<SessionPermission>()
      writePermission = () => pending.promise
      await open(trigger())
      await click(roleItem('menuitemradio', 'Read-only'))
      assert.deepEqual(sessionWrites, [['session-one', 'read-only']])
      assert.equal(trigger().getAttribute('aria-label'), 'Full access', 'a selection is not confirmed until main broadcasts')
      permission = { mode: 'default', overridden: false }
      await changed()
      await act(async () => { pending.resolve({ mode: 'read-only', overridden: true }) })
      assert.equal(trigger().getAttribute('aria-label'), 'Default', 'setter replies are not the source of truth')
      snapshot = { ...snapshot, sandbox: { state: 'unavailable', detail: 'Sandbox helper missing' } }
      await changed()
      assert.equal(trigger().getAttribute('aria-label'), `Default · ${t('permissions.sandboxOff')}`)
      await open(trigger())
      assert.ok(document.querySelector('[role="menu"]')!.textContent!.includes('Sandbox helper missing'))
    } else if (scenario === 'button-errors') {
      readPermission = async () => { throw new Error('Cannot read session permissions') }
      await render()
      await flushToasts()
      assert.match(toastText(), /Cannot read session permissions/)
      assert.equal(trigger().disabled, true)
      readPermission = async () => permission
      await changed()
      writePermission = async () => { throw new Error('Cannot save session permissions') }
      await open(trigger())
      await click(roleItem('menuitemradio', 'Full access'))
      await flushToasts()
      assert.match(toastText(), /Cannot save session permissions/)
      assert.equal(trigger().getAttribute('aria-label'), 'Read-only')
      await open(trigger())
      radios('read-only')
    } else if (scenario === 'button-partial') {
      await render()
      assert.equal(trigger().getAttribute('aria-label'), 'Read-only')
      permission = { mode: 'full-access', overridden: true }
      readSnapshot = async () => { throw new Error('Global permissions unreadable') }
      await changed()
      assert.match(trigger().getAttribute('aria-label')!, /^Full access.*Sandbox.*Global permissions unreadable/)
      assert.equal(trigger().disabled, false)
      readPermission = async () => { throw new Error('Session mode unreadable') }
      readSnapshot = async () => snapshot
      await changed()
      assert.equal(trigger().disabled, true)
      assert.match(trigger().getAttribute('aria-label')!, /Permissions.*Session mode unreadable/)
      assert.doesNotMatch(trigger().getAttribute('aria-label')!, /Full access|Read-only/)
      const pending = deferred<SessionPermission>()
      readPermission = () => pending.promise
      await changed()
      assert.equal(trigger().disabled, true)
      assert.match(trigger().getAttribute('aria-label')!, /Checking/)
      await act(async () => { pending.resolve(permission) })
      assert.equal(trigger().getAttribute('aria-label'), 'Full access')
    } else if (scenario === 'pane-state') {
      snapshot = { ...snapshot, sandbox: { state: 'unsupported', detail: 'Sandbox helper is not available here' } }
      await render()
      assert.ok(host.textContent!.includes(t('permissions.sandboxState.unsupported')))
      assert.ok(host.textContent!.includes(t('permissions.sandboxOff')))
      assert.match(host.textContent!, /Sandbox helper is not available here/)
      assert.equal(select().textContent, 'Full access')
      assert.ok(remove('global.example').parentElement!.textContent!.includes(t('permissions.allProjects')))
      const projectRow = remove('project.example').parentElement!.textContent!
      assert.match(projectRow, /project\.example/)
      assert.ok(projectRow.includes('/workspace/project'))
      assert.ok(!projectRow.includes('/.git'))
      await chooseDefault('read-only')
      assert.deepEqual(defaultWrites, ['read-only'])
      assert.equal(select().textContent, 'Read-only')
      await click(remove('project.example'))
      assert.deepEqual(removals, [['/workspace/project/.git', 'project.example']])
      assert.equal(remove('project.example'), undefined)
      assert.ok(remove('global.example'))
      await click(remove('global.example'))
      assert.deepEqual(removals.at(-1), [null, 'global.example'])
      assert.ok(host.textContent!.includes(t('permissions.noHosts')))
      snapshot = { ...snapshot, defaultMode: 'default', sandbox: { state: 'ready' } }
      await changed()
      assert.equal(select().textContent, 'Default')
      assert.ok(host.textContent!.includes(t('permissions.sandboxState.ready')))
    } else if (scenario === 'pane-errors') {
      readSnapshot = async () => { throw new Error('Permissions storage is unreadable') }
      await render()
      assert.match(host.querySelector('[role="alert"]')!.textContent!, /Permissions storage is unreadable/)
      assert.equal(select(), null)
      readSnapshot = async () => snapshot
      await changed()
      const pending = deferred<PermissionsSnapshot>()
      writeDefault = () => pending.promise
      await chooseDefault('read-only')
      assert.equal(select().disabled, true)
      assert.equal(remove('global.example').disabled, true)
      assert.equal(select().textContent, 'Full access', 'do not show the requested mode before saving')
      await act(async () => { pending.reject(new Error('Default mode could not be saved')) })
      assert.match(host.querySelector('[role="alert"]')!.textContent!, /Default mode could not be saved/)
      assert.equal(select().textContent, 'Full access')
      assert.equal(select().disabled, false)
      const successfulRemove = removeDomain
      removeDomain = async () => { throw new Error('Domain removal was denied') }
      await click(remove('project.example'))
      assert.match(host.querySelector('[role="alert"]')!.textContent!, /Domain removal was denied/)
      assert.equal(remove('project.example').disabled, false)
      assert.ok(host.textContent!.includes('project.example'), 'failed removal must leave the domain visible')
      removeDomain = successfulRemove
      await click(remove('project.example'))
      assert.equal(remove('project.example'), undefined)
      assert.equal(host.querySelector('[role="alert"]'), null)
    } else if (scenario === 'pane-races') {
      const stale = deferred<PermissionsSnapshot>()
      const original = snapshot
      readSnapshot = () => stale.promise
      await render()
      snapshot = { ...snapshot, defaultMode: 'read-only', sandbox: { state: 'unavailable', detail: 'Updated sandbox status' } }
      readSnapshot = async () => snapshot
      await changed()
      await act(async () => { stale.resolve(original) })
      assert.equal(select().textContent, 'Read-only')
      assert.match(host.textContent!, /Updated sandbox status/)
      const pending = deferred<PermissionsSnapshot>()
      removeDomain = () => pending.promise
      await click(remove('global.example'))
      assert.equal(remove('global.example').disabled, true, 'the domain remains while removal is pending')
      snapshot = { defaultMode: 'default', domains: ['newer.example'], projects: [], mcp: {}, sandbox: { state: 'ready' } }
      await changed()
      await act(async () => { pending.resolve({ ...original, domains: [] }) })
      assert.equal(select().textContent, 'Default')
      assert.ok(remove('newer.example'), 'a late mutation reply must not discard the pushed domains')
      assert.equal(remove('project.example'), undefined)
      assert.equal(select().disabled, false)
    }
  } finally {
    await act(async () => { root.unmount() })
    assert.equal(listeners.size, 0, 'unmount unsubscribes from permission changes')
    host.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv.includes('--fixture')) await fixture(process.argv[process.argv.indexOf('--fixture') + 1] as Scenario)
else for (const [scenario, description] of Object.entries(scenarios)) {
  test(description, async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--fixture', scenario], { stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => child.kill(), 10000)
    try {
      const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      assert.equal(code, 0, errors || output)
    } finally { clearTimeout(timer); child.kill() }
  }, 12000)
}
