import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  try {
    const module = await import('../src/main/pi/plugins')
    const ui = await import('../src/main/pi/plugin-ui')
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
    assert.equal((await module.listPlugins())[0]?.enabled, true)
    assert.equal(await module.isMemoryPluginEnabled(), true)
    const bundledPaths = await module.enabledPluginPaths()
    assert.ok(bundledPaths.some((path) => path.endsWith(join('plugins', 'observational-memory', 'index.ts'))))
    assert.ok(bundledPaths.some((path) => path.endsWith(join('plugins', 'pi-review', 'index.ts'))))
    assert.equal(bundledPaths.some((path) => path.endsWith(join('system-plugins', 'pi-web-access', 'index.js'))), existsSync(webAccessBundle))
    for (const id of ['observational-memory', 'pi-review', 'pi-web-access']) await module.setPluginEnabled(id, false)
    assert.deepEqual(await module.enabledPluginPaths(), [])
    await module.setPluginEnabled('pi-review', true)
    assert.ok((await module.enabledPluginPaths()).some((path) => path.endsWith(join('plugins', 'pi-review', 'index.ts'))))
    if (existsSync(webAccessBundle)) {
      await module.setPluginEnabled('pi-web-access', true)
      assert.ok((await module.enabledPluginPaths()).some((path) => path.endsWith(join('system-plugins', 'pi-web-access', 'index.js'))))
      await module.setPluginEnabled('pi-web-access', false)
    }
    await module.setPluginEnabled('pi-review', false)
    assert.deepEqual(await module.enabledPluginPaths(), [])
    await module.installPlugin(plugin)
    const installed = (await module.listPlugins()).find((item) => item.kind === 'local')!
    assert.equal(installed.kind, 'local')
    assert.equal(installed.enabled, false)
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
    await module.setPluginEnabled(installed.id, true)
    const paths = await module.enabledPluginPaths()
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
    await module.setPluginEnabled(installed.id, false)
    assert.deepEqual(await module.enabledPluginPaths(), [])
    await mkdir(join(root, '.pi'), { recursive: true })
    await writeFile(join(root, '.pi', 'settings.json'), JSON.stringify({ packages: [plugin] }))
    const { createNoExtensionsResourceLoader } = await import('../src/main/pi/chat-resources')
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
      observationsPoolTargetTokens: 10000, agentMaxTurns: 16, agentMaxTokens: 32000
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

    const requests: { channel: string; payload: any }[] = []
    const sender = { send: (channel: string, payload: any) => { requests.push({ channel, payload }) }, isDestroyed: () => false }
    const win = { webContents: sender, isDestroyed: () => false } as unknown as import('electron').BrowserWindow
    const context = ui.createPluginUI('one', win)
    const choice = context.select('Select', ['yes', 'no'])
    const request = requests.at(-1)!.payload
    ui.replyPluginUI({} as import('electron').WebContents, request.id, 'yes')
    ui.replyPluginUI(sender as unknown as import('electron').WebContents, request.id, 'invalid')
    assert.equal(await choice, undefined)
    const confirmation = context.confirm('Confirm', 'OK?')
    ui.cancelPluginPrompts('one')
    assert.equal(await confirmation, false)
    const input = context.input('Input', 'hint', { timeout: 5 })
    assert.equal(await input, undefined)
    assert.equal(requests.at(-1)?.payload.kind, 'dismiss')
    const controller = new AbortController()
    const aborted = context.confirm('Abort', 'Cancel?', { signal: controller.signal })
    controller.abort()
    assert.equal(await aborted, false)
    assert.equal(requests.at(-1)?.payload.kind, 'dismiss')

    await module.setPluginEnabled('observational-memory', true)
    assert.equal(await module.isMemoryPluginEnabled(), true)
    const memoryLoader = await createNoExtensionsResourceLoader(root, await module.enabledPluginPaths())
    assert.deepEqual(memoryLoader.getExtensions().errors, [])
    const { session } = await sdk.createAgentSession({
      cwd: root, agentDir: join(root, 'agent'), resourceLoader: memoryLoader,
      settingsManager: sdk.SettingsManager.inMemory({}), noTools: 'all'
    })
    try {
      await session.bindExtensions({ mode: 'rpc', uiContext: context })
      const commands = session.extensionRunner.getRegisteredCommands().map((command) => command.invocationName)
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
      runtime.lastObserverError = 'memory worker failed'
      assert.match(memoryStatus(session.sessionId, branch), /memory worker failed/)
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
      assert.equal(memoryRuntime(session.sessionId), undefined)
    } finally {
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
    await module.setPluginEnabled(brokenPlugin.id, true)
    assert.ok((await module.enabledPluginPaths()).some((path) => path === join(broken, 'extensions', 'entry.ts')))
    await module.setPluginEnabled(brokenPlugin.id, false)

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
