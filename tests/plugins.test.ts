import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemorySettingsPatch, PluginScope } from '../src/shared/api'
import { runSelf } from './helpers/subprocess.ts'

async function fixture(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pig-plugins-'))
  const previousPig = process.env.PIG_DIR
  const previousPi = process.env.PI_CODING_AGENT_DIR
  const previousPassive = process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE
  process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE = 'true'
  process.env.PIG_DIR = join(root, 'pig')
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  const { mock } = await import('bun:test')
  const app = { isPackaged: false, getAppPath: () => process.cwd() }
  mock.module('electron', () => ({ app }))
  const webAccessBundle = join(process.cwd(), 'out', 'system-plugins', 'pig-web', 'index.js')
  const personaBundle = join(process.cwd(), 'out', 'system-plugins', 'pig-persona', 'index.js')
  const settingsPath = join(process.cwd(), 'src', 'main', 'plugins', 'pig-settings', 'index.ts')
  const sessionPath = join(process.cwd(), 'src', 'main', 'plugins', 'pig-session', 'index.ts')
  try {
    const module = { ...await import('../src/main/pi/plugins'), ...await import('../src/main/features/memory-settings') }
    const { sessionToolPath } = await import('../src/main/pi/system-plugin-paths')
    assert.equal(sessionToolPath(), sessionPath)
    const originalResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    try {
      app.isPackaged = true
      Object.defineProperty(process, 'resourcesPath', { value: join(root, 'resources'), configurable: true })
      const packagedSession = join(process.resourcesPath, 'system-plugins', 'pig-session', 'index.ts')
      assert.equal(sessionToolPath(), packagedSession)
      assert.deepEqual(module.subagentPluginPaths([packagedSession, '/unrelated.ts']), ['/unrelated.ts'], 'packaged exclusion and permission identity share the same path')
    } finally {
      app.isPackaged = false
      if (originalResources) Object.defineProperty(process, 'resourcesPath', originalResources)
      else Reflect.deleteProperty(process, 'resourcesPath')
    }
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
    assert.equal((await module.listPlugins()).find((item) => item.id === 'pig-review')?.settings?.namespace, 'pig-review')
    assert.deepEqual(await module.getPluginSettings('pig-review'), {})
    const { readReviewSettings } = await import('../src/main/plugins/pig-review/settings')
    const reviewConfigDir = join(root, 'pig', 'plugin-settings')
    const oldReviewConfig = join(reviewConfigDir, 'pi-review.json')
    const reviewConfig = join(reviewConfigDir, 'pig-review.json')
    await mkdir(reviewConfigDir, { recursive: true })
    const oldReviewValues = { provider: 'test', modelId: 'saved-review', thinking: 'high' }
    await writeFile(oldReviewConfig, JSON.stringify({ 'pi-review': oldReviewValues }))
    assert.deepEqual(await module.getPluginSettings('pig-review'), oldReviewValues)
    assert.deepEqual(await readReviewSettings(), { model: { provider: 'test', id: 'saved-review' }, thinking: 'high' })
    await module.setPluginSettings('pig-review', { thinking: 'low' })
    assert.deepEqual(JSON.parse(await readFile(reviewConfig, 'utf8')), { 'pig-review': { ...oldReviewValues, thinking: 'low' } })
    assert.deepEqual(await readReviewSettings(), { model: { provider: 'test', id: 'saved-review' }, thinking: 'low' })
    await writeFile(reviewConfig, '{broken')
    await assert.rejects(module.getPluginSettings('pig-review'), SyntaxError)
    await assert.rejects(module.setPluginSettings('pig-review', { thinking: 'high' }), SyntaxError)
    await assert.rejects(readReviewSettings(), SyntaxError)
    assert.equal(await readFile(reviewConfig, 'utf8'), '{broken')
    await writeFile(reviewConfig, JSON.stringify({ 'pig-review': {} }))
    assert.deepEqual(await readReviewSettings(), {}, 'an explicit reset never restores old model preferences')
    assert.deepEqual(await module.getPluginSettings('pig-review'), {})
    await rm(reviewConfig)
    await writeFile(oldReviewConfig, JSON.stringify({ 'pi-review': [] }))
    await assert.rejects(module.getPluginSettings('pig-review'), /Invalid review settings namespace/)
    await assert.rejects(module.setPluginSettings('pig-review', { thinking: 'high' }), /Invalid review settings namespace/)
    await assert.rejects(readReviewSettings(), /Invalid review settings namespace/)
    assert.equal(existsSync(reviewConfig), false, 'invalid old settings cannot be silently migrated')
    await rm(oldReviewConfig)
    await assert.rejects(module.setPluginSettings('pig-review', { provider: 'test' }), /both provider and model ID/)
    await module.setPluginSettings('pig-review', { provider: ' test ', modelId: ' review-model ', thinking: 'high' })
    assert.deepEqual(await module.getPluginSettings('pig-review'), { provider: 'test', modelId: 'review-model', thinking: 'high' })
    await assert.rejects(module.setPluginSettings('pig-review', { thinking: 'invalid' }), /Invalid choice/)
    await assert.rejects(module.setPluginSettings('pig-review', { provider: null }), /both provider and model ID/)
    await module.setPluginSettings('pig-review', { provider: null, modelId: null })
    assert.deepEqual(await module.getPluginSettings('pig-review'), { thinking: 'high' })
    await module.setPluginSettings('pig-review', { thinking: null })
    assert.deepEqual(await module.getPluginSettings('pig-review'), {})
    const defaultScopes = [['project'], ['project', 'chat'], ['project'], ['project'], ['project'], ['project'], ['project', 'chat'], ['project', 'chat']]
    assert.deepEqual((await module.listPlugins()).map((item) => item.scopes), defaultScopes)
    const bundledPaths = await module.enabledPluginPaths('project')
    assert.equal(bundledPaths.some((path) => path.endsWith(join('plugins', 'observational-memory', 'index.ts'))), false)
    assert.deepEqual(await module.enabledPluginPaths('chat'), [webAccessBundle, settingsPath, sessionPath].filter(existsSync))
    assert.ok(bundledPaths.some((path) => path.endsWith(join('plugins', 'pig-review', 'index.ts'))))
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
    assert.deepEqual(module.subagentPluginPaths(bundledPaths), bundledPaths.filter((path) => ![subagentPath, browserPath, terminalPath, processPath, settingsPath, sessionPath, personaBundle].includes(path)), 'children cannot alter global mood or settings, spawn, control window tools or own processes')
    assert.equal(bundledPaths.some((path) => path.endsWith(join('system-plugins', 'pig-web', 'index.js'))), existsSync(webAccessBundle))
    assert.equal((await module.listPlugins()).some(item => item.id === 'pig-persona' || item.id === 'observational-memory'), false)
    assert.equal(bundledPaths.includes(personaBundle), false)
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
    await assert.rejects(module.updatePluginScopes({ 'pig-terminal': [], 'pig-review': [] }, () => { throw new Error('stale') }), /stale/)
    await assert.rejects(module.updatePluginScopes({ 'pig-terminal': [], missing: [] }), /Plugin not found/)
    assert.deepEqual(JSON.parse(await readFile(registryFile, 'utf8')).terminalScopes, ['chat'])
    let seen: Record<string, PluginScope[]> | undefined
    const batch = await module.updatePluginScopes({ 'pig-terminal': ['project'], 'pig-review': [] }, (current) => { seen = current })
    assert.deepEqual(seen?.['pig-terminal'], ['chat'], 'the check sees the state it guards')
    assert.deepEqual([batch['pig-terminal'], batch['pig-review']], [['project'], []])
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
    assert.deepEqual((await module.listPlugins()).map((item) => item.scopes), [[], ['project'], ['project'], ['project'], ['project'], ['project'], ['project', 'chat'], ['project', 'chat'], ['project']])
    assert.deepEqual(await module.enabledPluginPaths('chat'), [settingsPath, sessionPath].filter(existsSync), 'legacy switches do not change new built-in defaults')
    await module.setPluginScopes('legacy', ['chat', 'project', 'chat'])
    const migrated = JSON.parse(await readFile(registryFile, 'utf8'))
    assert.equal(migrated.version, 2)
    assert.equal(migrated.memoryEnabled, true, 'plugin saves preserve legacy feature preferences without interpreting them')
    assert.deepEqual(migrated.reviewScopes, [])
    assert.deepEqual(migrated.webAccessScopes, ['project'])
    const webPlugin = (await module.listPlugins()).find((item) => item.id === 'pig-web')!
    assert.equal(webPlugin.name, 'Web')
    assert.deepEqual(webPlugin.scopes, ['project'], 'the renamed plugin retains saved web scopes')
    assert.deepEqual((await module.pluginScopes())['pig-web'], ['project'])
    assert.deepEqual(migrated.terminalScopes, ['project'])
    assert.deepEqual(migrated.settingsScopes, ['project', 'chat'])
    assert.deepEqual(migrated.installed[0].scopes, ['project', 'chat'])
    assert.deepEqual((await module.listPlugins()).map((item) => item.scopes), [[], ['project'], ['project'], ['project'], ['project'], ['project'], ['project', 'chat'], ['project', 'chat'], ['project', 'chat']], 'saved scopes override defaults')
    assert.equal(migrated.installed[0].enabled, undefined)
    await rm(registryFile)

    for (const id of ['pig-review', 'pig-web', 'pig-subagent', 'pig-browser', 'pig-terminal', 'pig-process', 'pig-settings', 'pig-session']) await module.setPluginScopes(id, [])
    assert.deepEqual(await module.enabledPluginPaths('project'), [])
    await assert.rejects(module.setPluginScopes('pig-persona', []), /Plugin not found/)
    await assert.rejects(module.setPluginScopes('observational-memory', []), /Plugin not found/)
    await module.setPluginScopes('pig-review', ['chat'])
    assert.deepEqual(await module.enabledPluginPaths('project'), [])
    assert.ok((await module.enabledPluginPaths('chat')).some((path) => path.endsWith(join('plugins', 'pig-review', 'index.ts'))))
    await module.setPluginScopes('pig-review', ['project', 'chat'])
    assert.deepEqual((await module.listPlugins()).find((item) => item.id === 'pig-review')?.scopes, ['project', 'chat'])
    await module.setPluginScopes('pig-review', ['project'])
    assert.deepEqual(await module.enabledPluginPaths('chat'), [])
    if (existsSync(webAccessBundle)) {
      await module.setPluginScopes('pig-web', ['project'])
      assert.ok((await module.enabledPluginPaths('project')).some((path) => path.endsWith(join('system-plugins', 'pig-web', 'index.js'))))
      await module.setPluginScopes('pig-web', [])
    }
    await module.setPluginScopes('pig-review', [])
    await assert.rejects(module.setPluginScopes('pig-review', ['unknown'] as unknown as PluginScope[]), /Invalid plugin scopes/)
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
    assert.deepEqual(await module.getMemoryDefaults(), {
      observeAfterTokens: 10000, reflectAfterTokens: 20000, compactAfterTokens: 81000,
      compactAfterTokensRatio: 0.68, observationsPoolMaxTokens: 20000,
      observationsPoolTargetTokens: 10000, agentMaxTurns: 16, agentMaxTokens: 32000,
      compactionCatchUpMaxChunks: 2
    })
    assert.deepEqual(await module.getMemorySettings(), {})
    const settingsFile = join(root, 'pig', 'plugins', 'observational-memory', 'settings.json')
    await module.setMemorySettings({ passive: true, debugLog: false })
    const privateSettings = JSON.parse(await readFile(settingsFile, 'utf8'))
    assert.deepEqual(privateSettings['observational-memory'], { passive: true, debugLog: false })
    await module.setMemorySettings({ observeAfterTokens: 800, passive: null })
    assert.deepEqual((await module.getMemorySettings()), { observeAfterTokens: 800, debugLog: false })
    assert.deepEqual(JSON.parse(await readFile(agentSettings, 'utf8')), { 'observational-memory': { passive: true, observeAfterTokens: 999 } })
    const { loadConfig } = await import('../src/main/features/memory/config')
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
    const { runObserver } = await import('../src/main/features/memory/agents/observer/agent')
    let observerPrompt = ''
    await runObserver({
      model: { provider: 'test', maxTokens: 1000 } as import('@earendil-works/pi-ai').Model<any>,
      priorReflections: [], priorObservations: [], chunk: '[Source entry id: source] hello', allowedSourceEntryIds: ['source'],
      streamSimple: (() => { throw new Error('No model call expected') }) as import('../src/main/features/memory/agents/worker-stream').WorkerStreamSimple,
      agentLoop: ((_prompts, context) => {
        const system = context.messages.find((message) => message.role === 'system')
        observerPrompt = system?.role === 'system' && typeof system.content === 'string' ? system.content : ''
        return { async *[Symbol.asyncIterator]() {}, result: async () => [] } as unknown as ReturnType<typeof import('@earendil-works/pi-agent-core').agentLoop>
      }) as typeof import('@earendil-works/pi-agent-core').agentLoop
    })
    assert.match(observerPrompt, /observation agent/)
    await assert.rejects(module.setMemorySettings({ compactAfterTokensRatio: 3 }), /Ratio/)
    // The fallback model is written by the settings pane, so the allowlist has to accept it
    // and keep it out of the sibling `model` slot.
    const withFallback = await module.setMemorySettings({ fallbackModel: { provider: 'test', id: 'small', thinking: 'low' } })
    assert.deepEqual(withFallback.fallbackModel, { provider: 'test', id: 'small', thinking: 'low' })
    // Malformed payloads must be rejected at runtime, not just by the type contract.
    const malformed = (value: unknown) => ({ fallbackModel: value }) as MemorySettingsPatch
    await assert.rejects(module.setMemorySettings(malformed({ provider: 'test' })), /Invalid memory model/)
    await assert.rejects(module.setMemorySettings(malformed({ provider: 'test', id: 'small', thinking: 'bogus' })), /Invalid memory model/)
    await module.setMemorySettings({ fallbackModel: null })
    assert.equal((await module.getMemorySettings()).fallbackModel, undefined)
    const idleSettings = await module.setMemorySettings({ compactionCatchUpMaxChunks: 0, consolidateWhenIdle: true })
    assert.equal(idleSettings.compactionCatchUpMaxChunks, 0)
    assert.equal(idleSettings.consolidateWhenIdle, true)
    assert.equal(loadConfig().compactionCatchUpMaxChunks, 0)
    assert.equal(loadConfig().consolidateWhenIdle, true)
    await assert.rejects(module.setMemorySettings({ compactionCatchUpMaxChunks: -1 }))
    await assert.rejects(module.setMemorySettings({ compactionCatchUpMaxChunks: 0.5 }))
    await module.setMemorySettings({ compactionCatchUpMaxChunks: null, consolidateWhenIdle: null })
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

    const packagedPlugins = join(root, 'resources', 'system-plugins')
    await mkdir(packagedPlugins, { recursive: true })
    for (const name of ['pig-review', 'pig-ui.ts']) {
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
    assert.doesNotMatch(builderConfig, /to: system-plugins\/pig-persona/)
    assert.match(builderConfig, /to: licenses\/observational-memory-LICENSE/)
    const { conversationFeatureFactories } = await import('../src/main/features/runtime')
    const memoryLoader = await createNoExtensionsResourceLoader(root, [join(packagedPlugins, 'pig-review', 'index.ts')], {
      extensionFactories: conversationFeatureFactories()
    })
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
      const { memoryStatus, memoryView } = await import('../src/main/features/memory/details')
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
      const { memoryRuntime } = await import('../src/main/features/memory/runtime')
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

    const { DEFAULTS } = await import('../src/main/features/memory/config')
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
    const { exitCode: code, stdout, stderr } = await runSelf(import.meta.path, ['--plugins-fixture'], {
      cwd: new URL('..', import.meta.url).pathname,
      timeoutMs: 20_000
    })
    assert.equal(code, 0, stderr || stdout)
  })
}
