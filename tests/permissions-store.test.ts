import { afterAll, beforeAll, beforeEach, expect, mock, test } from 'bun:test'

mock.module('electron', () => ({ app: { isPackaged: false } }))
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Store = typeof import('../src/main/permissions/store')
const root = mkdtempSync(join(tmpdir(), 'pig-permissions-store-'))
const previousPigDir = process.env.PIG_DIR
let store: Store

beforeAll(async () => {
  process.env.PIG_DIR = root
  store = await import('../src/main/permissions/store')
})

beforeEach(() => {
  rmSync(join(root, 'permissions.json'), { force: true })
  rmSync(join(root, 'session-permissions'), { recursive: true, force: true })
})

afterAll(() => {
  if (previousPigDir === undefined) delete process.env.PIG_DIR
  else process.env.PIG_DIR = previousPigDir
  rmSync(root, { recursive: true, force: true })
})

test('sessions follow the default mode until they choose their own, and forks keep it', async () => {
  const changes: number[] = []
  const unsubscribe = store.onPermissionsChanged(() => changes.push(1))
  expect(store.sessionPermission('one')).toEqual({ mode: 'default', overridden: false })
  await store.updatePermissionSettings((current) => ({ ...current, defaultMode: 'read-only' }))
  expect(store.sessionPermission('one')).toEqual({ mode: 'read-only', overridden: false })
  await store.saveSessionPermission('one', 'full-access')
  expect(store.sessionPermission('one')).toEqual({ mode: 'full-access', overridden: true })
  await store.copySessionPermission('one', 'two')
  await store.copySessionPermission('none', 'three')
  expect(store.sessionPermission('two').mode).toBe('full-access')
  expect(existsSync(join(root, 'session-permissions', 'three.json'))).toBe(false)
  await store.removeSessionPermission('one')
  expect(store.sessionPermission('one').overridden).toBe(false)
  expect(changes).toHaveLength(2)
  await Promise.all([store.saveSessionPermission('two', null), store.saveSessionPermission('two', 'read-only')])
  expect(store.sessionPermission('two').mode).toBe('read-only')
  unsubscribe()
  if (process.platform !== 'win32') expect(statSync(join(root, 'permissions.json')).mode & 0o777).toBe(0o600)
})

test('fork inheritance waits for a previously queued mode save', async () => {
  await store.saveSessionPermission('source', 'full-access')
  const saving = store.saveSessionPermission('source', 'read-only')
  expect(store.sessionPermission('source').mode).toBe('full-access')
  const copying = store.copySessionPermission('source', 'fork')
  await Promise.all([saving, copying])
  expect(store.sessionPermission('fork')).toEqual({ mode: 'read-only', overridden: true })
})

test('fork inheritance rejects damaged sidecars and the queue remains usable', async () => {
  await store.saveSessionPermission('broken', 'read-only')
  writeFileSync(join(root, 'session-permissions', 'broken.json'), '{')
  await expect(store.copySessionPermission('broken', 'fork')).rejects.toThrow()
  expect(existsSync(join(root, 'session-permissions', 'fork.json'))).toBe(false)
  await store.saveSessionPermission('healthy', 'read-only')
  await store.copySessionPermission('healthy', 'fork')
  expect(store.sessionPermission('fork').mode).toBe('read-only')
})

test('concurrent host approvals both land, and empty projects are not stored', async () => {
  const add = (host: string) => store.updatePermissionSettings((current) => {
    const project = current.projects.find((entry) => entry.root === '/repo/.git')
    return { ...current, projects: [...current.projects.filter((entry) => entry !== project), { root: '/repo/.git', domains: [...(project?.domains ?? []), host] }] }
  })
  await Promise.all([add('a.example'), add('b.example')])
  expect(store.projectDomains(store.readPermissionSettings(), '/repo/.git')).toEqual(['a.example', 'b.example'])
  await store.updatePermissionSettings((current) => ({ ...current, projects: [{ root: '/repo/.git', domains: [] }] }))
  expect(store.readPermissionSettings().projects).toEqual([])
})

test('project approval aborted while queued never reaches disk', async () => {
  const { offerHosts } = await import('../src/main/permissions/approval')
  const abort = new AbortController()
  const unsubscribe = store.onPermissionsChanged(() => abort.abort(new Error('Approval cancelled')))
  // Removing a sidecar holds the shared mutation queue across an asynchronous filesystem step.
  const blocker = store.saveSessionPermission('blocker', null)
  const approval = offerHosts({ select: async (_title, choices) => choices[1] }, 'one', ['queued.example'], '/repo/.git', abort.signal)
  try {
    await expect(approval).rejects.toThrow('Approval cancelled')
    await blocker
    expect(existsSync(join(root, 'permissions.json'))).toBe(false)
  } finally { unsubscribe() }
})

test('approval cancellation differs from user refusal and never grants permission', async () => {
  const { offerHosts } = await import('../src/main/permissions/approval')
  const cancelled = await offerHosts({ select: async () => undefined }, 'one', ['cancel.example'], '/repo/.git')
  expect(cancelled).toContain('was cancelled; no permission was granted')
  expect(cancelled).not.toContain('The user did not allow')
  const denied = await offerHosts({ select: async (_title, choices) => choices.at(-1) }, 'one', ['deny.example'], '/repo/.git')
  expect(denied).toContain('The user did not allow')
  expect(existsSync(join(root, 'permissions.json'))).toBe(false)
})

test('approval already written is not rolled back on abort', async () => {
  const { offerHosts } = await import('../src/main/permissions/approval')
  const abort = new AbortController()
  const unsubscribe = store.onPermissionsChanged(() => abort.abort())
  try {
    const result = await offerHosts({ select: async (_title, choices) => choices[1] }, 'one', ['saved.example'], '/repo/.git', abort.signal)
    expect(result).toContain('The user allowed')
    expect(store.projectDomains(store.readPermissionSettings(), '/repo/.git')).toEqual(['saved.example'])
  } finally { unsubscribe() }
})

test('a damaged file is an error, never a looser default', () => {
  for (const content of ['{', '[]', '{"version":1,"defaultMode":"yolo","domains":[],"projects":{}}', '{"version":1,"defaultMode":"default","domains":["https://x"],"projects":{}}']) {
    writeFileSync(join(root, 'permissions.json'), content)
    expect(() => store.readPermissionSettings()).toThrow()
    expect(() => store.sessionPermission('one')).toThrow()
  }
  expect(() => store.sessionPermission('../escape')).toThrow(/Invalid session id/)
})
