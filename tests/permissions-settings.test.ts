/** The built-in settings mutation gate: identity, mode, one-shot approval and safe card contents. */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from 'bun:test'
import { getEventListeners } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PermissionMode } from '../src/shared/permissions'
import type { SettingsAgentHost } from '../src/shared/settings'

mock.module('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))

const store = await import('../src/main/permissions/store')
const root = mkdtempSync(join(tmpdir(), 'pig-settings-permissions-'))
const previousPigDir = process.env.PIG_DIR
const sessionId = 'settings-test'
const revision = 'a'.repeat(64)
const path = join(process.cwd(), 'src/main/plugins/pig-settings/index.ts')
type Handler = (event: any, ctx: any) => Promise<any>

beforeAll(() => { process.env.PIG_DIR = root })
beforeEach(() => { rmSync(root, { recursive: true, force: true }); mkdirSync(root) })
afterAll(() => {
  if (previousPigDir === undefined) delete process.env.PIG_DIR
  else process.env.PIG_DIR = previousPigDir
  rmSync(root, { recursive: true, force: true })
})

async function setup(initialMode: PermissionMode | null = 'default', source = path, mode?: () => PermissionMode) {
  const { default: settings } = await import('../src/main/plugins/pig-settings/index')
  const { permissionsExtension } = await import('../src/main/permissions/extension')
  const definitions = new Map<string, any>()
  settings({ registerTool: (tool: any) => definitions.set(tool.name, tool), on: () => {} } as never)
  const builtin = definitions.get('settings_update')
  await store.saveSessionPermission(sessionId, initialMode)
  const tools = new Map<string, any>([['settings_update', { ...builtin, sourceInfo: { path: source } }]])
  const handlers = new Map<string, Handler>()
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, { ...tool, sourceInfo: { path: '<inline:permissions>' } }),
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    getAllTools: () => [...tools.values()], getActiveTools: () => [...tools.keys()], setActiveTools: () => {}
  }
  permissionsExtension({ cwd: process.cwd(), sessionId, mode: mode ?? (() => store.sessionPermission(sessionId).mode), settingsManager: {
    getShellPath: () => undefined, getShellCommandPrefix: () => undefined
  } as never })(pi as never)
  const asked: Array<{ title: string; choices: string[]; message: string }> = []
  let answer = 0
  const ctx = { hasUI: true, ui: { select: async (title: string, choices: string[], options: any) => {
    asked.push({ title, choices, message: options.approval.message })
    return choices[answer]
  } } }
  return {
    call: (input: unknown, context: any = ctx) => handlers.get('tool_call')!({ toolName: 'settings_update', input }, context),
    prompt: () => { const event = { systemPromptOptions: { sections: {} as Record<string, string> } }; handlers.get('before_agent_start')!(event, ctx); return event.systemPromptOptions.sections.permissions },
    asked, setAnswer: (index: number) => { answer = index }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function pendingApproval(upstream?: AbortSignal) {
  const entered = deferred<void>()
  const answer = deferred<string | undefined>()
  let choices: string[] = []
  let signal!: AbortSignal
  return {
    context: { hasUI: true, signal: upstream, ui: { select: (_title: string, options: string[], opts: { signal: AbortSignal }) => {
      choices = options
      signal = opts.signal
      entered.resolve(undefined)
      return answer.promise
    } } },
    entered: entered.promise,
    signal: () => signal,
    allow: () => answer.resolve(choices[0])
  }
}

const update = (group: string, patch: object) => ({ group, patch, expectedRevision: revision })

test('the SDK-loaded built-in path and schema pass the identity and display checks', async () => {
  const { createNoExtensionsResourceLoader } = await import('../src/main/pi/chat-resources')
  const { isSettingsToolPath, settingsApproval } = await import('../src/main/permissions/settings')
  const loader = await createNoExtensionsResourceLoader(process.cwd(), [path])
  expect(loader.getExtensions().errors).toEqual([])
  const extension = loader.getExtensions().extensions.find((item) => item.path === path)!
  const tool = extension.tools.get('settings_update')!
  expect(isSettingsToolPath(tool.sourceInfo.path)).toBe(true)
  const shown = await settingsApproval(update('general', { locale: 'en' }), tool.definition.parameters, 'settings-test')
  expect(shown.patch).toContain('"locale": "en"')
})

test('default asks every time, shows the exact patch without revision, and only offers once or deny', async () => {
  const gate = await setup()
  const input = update('mcp', { enabled: { docs: true, other: false } })
  expect(await gate.call(input)).toBeUndefined()
  expect(await gate.call(input)).toBeUndefined()
  expect(gate.asked).toHaveLength(2)
  const card = gate.asked[0]!
  expect(card.choices).toHaveLength(2)
  expect(card.message).toContain('mcp')
  expect(card.message).toContain('"docs": true')
  expect(card.message).toContain('"other": false')
  expect(card.message).not.toContain(revision)
  gate.setAnswer(1)
  await expect(gate.call(input)).rejects.toThrow('did not allow')
  await expect(gate.call(input, { hasUI: false })).rejects.toThrow('cannot ask')
  expect(gate.prompt()).toContain('separate user approval')
})

test('plugin approval shows the display name, ID and exact scopes', async () => {
  const { registerSettingsAgentHost } = await import('../src/main/plugins/pig-settings-host')
  const slot = globalThis as Record<symbol, SettingsAgentHost | undefined>
  const key = Symbol.for('pig:settings-agent-host')
  const previous = slot[key]
  registerSettingsAgentHost({ list: async () => ({ plugins: [{ id: 'web', name: 'Web Access' }] }) } as unknown as SettingsAgentHost)
  try {
    const gate = await setup()
    await gate.call(update('plugins', { scopes: { web: ['project', 'chat'] } }))
    expect(gate.asked[0]!.message).toContain('"web": "Web Access"')
    expect(gate.asked[0]!.message).toContain('"project"')
    expect(gate.asked[0]!.message).toContain('"chat"')
    await gate.call(update('plugins', { scopes: { web: [] } }))
    expect(gate.asked[1]!.message).toContain('"web": []')
    await expect(gate.call(update('plugins', { scopes: { unknown: [] } }))).rejects.toThrow('plugin name')
  } finally { slot[key] = previous }
})

test('read-only refuses without asking and full access skips approval', async () => {
  const input = update('general', { locale: 'en' })
  const readOnly = await setup('read-only')
  expect((await readOnly.call(input)).block).toBe(true)
  expect(readOnly.asked).toHaveLength(0)
  expect(readOnly.prompt()).toContain('refused in read-only')
  const full = await setup('full-access')
  expect(await full.call(input)).toBeUndefined()
  expect(full.asked).toHaveLength(0)
})

test('a pending approval is cancelled immediately on mode change and cannot be restored by switching back', async () => {
  for (const next of ['read-only', 'full-access'] as const) {
    const gate = await setup()
    const upstream = new AbortController()
    const prompt = pendingApproval(upstream.signal)
    const pending = gate.call(update('general', { locale: 'en' }), prompt.context)
    const outcome = pending.then(() => 'allowed', (error: unknown) => error)
    await prompt.entered
    expect(getEventListeners(upstream.signal, 'abort')).toHaveLength(1)
    const toNext = store.saveSessionPermission(sessionId, next)
    const backToDefault = store.saveSessionPermission(sessionId, 'default')
    await toNext
    expect(prompt.signal().aborted).toBe(true)
    await backToDefault
    expect(await outcome).toMatchObject({ message: 'Permission mode changed; request the settings update again' })
    expect(store.sessionPermission(sessionId).mode).toBe('default')
    expect(getEventListeners(upstream.signal, 'abort')).toHaveLength(0)
    expect(getEventListeners(prompt.signal(), 'abort')).toHaveLength(0)
    prompt.allow()
    await Promise.resolve()
    expect(await outcome).not.toBe('allowed')
  }
})

test('unrelated permission updates do not cancel, and approval listeners end before later changes', async () => {
  const gate = await setup(null)
  const upstream = new AbortController()
  const prompt = pendingApproval(upstream.signal)
  const pending = gate.call(update('general', { locale: 'en' }), prompt.context)
  await prompt.entered
  await store.saveSessionPermission('another-session', 'read-only')
  await store.saveSessionPermission(sessionId, 'default')
  await store.updatePermissionSettings(current => ({ ...current, domains: ['example.com'], defaultMode: 'read-only' }))
  expect(store.sessionPermission(sessionId)).toEqual({ mode: 'default', overridden: true })
  expect(prompt.signal().aborted).toBe(false)
  prompt.allow()
  await expect(pending).resolves.toBeUndefined()
  expect(getEventListeners(upstream.signal, 'abort')).toHaveLength(0)
  expect(getEventListeners(prompt.signal(), 'abort')).toHaveLength(0)
  await store.saveSessionPermission(sessionId, 'read-only')
  await store.updatePermissionSettings(current => ({ ...current, mcp: { docs: 'prompt' } }))
  upstream.abort(new Error('after authorization'))
  expect(store.readPermissionSettings().mcp).toEqual({ docs: 'prompt' })
  expect(prompt.signal().aborted).toBe(false)
})

test('a global default change cancels an approval only when the session inherits it', async () => {
  const gate = await setup(null)
  const prompt = pendingApproval()
  const pending = gate.call(update('general', { locale: 'en' }), prompt.context)
  const outcome = pending.then(() => 'allowed', (error: unknown) => error)
  await prompt.entered
  await store.updatePermissionSettings(current => ({ ...current, domains: ['example.com'] }))
  expect(prompt.signal().aborted).toBe(false)
  await store.updatePermissionSettings(current => ({ ...current, defaultMode: 'read-only' }))
  expect(prompt.signal().aborted).toBe(true)
  expect(await outcome).toMatchObject({ message: 'Permission mode changed; request the settings update again' })
  prompt.allow()
})

test('an upstream abort dismisses the pending request and cleans its listeners', async () => {
  const gate = await setup()
  const upstream = new AbortController()
  const prompt = pendingApproval(upstream.signal)
  const pending = gate.call(update('general', { locale: 'en' }), prompt.context)
  const outcome = pending.then(() => 'allowed', (error: unknown) => error)
  await prompt.entered
  const reason = new Error('user stopped')
  upstream.abort(reason)
  expect(prompt.signal().reason).toBe(reason)
  expect(await outcome).toBe(reason)
  expect(getEventListeners(upstream.signal, 'abort')).toHaveLength(0)
  expect(getEventListeners(prompt.signal(), 'abort')).toHaveLength(0)
  prompt.allow()
})

test('a denied or already-aborted request cleans listeners without affecting later changes', async () => {
  const gate = await setup()
  const upstream = new AbortController()
  let approvalSignal!: AbortSignal
  const context = { hasUI: true, signal: upstream.signal, ui: { select: async (_title: string, choices: string[], opts: { signal: AbortSignal }) => {
    approvalSignal = opts.signal
    return choices.at(-1)
  } } }
  await expect(gate.call(update('general', { locale: 'en' }), context)).rejects.toThrow('did not allow')
  expect(getEventListeners(upstream.signal, 'abort')).toHaveLength(0)
  await store.saveSessionPermission(sessionId, 'read-only')
  upstream.abort(new Error('after denial'))
  expect(approvalSignal.aborted).toBe(false)

  await store.saveSessionPermission(sessionId, 'default')
  const stopped = new AbortController()
  stopped.abort(new Error('already stopped'))
  const prompt = pendingApproval(stopped.signal)
  await expect(gate.call(update('general', { locale: 'en' }), prompt.context)).rejects.toThrow('already stopped')
  expect(prompt.signal()).toBeUndefined()
  expect(getEventListeners(stopped.signal, 'abort')).toHaveLength(0)
})

test('the mode is checked again after subscribing, before displaying an approval', async () => {
  let reads = 0
  const gate = await setup('default', path, () => reads++ === 0 ? 'default' : 'read-only')
  await expect(gate.call(update('general', { locale: 'en' }))).rejects.toThrow('Permission mode changed')
  expect(gate.asked).toHaveLength(0)
})

test('a mode change during the async plugin catalog lookup cannot create a stale approval', async () => {
  const { registerSettingsAgentHost } = await import('../src/main/plugins/pig-settings-host')
  const slot = globalThis as Record<symbol, SettingsAgentHost | undefined>
  const key = Symbol.for('pig:settings-agent-host')
  const previous = slot[key]
  const entered = deferred<void>()
  const catalog = deferred<{ plugins: { id: string; name: string }[] }>()
  registerSettingsAgentHost({ list: () => { entered.resolve(undefined); return catalog.promise } } as unknown as SettingsAgentHost)
  try {
    const gate = await setup()
    const pending = gate.call(update('plugins', { scopes: { web: ['project'] } }))
    const outcome = pending.then(() => 'allowed', (error: unknown) => error)
    await entered.promise
    await store.saveSessionPermission(sessionId, 'read-only')
    expect(await outcome).toMatchObject({ message: 'Permission mode changed; request the settings update again' })
    await store.saveSessionPermission(sessionId, 'default')
    catalog.resolve({ plugins: [{ id: 'web', name: 'Web Access' }] })
    await Promise.resolve()
    await Promise.resolve()
    expect(gate.asked).toHaveLength(0)
  } finally { slot[key] = previous }
})

test('a same-name replacement is blocked rather than trusted in restricted modes', async () => {
  for (const mode of ['default', 'read-only'] as const) {
    const fake = await setup(mode, '/other/pig-settings/index.ts')
    expect((await fake.call(update('general', { locale: 'en' }))).reason).toContain('replaced')
    expect(fake.asked).toHaveLength(0)
  }
  expect(await (await setup('full-access', '/other/index.ts')).call({})).toBeUndefined()
})

test('invalid or unrepresentable patches are refused without showing sensitive fields or partial changes', async () => {
  const gate = await setup()
  await expect(gate.call(update('mcp', { enabled: { docs: true }, token: 'secret' }))).rejects.toThrow('Invalid settings')
  await expect(gate.call(update('mcp', { enabled: { ['name\u202eevil']: true } }))).rejects.toThrow('safely displayed')
  await expect(gate.call(update('mcp', { enabled: { ['name\u2028forged']: true } }))).rejects.toThrow('safely displayed')
  const large = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`server-${i}-${'x'.repeat(40)}`, true]))
  await expect(gate.call(update('mcp', { enabled: large }))).rejects.toThrow('too large')
  expect(gate.asked).toHaveLength(0)
})
