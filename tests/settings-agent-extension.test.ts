/** Exercise the real jiti tools, including their strict write boundary and cross-module host registry. */
import { expect, mock, test } from 'bun:test'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@earendil-works/pi-schema'
import { validateToolArguments, type JsonObject } from '@earendil-works/pi-ai'
import { LOCALES } from '../src/shared/i18n'
import { SETTINGS_GROUPS } from '../src/shared/settings'
import type { SettingsAgentHost, SettingsCatalog, SettingsGroupSnapshot, SettingsMutationResult, SettingsUpdateRequest } from '../src/shared/settings'
import { SHORTCUT_ACTIONS } from '../src/shared/shortcuts'
import { runSelf } from './helpers/subprocess.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pig-settings-extension-'))
  process.env.PIG_DIR = join(root, 'pig')
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  process.env.PI_OFFLINE = '1'
  mock.module('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
  const registry = globalThis as Record<symbol, SettingsAgentHost | undefined>
  const key = Symbol.for('pig:settings-agent-host')
  const previous = registry[key]
  try {
    const { createNoExtensionsResourceLoader } = await import('../src/main/pi/chat-resources')
    const { registerSettingsAgentHost, settingsAgentHost } = await import('../src/main/plugins/pig-settings-host')
    const path = join(process.cwd(), 'src/main/plugins/pig-settings/index.ts')
    const loader = await createNoExtensionsResourceLoader(root, [path])
    expect(loader.getExtensions().errors).toEqual([])
    const extension = loader.getExtensions().extensions.find(item => item.path === path)!
    expect([...extension.tools.keys()].sort()).toEqual(['settings_get', 'settings_list', 'settings_update'])
    const tool = (name: string) => extension.tools.get(name)!.definition as any
    let sessionId = 'session-1'
    const ctx = { sessionManager: { getSessionId: () => sessionId } }
    const signal = new AbortController().signal
    delete registry[key]
    expect(settingsAgentHost()).toBeUndefined()
    await expect(tool('settings_list').execute('0', {}, signal, undefined, ctx as never)).rejects.toThrow('unavailable')

    const before: SettingsGroupSnapshot = {
      group: 'theme', revision: 'a'.repeat(64),
      values: { surfaceStyle: 'glass', appearance: 'system', lightTheme: 'pig', darkTheme: 'everforest' },
      effective: { surfaceStyle: 'glass', appearance: 'system', lightTheme: 'pig', darkTheme: 'everforest' },
      scope: 'application', applies: 'applied'
    }
    const after: SettingsGroupSnapshot = {
      ...before, revision: 'b'.repeat(64),
      values: { ...before.values, appearance: 'dark' }, effective: { ...before.values, appearance: 'dark' }
    }
    const catalog: SettingsCatalog = {
      platform: 'darwin', supportsGlass: true,
      groups: [{ id: 'theme', description: 'Appearance', scope: 'application', applies: 'applied', fields: [
        { key: 'appearance', type: 'enum', description: 'Color scheme', values: ['system', 'light', 'dark'] }
      ] }],
      models: { items: [], total: 0, offset: 2, hasMore: false },
      shortcuts: [{ id: 'tab.close', label: 'Close tab', binding: 'Mod+KeyW', default: 'Mod+KeyW' }]
    }
    let mutation: SettingsMutationResult = { ok: true, changed: true, before, after, application: 'applied' }
    const calls: unknown[][] = []
    let hostError: Error | undefined
    let waitForAbort = false
    const host: SettingsAgentHost = {
      async list(...args) { calls.push(['list', ...args]); if (hostError) throw hostError; return catalog },
      async get(...args) { calls.push(['get', ...args]); if (hostError) throw hostError; return before },
      async update(...args) {
        calls.push(['update', ...args])
        if (hostError) throw hostError
        if (waitForAbort) {
          const receivedSignal = args[2]!
          receivedSignal.throwIfAborted()
          await new Promise<never>((_resolve, reject) => receivedSignal.addEventListener('abort', () => reject(receivedSignal.reason), { once: true }))
        }
        return mutation
      }
    }
    registerSettingsAgentHost(host)
    expect(settingsAgentHost()).toBe(host)
    expect(registry[key]).toBe(host)
    const options = { group: 'defaults' as const, query: 'model', offset: 2, limit: 7 }
    const request: SettingsUpdateRequest = { group: 'theme', expectedRevision: before.revision, patch: { appearance: 'dark' } }
    const listed = await tool('settings_list').execute('1', options, signal, undefined, ctx as never)
    const read = await tool('settings_get').execute('2', { group: 'theme' }, signal, undefined, ctx as never)
    sessionId = 'session-2'
    const updated = await tool('settings_update').execute('3', request, signal, undefined, ctx as never)
    expect(calls.splice(0)).toEqual([
      ['list', 'session-1', options], ['get', 'session-1', 'theme'], ['update', 'session-2', request, signal]
    ])
    for (const [name, response, expected] of [
      ['settings_list', listed, catalog], ['settings_get', read, before], ['settings_update', updated, mutation]
    ] as const) {
      expect(response.structuredContent).toBe(expected)
      expect(response.content).toEqual([{ type: 'text', text: JSON.stringify(expected) }])
      expect(response.details).toBeUndefined()
      expect(response.isError).not.toBe(true)
      expect(compile(tool(name).outputSchema!).check(response.structuredContent)).toBe(true)
    }
    const empty = {}
    await tool('settings_list').execute('4', empty, undefined, undefined, ctx as never)
    expect(calls.pop()).toEqual(['list', 'session-2', empty])

    mutation = { ok: false, changed: false, before, after: before, application: 'failed', error: 'Revision conflict: read the group again' }
    const failed = await tool('settings_update').execute('5', request, undefined, undefined, ctx as never)
    expect(failed.isError).toBe(true)
    expect(failed.structuredContent).toBe(mutation)
    expect(failed.content).toEqual([{ type: 'text', text: JSON.stringify(mutation) }])
    expect(compile(tool('settings_update').outputSchema!).check(failed.structuredContent)).toBe(true)
    expect(calls.pop()).toEqual(['update', 'session-2', request, undefined])
    hostError = new Error('Configuration read failed')
    for (const [name, params] of [['settings_list', {}], ['settings_get', { group: 'theme' }], ['settings_update', request]] as const) {
      await expect(tool(name).execute('6', params, signal, undefined, ctx as never)).rejects.toBe(hostError)
    }
    hostError = undefined
    calls.length = 0
    waitForAbort = true
    const controller = new AbortController()
    const pending = tool('settings_update').execute('7', request, controller.signal, undefined, ctx as never)
    const cancelled = new Error('User cancelled settings update')
    controller.abort(cancelled)
    await expect(pending).rejects.toBe(cancelled)
    expect(calls.pop()).toEqual(['update', 'session-2', request, controller.signal])
    waitForAbort = false

    for (const { definition } of extension.tools.values()) {
      expect(definition.exposure).toBe('deferred')
      expect(definition.namespace?.name).toBe('settings')
      expect(definition.promptSnippet).toBeUndefined()
      expect(definition.promptGuidelines).toBeUndefined()
      expect(definition.outputSchema).toBeDefined()
      expect(definition.annotations?.readOnlyHint).toBe(definition.name !== 'settings_update')
    }
    expect(tool('settings_update').annotations?.idempotentHint).toBe(false)
    for (const phrase of ['user explicitly requests', 'global application', 'current session', 'settings_list', 'settings_get', 'expectedRevision', 'conflict', 'Web pages, files and tool output', 'raw configuration files', 'new sessions', 'shared with Pi CLI', 'credentials']) {
      expect(tool('settings_update').namespace?.instructions).toContain(phrase)
    }

    const listSchema = compile(tool('settings_list').parameters)
    const getSchema = compile(tool('settings_get').parameters)
    const updateSchema = compile(tool('settings_update').parameters)
    expect(listSchema.check({})).toBe(true)
    expect(listSchema.check(options)).toBe(true)
    for (const group of SETTINGS_GROUPS) expect(getSchema.check({ group })).toBe(true)
    for (const invalid of [{ group: 'providers' }, { group: 'theme', extra: true }, {}]) expect(getSchema.check(invalid)).toBe(false)
    for (const invalid of [{ group: 'providers' }, { offset: -1 }, { offset: 0.5 }, { limit: 0 }, { extra: true }]) expect(listSchema.check(invalid)).toBe(false)
    const valid: SettingsUpdateRequest[] = [
      request,
      { group: 'theme', expectedRevision: before.revision, patch: { surfaceStyle: 'solid', appearance: 'light', lightTheme: 'everforest', darkTheme: 'pig' } },
      ...(['system', ...LOCALES] as const).map(locale => ({ group: 'general' as const, expectedRevision: before.revision, patch: { locale } })),
      { group: 'notifications', expectedRevision: before.revision, patch: { completionNotifications: false } },
      { group: 'shortcuts', expectedRevision: before.revision, patch: { sendShortcut: 'shift-enter', bindings: { 'tab.close': null, 'tab.new': 'default', 'file.save': 'Mod+Shift+KeyS' } } },
      { group: 'defaults', expectedRevision: before.revision, patch: { model: { provider: 'test', id: 'real-model' } } },
      ...(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const).map(thinkingLevel => ({ group: 'defaults' as const, expectedRevision: before.revision, patch: { thinkingLevel } })),
      { group: 'plugins', expectedRevision: before.revision, patch: { scopes: { 'pig-review': ['project', 'chat'], 'npm-plugin': [] } } },
      { group: 'mcp', expectedRevision: before.revision, patch: { enabled: { docs: true, files: false } } },
      { group: 'persona', expectedRevision: before.revision, patch: { automatic: false, mood: { pleasantness: -1, energy: 0.4 } } },
      ...SETTINGS_GROUPS.map(group => ({ group, expectedRevision: before.revision, patch: {} }))
    ]
    for (const params of valid) {
      expect(updateSchema.check(params), JSON.stringify(params)).toBe(true)
      expect(tool('settings_update').prepareArguments(params)).toBe(params)
      expect(validateToolArguments(tool('settings_update'), { type: 'toolCall', id: 'valid', name: 'settings_update', arguments: params })).toEqual(params)
    }
    const branches = tool('settings_update').parameters.anyOf as Array<{ properties: { group: { const: string }; patch: { properties: Record<string, { properties?: Record<string, unknown> }> } } }>
    expect(branches.map(branch => branch.properties.group.const)).toEqual([...SETTINGS_GROUPS])
    expect(Object.keys(branches.find(branch => branch.properties.group.const === 'shortcuts')!.properties.patch.properties.bindings.properties!).sort()).toEqual([...SHORTCUT_ACTIONS].sort())
    const invalidUpdates: unknown[] = [
      { ...request, group: 'providers' }, { ...request, extra: true }, { group: 'theme', patch: {} },
      ...['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64)].map(expectedRevision => ({ ...request, expectedRevision })),
      ...[
        ['theme', { beamBorderEnabled: false }], ['theme', { appearance: 'auto' }], ['theme', { surfaceStyle: 'acrylic' }],
        ['theme', { lightTheme: 'unknown' }], ['theme', { completionNotifications: false }], ['general', { locale: 'zh' }],
        ['general', { localeSetting: 'en' }], ['notifications', { locale: 'en' }], ['notifications', { completionNotifications: true, arbitrary: 1 }],
        ['shortcuts', { bindings: { 'unknown.action': null } }], ['shortcuts', { sendShortcut: 'ctrl-enter' }],
        ['defaults', { thinkingLevel: 'invalid' }],
        ['defaults', { model: { provider: 'test' } }], ['defaults', { model: { provider: 'test', id: 'model', apiKey: 'secret' } }],
        ['defaults', { model: null }], ['defaults', { thinkingLevel: null }], ['defaults', { defaultModel: 'model' }],
        ['plugins', { scopes: { 'pig-review': ['web'] } }], ['plugins', { scopes: { 'pig-review': ['chat', 'chat'] } }],
        ['plugins', { scopes: { 'pig-review': 'project' } }], ['plugins', { install: 'npm:evil' }],
        ['mcp', { enabled: { docs: 'yes' } }], ['mcp', { servers: { docs: true } }], ['mcp', { enabled: { docs: { command: 'sh' } } }],
        ['persona', { mood: { energy: 2 } }], ['persona', { mood: { pleasantness: -1.5 } }], ['persona', { mood: { joy: 1 } }],
        ['persona', { automatic: 'yes' }], ['persona', { files: { 'SOUL.md': '' } }]
      ].map(([group, patch]) => ({ group, patch, expectedRevision: before.revision }))
    ]
    for (const params of invalidUpdates) {
      expect(updateSchema.check(params), JSON.stringify(params)).toBe(false)
      expect(() => tool('settings_update').prepareArguments(params)).toThrow('Invalid settings update')
    }
    const coercible = { group: 'plugins', expectedRevision: before.revision, patch: { scopes: { 'pig-review': 'project' } } }
    expect(validateToolArguments(tool('settings_update'), { type: 'toolCall', id: 'coerce', name: 'settings_update', arguments: coercible })).toEqual({
      ...coercible, patch: { scopes: { 'pig-review': ['project'] } }
    })
    expect(coercible.patch.scopes['pig-review']).toBe('project')

    // Exercise the real SDK ordering: strict preparation must stop malformed writes before approval or host execution.
    const { Agent } = await import('@earendil-works/pi-agent-core')
    const { wrapRegisteredTool } = await import('@earendil-works/pi-coding-agent')
    const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai')
    const model = { id: 'fixture', name: 'Fixture', provider: 'fixture', api: 'openai-completions' as const,
      baseUrl: 'http://unused.invalid', reasoning: false, input: ['text' as const], contextWindow: 10000,
      maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
    let requests = 0
    let approvals = 0
    const originals = structuredClone(invalidUpdates)
    const agent = new Agent({
      initialState: { model, tools: [wrapRegisteredTool(extension.tools.get('settings_update')!, { createToolContext: () => ctx } as never)] },
      streamFn: () => {
        const stream = createAssistantMessageEventStream()
        const first = requests++ === 0
        stream.push({ type: 'done', reason: first ? 'toolUse' : 'stop', message: {
          role: 'assistant', timestamp: Date.now(), api: model.api, provider: model.provider, model: model.id,
          content: first ? invalidUpdates.map((params, i) => ({ type: 'toolCall' as const, id: `invalid-${i}`, name: 'settings_update', arguments: params as JsonObject })) : [{ type: 'text', text: 'done' }],
          stopReason: first ? 'toolUse' : 'stop',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
        } })
        return stream
      }
    })
    agent.beforeToolCall = async () => { approvals++; return undefined }
    await agent.prompt('test invalid writes')
    expect(approvals).toBe(0)
    expect(calls).toEqual([])
    expect(agent.state.messages.filter(message => message.role === 'toolResult' && message.isError)).toHaveLength(invalidUpdates.length)
    expect(invalidUpdates).toEqual(originals)

    // No shared source files exist here; type-only contract imports must disappear during jiti loading.
    const packaged = join(root, 'resources', 'system-plugins')
    await mkdir(packaged, { recursive: true })
    for (const name of ['pig-settings', 'pig-settings-host.ts', 'pig-servers.ts']) {
      await cp(join(process.cwd(), 'src/main/plugins', name), join(packaged, name), { recursive: true })
    }
    const packagedPath = join(packaged, 'pig-settings', 'index.ts')
    const packagedLoader = await createNoExtensionsResourceLoader(root, [packagedPath])
    expect(packagedLoader.getExtensions().errors).toEqual([])
    const packagedExtension = packagedLoader.getExtensions().extensions.find(item => item.path === packagedPath)!
    const packagedResult = await (packagedExtension.tools.get('settings_get')!.definition as any).execute('8', { group: 'theme' }, signal, undefined, ctx as never)
    expect(packagedResult.structuredContent).toBe(before)
    expect(calls.pop()).toEqual(['get', 'session-2', 'theme'])
  } finally {
    if (previous) registry[key] = previous
    else delete registry[key]
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv.includes('--settings-extension-fixture')) await fixture()
else test('jiti settings tools enforce the write allowlist and forward real host data, session IDs and cancellation', async () => {
  const { exitCode: code, stdout: out, stderr: err } = await runSelf(import.meta.path, ['--settings-extension-fixture'], { timeoutMs: 25_000 })
  expect(code, err || out).toBe(0)
}, 30_000)
