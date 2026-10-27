import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemoryPluginSettingsPatch, PluginScope } from '../src/shared/api'

async function fixture(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pig-plugins-'))
  const previousPig = process.env.PIG_DIR
  const previousPi = process.env.PI_CODING_AGENT_DIR
  const previousPassive = process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE
  process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE = 'true'
  process.env.PIG_DIR = join(root, 'pig')
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  const { mock } = await import('bun:test')
  mock.module('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
  const webAccessBundle = join(process.cwd(), 'out', 'system-plugins', 'pi-web-access', 'index.js')
  const personaBundle = join(process.cwd(), 'out', 'system-plugins', 'pi-persona', 'index.js')
  const settingsPath = join(process.cwd(), 'src', 'main', 'plugins', 'pig-settings', 'index.ts')
  try {
    const module = await import('../src/main/pi/plugins')
    const ui = await import('../src/main/pi/system-plugin-ui')
    const { reviewUI } = await import('../src/main/plugins/pig-ui')
    const sdk = await import('@earendil-works/pi-coding-agent')
    const plugin = join(root, 'example')
    const marker = join(root, 'executed')
    await mkdir(join(plugin, 'extensions'), { recursive: true })
    await mkdir(join(plugin, 'skills', 'plugin-invisible'), { recursive: true })
    await writeFile(join(plugin, 'skills', 'plugin-invisible', 'SKILL.md'), '---\nname: plugin-invisible\ndescription: test\n---\n')
    await writeFile(join(plugin, 'extensions', 'entry.ts'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'loaded'); export default function () {}`)
    await writeFile(join(plugin, 'package.json'), JSON.stringify({ name: 'example', pi: { extensions: ['./extensions/entry.ts'], skills: ['./skills'] }, pig: {
      settings: { namespace: 'example-plugin', fields: [
        { key: 'count', label: 'Count', type: 'integer', min: 1 },
        { key: 'choice', label: 'Choice', type: 'select', options: ['a', 'b'] },
        { key: 'enabled', label: 'Enabled', type: 'boolean' }
      ] }
    } }))
    assert.equal((await module.listPlugins()).find((item) => item.id === 'pi-review')?.settings?.namespace, 'pi-review')
    assert.deepEqual(await module.getPluginSettings('pi-review'), {})
    await assert.rejects(module.setPluginSettings('pi-review', { provider: 'test' }), /both provider and model ID/)
    await module.setPluginSettings('pi-review', { provider: ' test ', modelId: ' review-model ', thinking: 'high' })
    assert.deepEqual(await module.getPluginSettings('pi-review'), { provider: 'test', modelId: 'review-model', thinking: 'high' })
    await assert.rejects(module.setPluginSettings('pi-review', { thinking: 'invalid' }), /Invalid choice/)
    await assert.rejects(module.setPluginSettings('pi-review', { provider: null }), /both provider and model ID/)
    await module.setPluginSettings('pi-review', { provider: null, modelId: null })
    assert.deepEqual(await module.getPluginSettings('pi-review'), { thinking: 'high' })
    await module.setPluginSettings('pi-review', { thinking: null })
    assert.deepEqual(await module.getPluginSettings('pi-review'), {})
    const defaultScopes = [[], ['project'], ['project', 'chat'], ['project'], ['project'], ['project'], ['project'], ['project', 'chat'], ['project', 'chat']]
    assert.deepEqual((await module.listPlugins()).map((item) => item.scopes), defaultScopes)
    assert.equal(await module.isMemoryPluginEnabled('project'), false)
    assert.equal(await module.isMemoryPluginEnabled('chat'), false)
    const bundledPaths = await module.enabledPluginPaths('project')
    assert.equal(bundledPaths.some((path) => path.endsWith(join('plugins', 'observational-memory', 'index.ts'))), false)
    assert.deepEqual(await module.enabledPluginPaths('chat'), [webAccessBundle, settingsPath, personaBundle].filter(existsSync))
    assert.ok(bundledPaths.some((path) => path.endsWith(join('plugins', 'pi-review', 'index.ts'))))
    const subagentPath = bundledPaths.find((path) => path.endsWith(join('plugins', 'pig-subagent', 'index.ts')))
    assert.ok(subagentPath, 'subagents default to projects only')
    const browserPath = bundledPaths.find((path) => path.endsWith(join('plugins', 'pig-browser', 'index.ts')))
    assert.ok(browserPath, 'browser tools default to projects only')
    const terminalPath = bundledPaths.find((path) => path.endsWith(join('plugins', 'pig-terminal', 'index.ts')))
    assert.ok(terminalPath, 'terminal tools default to projects only')
    assert.deepEqual((await module.listPlugins()).find((item) => item.id === 'pig-terminal'), {
      id: 'pig-terminal', name: 'Terminal', source: 'Pig built-in', kind: 'system', scopes: ['project'], available: true
    })
    assert.deepEqual((await module.toolProvidersByPath('project')).get(terminalPath), { kind: 'pig', id: 'pig-terminal', name: 'Terminal' })
    const processPath = bundledPaths.find((path) => path.endsWith(join('plugins', 'pig-process', 'index.ts')))
    assert.ok(processPath, 'background processes default to projects only')
    assert.deepEqual((await module.listPlugins()).find((item) => item.id === 'pig-process'), {
      id: 'pig-process', name: 'Background Processes', source: 'Pig built-in', kind: 'system', scopes: ['project'], available: true
    })
    assert.deepEqual((await module.toolProvidersByPath('project')).get(processPath), { kind: 'pig', id: 'pig-process', name: 'Background Processes' })
    assert.ok(bundledPaths.includes(settingsPath), 'settings tools default to both project and Chat')
    assert.deepEqual((await module.listPlugins()).find((item) => item.id === 'pig-settings'), {
      id: 'pig-settings', name: 'Settings', source: 'Pig built-in', kind: 'system', scopes: ['project', 'chat'], available: true
    })
    for (const scope of ['project', 'chat'] as const) {
      assert.deepEqual((await module.toolProvidersByPath(scope)).get(settingsPath), { kind: 'pig', id: 'pig-settings', name: 'Settings' })
    }
    await assert.rejects(module.getPluginSettings('pig-settings'), /Plugin not found/, 'the settings tools do not declare a plugin configuration pane')
    assert.deepEqual(module.subagentPluginPaths(bundledPaths), bundledPaths.filter((path) => ![subagentPath, browserPath, terminalPath, processPath, settingsPath, personaBundle].includes(path)), 'children cannot alter global mood or settings, spawn, control window tools or own processes')
    assert.equal(bundledPaths.some((path) => path.endsWith(join('system-plugins', 'pi-web-access', 'index.js'))), existsSync(webAccessBundle))
    assert.deepEqual((await module.listPlugins()).find((item) => item.id === 'pi-persona')?.scopes, ['project', 'chat'])
    assert.equal(bundledPaths.includes(personaBundle), existsSync(personaBundle))
    const registryFile = join(root, 'pig', 'plugins.json')
    await mkdir(join(root, 'pig'), { recursive: true })
    await writeFile(registryFile, JSON.stringify({ version: 1, installed: [] }))
    assert.deepEqual((await module.listPlugins()).map((item) => item.scopes), defaultScopes, 'unset preferences use current defaults')
    await module.setPluginScopes('pig-terminal', [])
    assert.deepEqual((await module.listPlugins()).find((item) => item.id === 'pig-terminal')?.scopes, [], 'saved empty scopes override defaults')
    assert.equal((await module.enabledPluginPaths('any')).includes(terminalPath), false)
    await module.setPluginScopes('pig-terminal', ['chat', 'project', 'chat'])
    assert.deepEqual(JSON.parse(await readFile(registryFile, 'utf8')).terminalScopes, ['project', 'chat'])
    assert.equal((await module.enabledPluginPaths('chat')).includes(terminalPath), true)
    await module.setPluginScopes('pig-terminal', ['chat'])
    assert.equal((await module.enabledPluginPaths('project')).includes(terminalPath), false)
    assert.equal((await module.enabledPluginPaths('chat')).includes(terminalPath), true)
    await assert.rejects(module.setPluginScopes('pig-terminal', ['unknown'] as unknown as PluginScope[]), /Invalid plugin scopes/)
    // Batches are one registry write: a failed check or one unknown ID leaves every plugin unchanged.
    await assert.rejects(module.updatePluginScopes({ 'pig-terminal': [], 'pi-review': [] }, () => { throw new Error('stale') }), /stale/)
    await assert.rejects(module.updatePluginScopes({ 'pig-terminal': [], missing: [] }), /Plugin not found/)
    assert.deepEqual(JSON.parse(await readFile(registryFile, 'utf8')).terminalScopes, ['chat'])
    let seen: Record<string, PluginScope[]> | undefined
    const batch = await module.updatePluginScopes({ 'pig-terminal': ['project'], 'pi-review': [] }, (current) => { seen = current })
    assert.deepEqual(seen?.['pig-terminal'], ['chat'], 'the check sees the state it guards')
    assert.deepEqual([batch['pig-terminal'], batch['pi-review']], [['project'], []])
    assert.deepEqual(await module.pluginScopes(), batch)
    await module.setPluginScopes('pig-terminal', ['chat'])
    for (const terminalScopes of [true, ['unknown']]) {
      await writeFile(registryFile, JSON.stringify({ installed: [], terminalScopes }))
      await assert.rejects(module.listPlugins(), /Invalid plugin scopes/)
    }
    await writeFile(registryFile, JSON.stringify({ version: 1, installed: [] }))
    await module.setPluginScopes('pig-settings', [])
    assert.deepEqual((await module.listPlugins()).find((item) => item.id === 'pig-settings')?.scopes, [], 'saved empty settings scopes override both defaults')
    assert.equal((await module.enabledPluginPaths('any')).includes(settingsPath), false)
    assert.deepEqual(JSON.parse(await readFile(registryFile, 'utf8')).settingsScopes, [])
    await module.setPluginScopes('pig-settings', ['chat', 'project', 'chat'])
    assert.deepEqual(JSON.parse(await readFile(registryFile, 'utf8')).settingsScopes, ['project', 'chat'])
    await module.setPluginScopes('pig-settings', ['chat'])
    assert.equal((await module.enabledPluginPaths('project')).includes(settingsPath), false)
    assert.equal((await module.enabledPluginPaths('chat')).includes(settingsPath), true)
    await assert.rejects(module.setPluginScopes('pig-settings', ['unknown'] as unknown as PluginScope[]), /Invalid plugin scopes/)
    for (const settingsScopes of [true, ['unknown']]) {
      await writeFile(registryFile, JSON.stringify({ installed: [], settingsScopes }))
      await assert.rejects(module.listPlugins(), /Invalid plugin scopes/)
    }
    await writeFile(registryFile, JSON.stringify({
      version: 1, memoryEnabled: true, reviewEnabled: false, webAccessEnabled: true,
      installed: [{ id: 'legacy', source: plugin, kind: 'local', enabled: true }]
    }))
    assert.deepEqual((await module.listPlugins()).map((item) => item.scopes), [['project'], [], ['project'], ['project'], ['project'], ['project'], ['project'], ['project', 'chat'], ['project', 'chat'], ['project']])
    assert.deepEqual(await module.enabledPluginPaths('chat'), [settingsPath, personaBundle].filter(existsSync), 'legacy switches do not change new built-in defaults')
    await module.setPluginScopes('legacy', ['chat', 'project', 'chat'])
    const migrated = JSON.parse(await readFile(registryFile, 'utf8'))
    assert.equal(migrated.version, 2)
    assert.deepEqual(migrated.memoryScopes, ['project'])
    assert.deepEqual(migrated.reviewScopes, [])
    assert.deepEqual(migrated.webAccessScopes, ['project'])
    assert.deepEqual(migrated.terminalScopes, ['project'])
    assert.deepEqual(migrated.settingsScopes, ['project', 'chat'])
    assert.deepEqual(migrated.installed[0].scopes, ['project', 'chat'])
    assert.deepEqual((await module.listPlugins()).map((item) => item.scopes), [['project'], [], ['project'], ['project'], ['project'], ['project'], ['project'], ['project', 'chat'], ['project', 'chat'], ['project', 'chat']], 'saved scopes override defaults')
    assert.equal(migrated.installed[0].enabled, undefined)
    await rm(registryFile)

    for (const id of ['observational-memory', 'pi-review', 'pi-web-access', 'pig-subagent', 'pig-browser', 'pig-terminal', 'pig-process', 'pig-settings', 'pi-persona']) await module.setPluginScopes(id, [])
    assert.deepEqual(await module.enabledPluginPaths('project'), [])
    assert.deepEqual((await module.listPlugins()).find((item) => item.id === 'pi-persona')?.scopes, [])
    if (existsSync(personaBundle)) {
      await module.setPluginScopes('pi-persona', ['chat', 'project', 'chat'])
      assert.equal((await module.enabledPluginPaths('chat')).includes(personaBundle), true)
      await module.setPluginScopes('pi-persona', [])
    }
    await assert.rejects(module.setPluginScopes('pi-persona', ['unknown'] as unknown as PluginScope[]), /Invalid plugin scopes/)
    await module.setPluginScopes('pi-review', ['chat'])
    assert.deepEqual(await module.enabledPluginPaths('project'), [])
    assert.ok((await module.enabledPluginPaths('chat')).some((path) => path.endsWith(join('plugins', 'pi-review', 'index.ts'))))
    await module.setPluginScopes('pi-review', ['project', 'chat'])
    assert.deepEqual((await module.listPlugins()).find((item) => item.id === 'pi-review')?.scopes, ['project', 'chat'])
    await module.setPluginScopes('pi-review', ['project'])
    assert.deepEqual(await module.enabledPluginPaths('chat'), [])
    if (existsSync(webAccessBundle)) {
      await module.setPluginScopes('pi-web-access', ['project'])
      assert.ok((await module.enabledPluginPaths('project')).some((path) => path.endsWith(join('system-plugins', 'pi-web-access', 'index.js'))))
      await module.setPluginScopes('pi-web-access', [])
    }
    await module.setPluginScopes('pi-review', [])
    await assert.rejects(module.setPluginScopes('pi-review', ['unknown'] as unknown as PluginScope[]), /Invalid plugin scopes/)
    assert.deepEqual(await module.enabledPluginPaths('project'), [])
    await module.installPlugin(plugin)
    const installed = (await module.listPlugins()).find((item) => item.kind === 'local')!
    assert.equal(installed.kind, 'local')
    assert.deepEqual(installed.scopes, [])
    assert.equal(installed.available, true)
    assert.equal(installed.settings?.namespace, 'example-plugin')
    assert.equal(existsSync(marker), false)
    assert.deepEqual(await module.getPluginSettings(installed.id), {})
    await module.setPluginSettings(installed.id, { count: 2, choice: 'a', enabled: true })
    assert.deepEqual(await module.getPluginSettings(installed.id), { count: 2, choice: 'a', enabled: true })
    await assert.rejects(module.setPluginSettings(installed.id, { count: 0 }), /integer/)
    await assert.rejects(module.setPluginSettings(installed.id, { choice: 'unknown' }), /choice/)
    await module.setPluginSettings(installed.id, { count: null })
    assert.deepEqual(await module.getPluginSettings(installed.id), { choice: 'a', enabled: true })
    const genericSettings = join(root, 'pig', 'plugin-settings', 'example-plugin.json')
    assert.deepEqual(JSON.parse(await readFile(genericSettings, 'utf8'))['example-plugin'], { choice: 'a', enabled: true })
    await assert.rejects(module.installPlugin(plugin), /already installed/)
    await module.setPluginScopes(installed.id, ['project'])
    const paths = await module.enabledPluginPaths('project')
    assert.deepEqual(await module.enabledPluginPaths('chat'), [])
    assert.equal(paths.length, 1)
    assert.equal(paths[0], join(plugin, 'extensions', 'entry.ts'))
    const loader = new sdk.DefaultResourceLoader({
      cwd: root, agentDir: join(root, 'agent'), settingsManager: sdk.SettingsManager.inMemory({}),
      noExtensions: true, additionalExtensionPaths: paths
    })
    await loader.reload()
    assert.deepEqual(loader.getExtensions().errors, [])
    assert.equal(await readFile(marker, 'utf8'), 'loaded')
    await assert.rejects(module.removePlugin(installed.id), /Disable/)
    await module.setPluginScopes(installed.id, ['chat'])
    assert.deepEqual(await module.enabledPluginPaths('project'), [])
    assert.deepEqual(await module.enabledPluginPaths('chat'), paths)
    assert.deepEqual(await module.enabledPluginPaths('any'), paths)
    await assert.rejects(module.removePlugin(installed.id), /Disable/, 'chat-only plugins are still enabled')
    const { createChatResourceLoader, createNoExtensionsResourceLoader } = await import('../src/main/pi/chat-resources')
    await mkdir(join(root, '.pi', 'skills', 'project-only'), { recursive: true })
    await mkdir(join(root, 'agent', 'skills', 'user-visible'), { recursive: true })
    await writeFile(join(root, 'AGENTS.md'), 'PROJECT_ONLY_INSTRUCTIONS')
    await writeFile(join(root, 'agent', 'AGENTS.md'), 'USER_INSTRUCTIONS')
    await writeFile(join(root, '.pi', 'skills', 'project-only', 'SKILL.md'), '---\nname: project-only\ndescription: project only\n---\n')
    await writeFile(join(root, 'agent', 'skills', 'user-visible', 'SKILL.md'), '---\nname: user-visible\ndescription: user skill\n---\n')
    await writeFile(join(root, '.pi', 'settings.json'), JSON.stringify({ packages: [plugin] }))
    const chatLoader = await createChatResourceLoader(root, await module.enabledPluginPaths('chat'))
    assert.deepEqual(chatLoader.getExtensions().errors, [])
    assert.deepEqual(chatLoader.getExtensions().extensions.map((extension) => extension.path), paths, 'Chat loads its approved extensions')
    assert.deepEqual(chatLoader.getAgentsFiles().agentsFiles.map((file) => file.path), [join(root, 'agent', 'AGENTS.md')])
    assert.equal(chatLoader.getSkills().skills.some((skill) => skill.name === 'user-visible'), true)
    assert.equal(chatLoader.getSkills().skills.some((skill) => skill.name === 'project-only' || skill.name === 'plugin-invisible'), false)
    assert.match(chatLoader.getAppendSystemPrompt().join('\n'), /This session is a conversation, not a software project/)
    await module.setPluginScopes(installed.id, ['project', 'chat'])
    assert.deepEqual(await module.enabledPluginPaths('project'), paths)
    assert.deepEqual(await module.enabledPluginPaths('chat'), paths)
    await module.setPluginScopes(installed.id, [])
    assert.deepEqual(await module.enabledPluginPaths('any'), [])
    const privateLoader = await createNoExtensionsResourceLoader(root)
    assert.equal(privateLoader.getSkills().skills.some((skill) => skill.name === 'plugin-invisible'), false)
    await module.removePlugin(installed.id)
    assert.equal((await module.listPlugins()).filter((item) => item.kind !== 'system').length, 0)
    assert.equal(existsSync(genericSettings), false)

    const agentSettings = join(root, 'agent', 'settings.json')
    await mkdir(join(root, 'agent'), { recursive: true })
    await writeFile(agentSettings, JSON.stringify({ 'observational-memory': { passive: true, observeAfterTokens: 999 } }))
    assert.deepEqual(await module.getMemoryPluginDefaults(), {
      observeAfterTokens: 10000, reflectAfterTokens: 20000, compactAfterTokens: 81000,
      compactAfterTokensRatio: 0.68, observationsPoolMaxTokens: 20000,
      observationsPoolTargetTokens: 10000, agentMaxTurns: 16, agentMaxTokens: 32000,
      compactionCatchUpMaxChunks: 2
    })
    assert.deepEqual(await module.getMemoryPluginSettings(), {})
    const settingsFile = join(root, 'pig', 'plugins', 'observational-memory', 'settings.json')
    await module.setMemoryPluginSettings({ passive: true, debugLog: false })
    const privateSettings = JSON.parse(await readFile(settingsFile, 'utf8'))
    assert.deepEqual(privateSettings['observational-memory'], { passive: true, debugLog: false })
    await module.setMemoryPluginSettings({ observeAfterTokens: 800, passive: null })
    assert.deepEqual((await module.getMemoryPluginSettings()), { observeAfterTokens: 800, debugLog: false })
    assert.deepEqual(JSON.parse(await readFile(agentSettings, 'utf8')), { 'observational-memory': { passive: true, observeAfterTokens: 999 } })
    const { loadConfig } = await import('../src/main/plugins/observational-memory/config')
    assert.equal(loadConfig().observeAfterTokens, 800)
    assert.equal(loadConfig().passive, false)
    const piConfigProject = join(root, 'compaction-config-project')
    const piProjectSettings = join(piConfigProject, '.pi', 'settings.json')
    await mkdir(join(piConfigProject, '.pi'), { recursive: true })
    const originalPiSettings = await readFile(agentSettings, 'utf8')
    await writeFile(agentSettings, JSON.stringify({ compaction: { enabled: false } }))
    assert.equal(loadConfig(piConfigProject).piAutoCompactionEnabled, false)
    await writeFile(piProjectSettings, JSON.stringify({ compaction: { enabled: true } }))
    assert.equal(loadConfig(piConfigProject).piAutoCompactionEnabled, true)
    await writeFile(piProjectSettings, '{broken JSON')
    assert.throws(() => loadConfig(piConfigProject), (error: unknown) =>
      error instanceof Error && error.message.includes(piProjectSettings) && error.cause instanceof SyntaxError)
    await rm(piProjectSettings)
    await mkdir(piProjectSettings)
    assert.throws(() => loadConfig(piConfigProject), (error: unknown) =>
      error instanceof Error && error.message.includes(piProjectSettings) && (error.cause as NodeJS.ErrnoException).code === 'EISDIR')
    await rm(piProjectSettings, { recursive: true })
    await writeFile(agentSettings, '{broken JSON')
    assert.throws(() => loadConfig(piConfigProject), (error: unknown) =>
      error instanceof Error && error.message.includes(agentSettings) && error.cause instanceof SyntaxError)
    await writeFile(agentSettings, originalPiSettings)
    assert.equal(loadConfig(piConfigProject).piAutoCompactionEnabled, true)
    const { runObserver } = await import('../src/main/plugins/observational-memory/agents/observer/agent')
    let observerPrompt = ''
    await runObserver({
      model: { provider: 'test', maxTokens: 1000 } as import('@earendil-works/pi-ai').Model<any>,
      priorReflections: [], priorObservations: [], chunk: '[Source entry id: source] hello', allowedSourceEntryIds: ['source'],
      streamSimple: (() => { throw new Error('No model call expected') }) as import('../src/main/plugins/observational-memory/agents/worker-stream').WorkerStreamSimple,
      agentLoop: ((_prompts, context) => {
        const system = context.messages.find((message) => message.role === 'system')
        observerPrompt = system?.role === 'system' && typeof system.content === 'string' ? system.content : ''
        return { async *[Symbol.asyncIterator]() {}, result: async () => [] } as unknown as ReturnType<typeof import('@earendil-works/pi-agent-core').agentLoop>
      }) as typeof import('@earendil-works/pi-agent-core').agentLoop
    })
    assert.match(observerPrompt, /observation agent/)
    await assert.rejects(module.setMemoryPluginSettings({ compactAfterTokensRatio: 3 }), /Ratio/)
    // The fallback model is written by the settings pane, so the allowlist has to accept it
    // and keep it out of the sibling `model` slot.
    const withFallback = await module.setMemoryPluginSettings({ fallbackModel: { provider: 'test', id: 'small', thinking: 'low' } })
    assert.deepEqual(withFallback.fallbackModel, { provider: 'test', id: 'small', thinking: 'low' })
    // Malformed payloads must be rejected at runtime, not just by the type contract.
    const malformed = (value: unknown) => ({ fallbackModel: value }) as MemoryPluginSettingsPatch
    await assert.rejects(module.setMemoryPluginSettings(malformed({ provider: 'test' })), /Invalid memory model/)
    await assert.rejects(module.setMemoryPluginSettings(malformed({ provider: 'test', id: 'small', thinking: 'bogus' })), /Invalid memory model/)
    await module.setMemoryPluginSettings({ fallbackModel: null })
    assert.equal((await module.getMemoryPluginSettings()).fallbackModel, undefined)
    const idleSettings = await module.setMemoryPluginSettings({ compactionCatchUpMaxChunks: 0, consolidateWhenIdle: true })
    assert.equal(idleSettings.compactionCatchUpMaxChunks, 0)
    assert.equal(idleSettings.consolidateWhenIdle, true)
    assert.equal(loadConfig().compactionCatchUpMaxChunks, 0)
    assert.equal(loadConfig().consolidateWhenIdle, true)
    await assert.rejects(module.setMemoryPluginSettings({ compactionCatchUpMaxChunks: -1 }))
    await assert.rejects(module.setMemoryPluginSettings({ compactionCatchUpMaxChunks: 0.5 }))
    await module.setMemoryPluginSettings({ compactionCatchUpMaxChunks: null, consolidateWhenIdle: null })
    assert.equal(loadConfig().compactionCatchUpMaxChunks, 2)
    assert.equal(loadConfig().consolidateWhenIdle, false)

    const requests: { channel: string; payload: any }[] = []
    const sender = { send: (channel: string, payload: any) => { requests.push({ channel, payload }) }, isDestroyed: () => false }
    const win = { webContents: sender, isDestroyed: () => false } as unknown as import('electron').BrowserWindow
    ui.attachSystemUI('one', win)
    const context = reviewUI({ sessionManager: { getSessionId: () => 'one' } })
    const choice = context.choose('preset', [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }])
    const request = requests.at(-1)!.payload
    ui.replyReviewUI({} as import('electron').WebContents, request.id, 'yes')
    ui.replyReviewUI(sender as unknown as import('electron').WebContents, request.id, 'invalid')
    assert.equal(await choice, undefined)
    const pending = context.edit('instructions', 'prefill')
    ui.cancelSystemPrompts('one')
    assert.equal(await pending, undefined)
    assert.equal(requests.at(-1)?.payload.kind, 'dismiss')
    ui.detachSystemUI('one')
    assert.equal(context.available, false)

    await module.setPluginScopes('observational-memory', ['chat'])
    assert.equal(await module.isMemoryPluginEnabled('project'), false)
    assert.equal(await module.isMemoryPluginEnabled('chat'), true)
    const packagedPlugins = join(root, 'resources', 'system-plugins')
    await mkdir(packagedPlugins, { recursive: true })
    for (const name of ['observational-memory', 'pi-review', 'pig-ui.ts']) {
      await cp(join(process.cwd(), 'src', 'main', 'plugins', name), join(packagedPlugins, name), { recursive: true })
    }
    const builderConfig = await readFile(join(process.cwd(), 'electron-builder.yml'), 'utf8')
    assert.match(builderConfig, /to: system-plugins\/pig-ui\.ts/)
    assert.match(builderConfig, /from: src\/main\/plugins\/pig-terminal-host\.ts\s+to: system-plugins\/pig-terminal-host\.ts/)
    assert.match(builderConfig, /from: src\/main\/plugins\/pig-process-host\.ts\s+to: system-plugins\/pig-process-host\.ts/)
    assert.match(builderConfig, /from: src\/main\/plugins\/pig-settings-host\.ts\s+to: system-plugins\/pig-settings-host\.ts/)
    assert.match(builderConfig, /from: src\/main\/plugins\/pig-settings\s+to: system-plugins\/pig-settings\s+filter:\s+- '\*\*\/\*\.ts'/)
    assert.match(builderConfig, /from: src\/main\/plugins\/pig-process\s+to: system-plugins\/pig-process\s+filter:\s+- '\*\*\/\*\.ts'/)
    assert.match(builderConfig, /from: src\/main\/plugins\/pig-servers\.ts\s+to: system-plugins\/pig-servers\.ts/)
    assert.match(builderConfig, /from: src\/main\/plugins\/pig-terminal\s+to: system-plugins\/pig-terminal\s+filter:\s+- '\*\*\/\*\.ts'/)
    const packagedPaths = [join(packagedPlugins, 'observational-memory', 'index.ts'), join(packagedPlugins, 'pi-review', 'index.ts')]
    if (existsSync(personaBundle)) {
      await cp(join(process.cwd(), 'out', 'system-plugins', 'pi-persona'), join(packagedPlugins, 'pi-persona'), { recursive: true })
      packagedPaths.push(join(packagedPlugins, 'pi-persona', 'index.js'))
    }
    assert.match(builderConfig, /from: out\/system-plugins\/pi-persona\s+to: system-plugins\/pi-persona/)
    const memoryLoader = await createNoExtensionsResourceLoader(root, packagedPaths)
    assert.deepEqual(memoryLoader.getExtensions().errors, [])
    const { session } = await sdk.createAgentSession({
      cwd: root, agentDir: join(root, 'agent'), resourceLoader: memoryLoader,
      settingsManager: sdk.SettingsManager.inMemory({}), noTools: 'all'
    })
    try {
      ui.attachSystemUI(session.sessionId, win)
      await session.bindExtensions({ mode: 'rpc' })
      assert.equal(session.extensionRunner.hasUI(), false)
      const commands = session.extensionRunner.getRegisteredCommands().map((command) => command.invocationName)
      assert.equal(commands.includes('review'), true)
      assert.equal(commands.includes('persona'), false)
      assert.equal(commands.includes('om:status'), false)
      assert.equal(commands.includes('om:view'), false)
      const { memoryStatus, memoryView } = await import('../src/main/plugins/observational-memory/details')
      assert.match(memoryStatus(session.sessionId, [], 128_000), /Next observation: ~0 \/ 800 tokens/)
      assert.match(memoryView([]), /No visible observations/)
      assert.match(memoryView([], true), /No recorded observations/)
      const observation = { id: '123456789abc', content: 'Pig remembers context', timestamp: '2026-09-28 12:00', relevance: 'high' as const, sourceEntryIds: ['source'], tokenCount: 6 }
      const branch = [
        { type: 'message', id: 'source' },
        { type: 'custom', id: 'memory', customType: 'om.observations.recorded', data: { observations: [observation], coversUpToId: 'source' } }
      ]
      assert.match(memoryView(branch, true), /Pig remembers context/)
      assert.doesNotMatch(memoryView(branch), /Pig remembers context/)
      const { memoryRuntime } = await import('../src/main/plugins/observational-memory/runtime')
      const runtime = memoryRuntime(session.sessionId)
      assert.ok(runtime)
      runtime.notify('Memory host notification')
      assert.equal(requests.at(-1)?.payload.plugin, 'memory')
      assert.equal(requests.at(-1)?.payload.message, 'Memory host notification')
      runtime.lastObserverError = 'memory worker failed'
      assert.match(memoryStatus(session.sessionId, branch), /memory worker failed/)
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
      assert.equal(memoryRuntime(session.sessionId), undefined)
    } finally {
      ui.detachSystemUI(session.sessionId)
      session.dispose()
    }

    const broken = join(root, 'broken-schema')
    await mkdir(join(broken, 'extensions'), { recursive: true })
    await writeFile(join(broken, 'extensions', 'entry.ts'), `export default function () {}`)
    const brokenManifest = (namespace: string) => JSON.stringify({
      name: 'broken-schema', pi: { extensions: ['./extensions/entry.ts'] },
      pig: { settings: { namespace, fields: [{ key: 'x', label: 'X', type: 'boolean' }] } }
    })
    await writeFile(join(broken, 'package.json'), brokenManifest('broken-schema'))
    await module.installPlugin(broken)
    await writeFile(join(broken, 'package.json'), brokenManifest('BAD NAME'))
    const brokenPlugin = (await module.listPlugins()).find((item) => item.source === broken)!
    assert.equal(brokenPlugin.available, true)
    assert.equal(brokenPlugin.settings, undefined)
    assert.match(brokenPlugin.error ?? '', /Invalid Pig settings schema/)
    await module.setPluginScopes(brokenPlugin.id, ['project'])
    assert.ok((await module.enabledPluginPaths('project')).some((path) => path === join(broken, 'extensions', 'entry.ts')))
    await module.setPluginScopes(brokenPlugin.id, [])

    const clashManifest = (name: string) => JSON.stringify({
      name, pi: { extensions: ['./extensions/entry.ts'] },
      pig: { settings: { namespace: 'clash-ns', fields: [{ key: 'x', label: 'X', type: 'boolean' }] } }
    })
    for (const name of ['clash-a', 'clash-b']) {
      const dir = join(root, name)
      await mkdir(join(dir, 'extensions'), { recursive: true })
      await writeFile(join(dir, 'extensions', 'entry.ts'), `export default function () {}`)
      await writeFile(join(dir, 'package.json'), clashManifest(name))
    }
    await module.installPlugin(join(root, 'clash-a'))
    const beforeFailedInstall = (await module.listPlugins()).map((item) => item.id)
    await assert.rejects(module.installPlugin(join(root, 'clash-b')), /namespace already installed/)
    assert.deepEqual((await module.listPlugins()).map((item) => item.id), beforeFailedInstall)

    const { sessionResourceSettings } = await import('../src/main/pi/chat-resources')
    const readOnly = sessionResourceSettings(root, join(root, 'agent'))
    readOnly.setDefaultModelAndProvider('some-provider', 'some-model')
    await readOnly.flush()
    const writeErrors = readOnly.drainErrors()
    assert.equal(writeErrors.length, 1)
    assert.match(String(writeErrors[0]?.error), /read-only in Pig/)
    assert.deepEqual(JSON.parse(await readFile(agentSettings, 'utf8')), { 'observational-memory': { passive: true, observeAfterTokens: 999 } })

    const { DEFAULTS } = await import('../src/main/plugins/observational-memory/config')
    await writeFile(settingsFile, '{corrupt')
    const logged: string[] = []
    const previousError = console.error
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')) }
    try {
      assert.equal(loadConfig().observeAfterTokens, DEFAULTS.observeAfterTokens)
      assert.equal(loadConfig().observeAfterTokens, DEFAULTS.observeAfterTokens)
    } finally {
      console.error = previousError
    }
    assert.equal(logged.length, 1)
    assert.match(logged[0] ?? '', /ignoring invalid config/)
  } finally {
    if (previousPig === undefined) delete process.env.PIG_DIR
    else process.env.PIG_DIR = previousPig
    if (previousPi === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousPi
    if (previousPassive === undefined) delete process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE
    else process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE = previousPassive
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv.includes('--plugins-fixture')) {
  await fixture()
} else {
  test('Pig plugin allowlist, private registry, Pi config and UI bridge', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--plugins-fixture'], {
      cwd: new URL('..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe'
    })
    const timer = setTimeout(() => child.kill(), 20_000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      assert.equal(code, 0, stderr || stdout)
    } finally { clearTimeout(timer) }
  })
}
