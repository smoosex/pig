import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture(name: string): Promise<void> {
  if (name === 'preparation' || name === 'child-close-failure') {
    const root = await mkdtemp(join(tmpdir(), 'pig-controls-preparation-'))
    const previousPig = process.env.PIG_DIR
    process.env.PIG_DIR = join(root, 'pig')
    const started = deferred()
    const release = deferred()
    let registry: typeof import('../src/main/pi/session-registry') | undefined
    const applied: Array<{ kind: string; live: boolean }> = []
    const manager = {
      getSessionId: () => 'draft',
      getSessionFile: () => join(root, 'draft.jsonl'),
      getHeader: () => ({ type: 'session', id: 'draft' }),
      setSessionFile() {}
    }
    let aborted = false
    let disposed = false
    let unsubscribed = false
    const shutdownError = Object.assign(new Error('index write failed'), { code: 'ENOSPC' })
    if (name === 'child-close-failure') {
      mock.module(fileURLToPath(new URL('../src/main/subagents/service.ts', import.meta.url)), () => ({
        closeSubagents: async () => { throw shutdownError }
      }))
    }
    const session = {
      sessionId: 'draft', bindExtensions: async () => {},
      agent: { streamFunction: () => { throw new Error('Unexpected model request') } },
      subscribe: () => () => { unsubscribed = true },
      abort: async () => { aborted = true }, dispose() { disposed = true },
      extensionRunner: { emit: async () => {} }
    }
    mock.module('electron', () => ({ app: { isPackaged: false } }))
    const sdk = await import('@earendil-works/pi-coding-agent')
    const resourceSettings = sdk.SettingsManager.fromStorage({ withLock(_scope, fn) { assert.equal(fn('{"packages":[]}'), undefined) } })
    mock.module('@earendil-works/pi-coding-agent', () => ({
      ...sdk,
      createAgentSession: async () => ({ session }),
      SessionManager: { create: () => manager }
    }))
    mock.module(fileURLToPath(new URL('../src/main/pi/model-settings.ts', import.meta.url)), () => ({
      startModelRuntime: async () => ({}), getDefaultSessionSettings() {},
      setDefaultModel() {}, setDefaultThinking() {}
    }))
    mock.module(fileURLToPath(new URL('../src/main/pi/model-catalog.ts', import.meta.url)), () => ({ synchronizeModelCatalog() {} }))
    mock.module(fileURLToPath(new URL('../src/main/pi/session-controls.ts', import.meta.url)), () => ({
      applyPendingControls: async () => { started.resolve(); await release.promise },
      setSessionModel: async (state: object) => { applied.push({ kind: 'model', live: 'agentSession' in state }) },
      setSessionThinking: async (state: object) => { applied.push({ kind: 'thinking', live: 'agentSession' in state }) },
      controlsFor() {},
      tokenStatsFor: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 })
    }))
    mock.module(fileURLToPath(new URL('../src/main/pi/chat-resources.ts', import.meta.url)), () => ({
      sessionResourceSettings: () => resourceSettings,
      createChatResourceLoader: async () => ({ getExtensions: () => ({ extensions: [], errors: [] }) }),
      createNoExtensionsResourceLoader: async () => ({ getExtensions: () => ({ extensions: [], errors: [] }) })
    }))
    mock.module(fileURLToPath(new URL('../src/main/chats.ts', import.meta.url)), () => ({
      createChatDir: async () => '/chat',
      isChatCwd: () => false
    }))
    mock.module(fileURLToPath(new URL('../src/main/project-worktrees.ts', import.meta.url)), () => ({ worktrees: { assertAvailable() {} } }))
    try {
      registry = await import('../src/main/pi/session-registry')
      const { sessionId } = registry.createPendingSession(root, {} as import('electron').BrowserWindow)
      const preparing = registry.prepareSession(sessionId)
      await started.promise
      const model = registry.setSessionModel(sessionId, 'test', 'new-model')
      const thinking = registry.setSessionThinking(sessionId, 'high')
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.deepEqual(applied, [])
      release.resolve()
      await Promise.all([preparing, model, thinking])
      assert.deepEqual(applied, [{ kind: 'model', live: true }, { kind: 'thinking', live: true }])
      if (name === 'child-close-failure') {
        await assert.rejects(registry.closeSession(sessionId), (error) => error === shutdownError)
        assert.equal(aborted, true)
        assert.equal(disposed, true)
        assert.equal(unsubscribed, true)
        assert.equal(registry.getLive(sessionId), undefined)
      }
    } finally {
      release.resolve()
      await registry?.disposeAll()
      if (previousPig === undefined) delete process.env.PIG_DIR
      else process.env.PIG_DIR = previousPig
      await rm(root, { recursive: true, force: true })
    }
    return
  }

  if (name === 'runtime') {
    let creates = 0
    const logged: unknown[][] = []
    const originalError = console.error
    console.error = (...values) => { logged.push(values) }
    const runtime = { refresh: async () => { throw new Error('refresh unavailable') }, getAvailableSnapshot: () => [] }
    mock.module('@earendil-works/pi-coding-agent', () => ({
      ModelRuntime: { create: async () => {
        if (++creates === 1) throw new Error('temporary startup failure')
        return runtime
      } },
      SettingsManager: {}
    }))
    mock.module('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
    try {
      const { startModelRuntime } = await import('../src/main/pi/model-settings')
      const first = startModelRuntime()
      const concurrent = startModelRuntime()
      assert.equal(first, concurrent)
      await assert.rejects(first, /temporary startup failure/)
      assert.equal(await startModelRuntime(), runtime)
      assert.equal(await startModelRuntime(), runtime)
      assert.equal(creates, 2, 'the failed create is retried, the good one is reused')
      assert.deepEqual(logged, [])
      // The catalog owns the refresh, and a failed one is reported rather than left unhandled.
      const { startModelCatalog } = await import('../src/main/pi/model-catalog')
      startModelCatalog()
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(logged.length, 1)
      assert.match(String(logged[0][1]), /refresh unavailable/)
    } finally {
      console.error = originalError
    }
    return
  }

  if (name === 'controls') {
    const model = { id: 'reasoner', provider: 'test', name: 'Reasoner', reasoning: true, contextWindow: 1000 }
    const recorded = { id: 'recorder', provider: 'test', name: 'Recorder', reasoning: true, contextWindow: 500 }
    let available = true
    const sdk = await import('@earendil-works/pi-coding-agent')
    mock.module('@earendil-works/pi-coding-agent', () => ({
      ...sdk,
      ModelRuntime: { create: async () => ({
        refresh: async () => {},
        getModel: (_provider: string, id: string) => available ? [model, recorded].find((entry) => entry.id === id) : undefined,
        getProvider: () => ({ name: 'Test' }),
        getAvailableSnapshot: () => available ? [model, recorded] : []
      }) },
      SettingsManager: { create: () => ({
        getDefaultProvider: () => 'test', getDefaultModel: () => 'reasoner',
        getModelThinkingLevel: () => 'high', getDefaultThinkingLevel: () => 'medium'
      }) }
    }))
    const controls = await import('../src/main/pi/session-controls')
    const pending = {
      sessionId: 'draft', cwd: '/tmp', win: {},
      sessionManager: {
        getEntries: () => [],
        getBranch: () => [],
        buildSessionContext: () => ({ messages: [], thinkingLevel: 'off', model: null })
      }
    } as unknown as import('../src/main/pi/session-state').PendingSession
    const selected = await controls.setSessionModel(pending, 'test', 'reasoner')
    assert.equal(selected.thinkingLevel, 'high')
    assert.equal(selected.contextUsage?.contextWindow, 1000)
    assert.equal(pending.thinkingLevel, selected.thinkingLevel)
    let applied: string | undefined
    const session = {
      setModel: async () => {},
      setThinkingLevel: (level: string) => { applied = level },
      getAvailableThinkingLevels: () => ['low', 'medium', 'high']
    } as unknown as import('@earendil-works/pi-coding-agent').AgentSession
    await controls.applyPendingControls(pending, session)
    assert.equal(applied, selected.thinkingLevel)
    await assert.rejects(controls.setSessionThinking({ sessionId: 'live', cwd: '/tmp', agentSession: session, pluginPaths: [], unsubscribe() {} }, 'max'), /not supported/)
    available = false
    await assert.rejects(controls.applyPendingControls(pending, session), /Model not found/)

    available = true
    const opened = (branch: unknown[], messages: unknown[] = []) => ({
      sessionId: 'opened', cwd: '/tmp', win: {},
      sessionManager: {
        getEntries: () => [],
        getBranch: () => branch,
        buildSessionContext: () => ({
          messages, thinkingLevel: 'off', model: { provider: 'test', modelId: 'recorder' }
        })
      }
    }) as unknown as import('../src/main/pi/session-state').PendingSession
    const recordedModel = [{ type: 'model_change', provider: 'test', modelId: 'recorder' }]
    const asked = { role: 'user', content: 'x'.repeat(400), timestamp: 0 }
    const answered = {
      role: 'assistant', content: [], stopReason: 'stop', timestamp: 1,
      usage: { input: 40, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }
    }
    const restored = await controls.controlsFor(opened([...recordedModel, { type: 'thinking_level_change', thinkingLevel: 'low' }], [asked, answered]))
    assert.equal(restored.model?.id, 'recorder', 'an opened session must not advertise the global default model')
    assert.equal(restored.thinkingLevel, 'low')
    assert.equal(restored.contextUsage?.tokens, 60, 'the recorded assistant usage is the context size')
    assert.equal(restored.contextUsage?.contextWindow, 500)
    assert.equal(restored.contextUsage?.percent, 12)
    const trailing = await controls.controlsFor(opened(recordedModel, [asked, answered, { role: 'user', content: 'y'.repeat(40), timestamp: 2 }]))
    assert.equal(trailing.contextUsage?.tokens, 70, 'messages after the usage are estimated')
    const unreported = await controls.controlsFor(opened(recordedModel, [asked]))
    assert.equal(unreported.contextUsage?.tokens, 100, 'without any usage the messages themselves are estimated')
    const compacted = await controls.controlsFor(opened([
      { type: 'compaction', summary: 's', firstKeptEntryId: 'a', tokensBefore: 1 },
      { type: 'message', message: asked }
    ], [asked]))
    assert.equal(compacted.contextUsage?.tokens, null, 'a compaction without a new reply has an unknown size')
    assert.equal(compacted.contextUsage?.percent, null)
    assert.equal(compacted.contextUsage?.contextWindow, 500)
    const fallback = await controls.controlsFor(opened(recordedModel))
    assert.equal(fallback.model?.id, 'recorder')
    assert.equal(fallback.thinkingLevel, 'high', 'without a recorded change the settings default wins over the file default')
    return
  }

  if (name === 'auth') {
    const firstStarted = deferred()
    const releaseFirst = deferred()
    const secondStarted = deferred()
    const events: Array<{ kind: string; id: string }> = []
    const urls: string[] = []
    let firstNotify: ((event: { type: string; url: string }) => void) | undefined
    const runtime = {
      refresh: async () => {},
      login: async (provider: string, _type: string, options: {
        prompt: (prompt: { type: string; message: string }) => Promise<string>
        notify: (event: { type: string; url: string }) => void
      }) => {
        if (provider === 'first') {
          firstNotify = options.notify
          const reply = options.prompt({ type: 'secret', message: 'first' })
          firstStarted.resolve()
          try { await reply } catch {}
          await releaseFirst.promise
          throw new Error('old login cancelled')
        }
        const reply = options.prompt({ type: 'secret', message: 'second' })
        secondStarted.resolve()
        assert.equal(await reply, 'second-reply')
      }
    }
    mock.module('electron', () => ({ shell: { openExternal: async (url: string) => { urls.push(url) } }, BrowserWindow: { getAllWindows: () => [] } }))
    mock.module(fileURLToPath(new URL('../src/main/pi/model-settings.ts', import.meta.url)), () => ({
      startModelRuntime: async () => runtime,
      getOrCreateDeviceId: () => { throw new Error('API-key login must not request a device ID') }
    }))
    mock.module(fileURLToPath(new URL('../src/main/pi/model-catalog.ts', import.meta.url)), () => ({
      synchronizeModelCatalog: () => ({ models: [], revision: 0, refreshing: false })
    }))
    const { loginProvider, resolveAuthPrompt } = await import('../src/main/pi/providers')
    const win = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: (_channel: string, event: { kind: string; id: string }) => { events.push(event) } }
    } as unknown as import('electron').BrowserWindow
    const first = loginProvider(win, 'first', 'api_key').then(() => null, (error) => error)
    await firstStarted.promise
    const second = loginProvider(win, 'second', 'api_key')
    await secondStarted.promise
    firstNotify?.({ type: 'auth_url', url: 'https://old.example/login' })
    releaseFirst.resolve()
    assert.match(String(await first), /Login cancelled/)
    resolveAuthPrompt(events[1].id, 'second-reply')
    await second
    assert.deepEqual(urls, [])
    return
  }

  if (name === 'auth-device-id' || name === 'auth-device-id-existing') {
    const root = await mkdtemp(join(tmpdir(), 'pig-auth-device-id-'))
    const agentDir = join(root, 'agent')
    const projectId = '11111111-1111-4111-8111-111111111111'
    const existingId = name === 'auth-device-id-existing'
      ? '22222222-2222-4222-8222-222222222222'
      : undefined
    await mkdir(agentDir)
    await mkdir(join(root, '.pi'))
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'openai', deviceId: existingId }))
    await writeFile(join(root, '.pi', 'settings.json'), JSON.stringify({ deviceId: projectId }))
    const sdk = await import('@earendil-works/pi-coding-agent')
    const RealSettingsManager = sdk.SettingsManager
    const settings = RealSettingsManager.create(root, agentDir)
    const deviceIds: string[] = []
    let creates = 0
    const runtime = {
      login: async (_provider: string, type: string, _interaction: unknown, options?: Parameters<import('@earendil-works/pi-coding-agent').ModelRuntime['login']>[3]) => {
        if (type === 'api_key') {
          assert.equal(options, undefined, 'API-key login needs no installation identity')
          return
        }
        assert.equal(typeof options?.getDeviceId, 'function', 'login must supply the SDK installation-ID callback')
        const id = options?.getDeviceId?.()
        assert.ok(id)
        assert.equal(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')).deviceId, id, 'the ID is on disk before the SDK login flow uses it')
        assert.match(id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i)
        assert.notEqual(id, projectId, 'project settings cannot supply an installation identity')
        if (existingId) assert.equal(id, existingId, 'reuse the identity already saved by pi')
        deviceIds.push(id)
      },
      refresh: async () => {}
    }
    mock.module('electron', () => ({ shell: {} }))
    mock.module('@earendil-works/pi-coding-agent', () => ({
      ...sdk,
      ModelRuntime: { create: async () => runtime },
      SettingsManager: { create: () => { creates++; return settings } }
    }))
    mock.module(fileURLToPath(new URL('../src/main/pi/model-catalog.ts', import.meta.url)), () => ({ synchronizeModelCatalog() {} }))
    try {
      const { loginProvider } = await import('../src/main/pi/providers')
      const win = { isDestroyed: () => false, webContents: { isDestroyed: () => false } } as import('electron').BrowserWindow
      await loginProvider(win, 'openai', 'api_key')
      assert.equal(creates, 0, 'login flows that do not need an ID must not create one')
      await loginProvider(win, 'openai', 'oauth')
      const saved = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'))
      assert.equal(saved.deviceId, deviceIds[0], 'the installation ID is persisted before a later launch')
      assert.equal(saved.defaultProvider, 'openai', 'identity creation preserves other pi settings')
      await loginProvider(win, 'openai', 'oauth')
      assert.deepEqual(deviceIds, [saved.deviceId, saved.deviceId], 'retries use the same installation ID')
      assert.equal(creates, 1, 'identity and model preferences share the settings manager')
      const restored = RealSettingsManager.create(root, agentDir)
      assert.notEqual(restored, settings, 'restoration reads through a fresh real SDK manager')
      assert.equal(restored.getGlobalSettings().deviceId, saved.deviceId, 'a new settings manager restores the persisted identity')
      await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'openai' }))
      assert.equal(RealSettingsManager.create(root, agentDir).getGlobalSettings().deviceId, undefined, 'restoration depends on the on-disk ID, not the mocked manager')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
    return
  }

  if (['auth-device-id-malformed', 'auth-device-id-cached-malformed', 'auth-device-id-unreadable', 'auth-device-id-write-failure'].includes(name)) {
    const root = await mkdtemp(join(tmpdir(), 'pig-auth-device-id-error-'))
    const agentDir = join(root, 'agent')
    const settingsPath = join(agentDir, 'settings.json')
    const malformed = '{"deviceId":'
    const initial = name === 'auth-device-id-malformed' ? malformed : '{"defaultProvider":"openai"}'
    await mkdir(agentDir)
    if (name === 'auth-device-id-unreadable') await mkdir(settingsPath)
    else await writeFile(settingsPath, initial)
    const sdk = await import('@earendil-works/pi-coding-agent')
    const writeError = Object.assign(new Error('Fixture denied settings write'), { code: 'EACCES' })
    let writeAttempts = 0
    const settings = name === 'auth-device-id-write-failure'
      ? sdk.SettingsManager.fromStorage({
          withLock: (scope, fn) => {
            const next = fn(scope === 'global' ? readFileSync(settingsPath, 'utf8') : undefined)
            if (next !== undefined) {
              writeAttempts++
              throw writeError
            }
          }
        })
      : sdk.SettingsManager.create(root, agentDir)
    if (name === 'auth-device-id-cached-malformed') await writeFile(settingsPath, malformed)
    let logins = 0
    let refreshes = 0
    const runtime = {
      login: async () => { logins++ },
      refresh: async () => { refreshes++ }
    }
    mock.module('electron', () => ({ shell: {} }))
    mock.module('@earendil-works/pi-coding-agent', () => ({
      ...sdk,
      ModelRuntime: { create: async () => runtime },
      SettingsManager: { create: () => settings }
    }))
    mock.module(fileURLToPath(new URL('../src/main/pi/model-catalog.ts', import.meta.url)), () => ({ synchronizeModelCatalog() {} }))
    try {
      const { loginProvider } = await import('../src/main/pi/providers')
      const win = { isDestroyed: () => false, webContents: { isDestroyed: () => false } } as import('electron').BrowserWindow
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(loginProvider(win, 'openai', 'oauth'), (error) => {
          assert.ok(error instanceof AggregateError)
          assert.ok(error.errors.length > 0)
          for (const cause of error.errors) {
            if (name === 'auth-device-id-write-failure') assert.equal(cause, writeError)
            else if (name === 'auth-device-id-unreadable') assert.equal(cause.code, 'EISDIR')
            else assert.ok(cause instanceof SyntaxError)
          }
          return true
        })
      }
      assert.equal(logins, 0, 'settings failures stop login before the SDK can use an unpersisted ID')
      assert.equal(refreshes, 0, 'failed identity persistence cannot publish a successful login refresh')
      assert.equal(writeAttempts, name === 'auth-device-id-write-failure' ? 2 : 0)
      if (name === 'auth-device-id-unreadable') await assert.rejects(readFile(settingsPath), { code: 'EISDIR' })
      else assert.equal(await readFile(settingsPath, 'utf8'), name === 'auth-device-id-cached-malformed' ? malformed : initial, 'failed login leaves settings untouched')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
    return
  }

  if (name === 'auth-refresh') {
    const refreshing = deferred()
    let stall = true
    let targeted = 0
    let full = 0
    let cancelled = false
    let models: import('../src/shared/api').SessionModelInfo[] = []
    const pushed: import('../src/shared/api').ModelCatalog[] = []
    const runtime = {
      login: async () => {
        models = [{ id: 'new', name: 'New', provider: 'test', providerName: 'Test', contextWindow: 100, reasoning: false }]
      },
      logout: async () => { models = [] },
      refresh: async (options?: { providers: string[]; signal: AbortSignal }) => {
        if (!options) {
          full++
          return new Promise<void>(() => {})
        }
        targeted++
        assert.deepEqual(options.providers, ['test'])
        if (!stall) return
        refreshing.resolve()
        await new Promise<void>((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            cancelled = true
            reject(options.signal.reason)
          }, { once: true })
        })
      }
    }
    mock.module('electron', () => ({
      shell: {},
      BrowserWindow: { getAllWindows: () => [{
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: (_channel: string, value: import('../src/shared/api').ModelCatalog) => pushed.push(value) }
      }] }
    }))
    mock.module(fileURLToPath(new URL('../src/main/pi/model-settings.ts', import.meta.url)), () => ({
      startModelRuntime: async () => runtime,
      getOrCreateDeviceId: () => { throw new Error('API-key login must not request a device ID') },
      availableModels: () => models
    }))
    const { loginProvider, cancelProviderLogin, logoutProvider } = await import('../src/main/pi/providers')
    const { currentModelCatalog } = await import('../src/main/pi/model-catalog')
    await currentModelCatalog()
    const win = { isDestroyed: () => false, webContents: { isDestroyed: () => false } } as import('electron').BrowserWindow
    const login = loginProvider(win, 'test', 'api_key')
    const rejected = assert.rejects(login, (error) => error instanceof Error)
    await refreshing.promise
    cancelProviderLogin()
    await rejected
    assert.equal(cancelled, true, 'cancellation reaches the targeted refresh')
    assert.equal(full, 0, 'login must never wait for an unrelated full refresh')
    assert.deepEqual(pushed.at(-1)!.models.map((model) => model.id), ['new'], 'credential changes remain visible after cancellation')
    stall = false
    await loginProvider(win, 'test', 'api_key')
    assert.equal(targeted, 2, 'another login is not blocked after cancellation')
    await logoutProvider('test')
    assert.equal(full, 0, 'logout also only publishes the synchronized snapshot')
    assert.deepEqual(pushed.at(-1)!.models, [])
    return
  }

  if (name.startsWith('native-theme')) {
    const root = await mkdtemp(join(tmpdir(), 'pig-native-theme-'))
    const previous = process.env.PIG_DIR
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    const osPlatform = name === 'native-theme' ? 'darwin' : name === 'native-theme-linux' ? 'linux' : 'win32'
    const supported = name === 'native-theme' || name === 'native-theme-windows'
    const version = name === 'native-theme-windows10' ? '10.0.19045' : name === 'native-theme-windows11-old' ? '10.0.22000' : '10.0.22621'
    Object.defineProperty(process, 'platform', { ...platform, value: osPlatform })
    const os = await import('node:os')
    mock.module('node:os', () => ({ ...os, release: () => version }))
    const nativeTheme = { themeSource: 'system' }
    const materials: Array<[string, string | null]> = []
    const window = {
      isDestroyed: () => false,
      setBackgroundColor: (value: string) => materials.push(['background', value]),
      setVibrancy: (value: string | null) => materials.push(['vibrancy', value]),
      setBackgroundMaterial: (value: string) => materials.push(['backgroundMaterial', value])
    }
    const handlers = new Map<string, (...args: any[]) => Promise<unknown>>()
    const noop = () => {}
    mock.module('electron', () => ({
      app: { isPackaged: false },
      BrowserWindow: { getAllWindows: () => [window] },
      nativeTheme,
      ipcMain: { handle: (channel: string, handler: (...args: any[]) => Promise<unknown>) => handlers.set(channel, handler) }
    }))
    mock.module(fileURLToPath(new URL('../src/main/pi/providers.ts', import.meta.url)), () => ({
      cancelProviderLogin: noop, listProviders: async () => [], loginProvider: noop,
      logoutProvider: noop, resolveAuthPrompt: noop
    }))
    mock.module(fileURLToPath(new URL('../src/main/pi/model-settings.ts', import.meta.url)), () => ({
      getDefaultSessionSettings: async () => ({ model: null, thinkingLevel: null, thinkingLevels: [] }),
      setDefaultModel: noop, setDefaultThinking: noop
    }))
    try {
      process.env.PIG_DIR = join(root, 'settings')
      const { registerSettingsIpc } = await import('../src/main/ipc/settings')
      const { supportsGlass } = await import('../src/main/surface-support')
      const { windowSurfaceOptions } = await import('../src/main/window-surface')
      assert.equal(supportsGlass, supported)
      registerSettingsIpc()
      assert.equal((await handlers.get('settings:get')!({}) as import('../src/shared/api').AppSettings).surfaceStyle, supported ? 'glass' : 'solid')
      const setTheme = handlers.get('settings:set-theme')!
      if (!supported) {
        await mkdir(process.env.PIG_DIR, { recursive: true })
        await writeFile(join(process.env.PIG_DIR, 'settings.json'), '{"version":1,"surfaceStyle":"glass"}')
        assert.equal((await handlers.get('settings:get')!({}) as import('../src/shared/api').AppSettings).surfaceStyle, 'solid', 'copied glass preferences cannot uncover an unsupported window')
        assert.equal((await setTheme({}, { surfaceStyle: 'glass' }) as import('../src/main/pig-settings').PigSettings).surfaceStyle, 'solid')
      }
      for (const appearance of ['dark', 'light', 'system'] as const) {
        const next = await setTheme({}, { appearance }) as import('../src/main/pig-settings').PigSettings
        assert.equal(next.appearance, appearance)
        assert.equal(nativeTheme.themeSource, appearance)
      }
      await setTheme({}, { appearance: 'dark' })
      await setTheme({}, { darkTheme: 'everforest' })
      assert.equal(nativeTheme.themeSource, 'dark', 'palette-only changes preserve the native appearance')
      assert.deepEqual(materials, [], 'appearance and palette changes do not rebuild the material')
      await setTheme({}, { surfaceStyle: 'solid' })
      assert.deepEqual(materials, supported ? [[osPlatform === 'darwin' ? 'vibrancy' : 'backgroundMaterial', osPlatform === 'darwin' ? null : 'none']] : [], 'only supported materials change; the native backing colour stays fixed')
      assert.deepEqual(windowSurfaceOptions(), {
        backgroundColor: supported ? '#00000000' : '#1a1a1a',
        vibrancy: undefined,
        backgroundMaterial: supported && osPlatform === 'win32' ? 'none' : undefined
      }, 'solid windows rely on opaque document paint')
      assert.equal((await handlers.get('settings:get')!({}) as import('../src/shared/api').AppSettings).surfaceStyle, 'solid')
      await setTheme({}, { lightTheme: 'everforest' })
      assert.equal(materials.length, supported ? 1 : 0)
      const glass = await setTheme({}, { surfaceStyle: 'glass' }) as import('../src/main/pig-settings').PigSettings
      assert.equal(glass.surfaceStyle, supported ? 'glass' : 'solid')
      assert.deepEqual(materials.slice(1), supported ? [[osPlatform === 'darwin' ? 'vibrancy' : 'backgroundMaterial', osPlatform === 'darwin' ? 'under-window' : 'acrylic']] : [])
      const glassOptions = {
        backgroundColor: supported ? '#00000000' : '#1a1a1a',
        vibrancy: supported && osPlatform === 'darwin' ? 'under-window' : undefined,
        backgroundMaterial: supported && osPlatform === 'win32' ? 'acrylic' : undefined
      }
      assert.deepEqual(windowSurfaceOptions(), glassOptions)
      const invalid = join(root, 'file')
      await writeFile(invalid, 'not a directory')
      process.env.PIG_DIR = invalid
      await assert.rejects(setTheme({}, { appearance: 'light', surfaceStyle: 'solid' }))
      assert.equal(nativeTheme.themeSource, 'dark', 'a failed save does not change the native appearance')
      assert.equal(materials.length, supported ? 2 : 0, 'failed saves leave native material untouched')
      assert.deepEqual(windowSurfaceOptions(), glassOptions)
    } finally {
      Object.defineProperty(process, 'platform', platform)
      if (previous === undefined) delete process.env.PIG_DIR
      else process.env.PIG_DIR = previous
      await rm(root, { recursive: true, force: true })
    }
    return
  }

  if (name === 'pig-settings') {
    const root = await mkdtemp(join(tmpdir(), 'pig-settings-lifecycle-'))
    const previous = process.env.PIG_DIR
    mock.module('electron', () => ({ app: { isPackaged: false } }))
    try {
      process.env.PIG_DIR = join(root, 'settings')
      const { loadPigSettings, savePigSettings } = await import('../src/main/pig-settings')
      await mkdir(process.env.PIG_DIR, { recursive: true })
      await writeFile(join(process.env.PIG_DIR, 'settings.json'), '{"version":1,"appearance":"light"}')
      const { supportsGlass } = await import('../src/main/surface-support')
      assert.equal((await loadPigSettings()).surfaceStyle, supportsGlass ? 'glass' : 'solid', 'legacy preferences use the supported default surface')
      await Promise.all([
        savePigSettings({ appearance: 'dark' }),
        savePigSettings({ sendShortcut: 'shift-enter' }),
        savePigSettings({ lightTheme: 'everforest' }),
        savePigSettings({ darkTheme: 'everforest' }),
        savePigSettings({ surfaceStyle: 'solid' })
      ])
      assert.deepEqual(await loadPigSettings(), {
        appearance: 'dark', surfaceStyle: 'solid', sendShortcut: 'shift-enter', locale: 'system',
        completionNotifications: true, beamBorderEnabled: true, lightTheme: 'everforest', darkTheme: 'everforest'
      })
      const updating = savePigSettings({ appearance: 'light' })
      assert.equal((await loadPigSettings()).appearance, 'light')
      await updating
      const invalid = join(root, 'file')
      await writeFile(invalid, 'not a directory')
      process.env.PIG_DIR = invalid
      await assert.rejects(savePigSettings({ appearance: 'system' }))
      process.env.PIG_DIR = join(root, 'settings')
      assert.equal((await savePigSettings({ appearance: 'system' })).sendShortcut, 'shift-enter')
      assert.equal((await savePigSettings({ completionNotifications: false })).completionNotifications, false)
      assert.equal((await loadPigSettings()).completionNotifications, false)
      assert.equal((await savePigSettings({ beamBorderEnabled: false })).beamBorderEnabled, false)
      assert.equal((await loadPigSettings()).beamBorderEnabled, false)
    } finally {
      if (previous === undefined) delete process.env.PIG_DIR
      else process.env.PIG_DIR = previous
      await rm(root, { recursive: true, force: true })
    }
  }
}

if (process.argv[2] === '--main-settings-fixture') {
  await fixture(process.argv[3])
} else {
  for (const [name, title] of Object.entries({
    preparation: 'choices made before the publish apply to the live session',
    'child-close-failure': 'subagent persistence failure cannot strand the parent during close',
    runtime: 'failed startup retries and background refresh errors stay handled',
    controls: 'pending model selection applies the same reasoning level the picker displays',
    auth: 'an old login cannot clear a newer prompt or open a stale login URL',
    'auth-device-id': 'subscription login lazily creates and persists a stable global installation ID',
    'auth-device-id-existing': 'subscription login reuses an existing pi installation ID instead of the project ID',
    'auth-device-id-malformed': 'malformed global settings reject subscription login without overwriting the file',
    'auth-device-id-cached-malformed': 'cached settings do not hide JSON corruption introduced before login',
    'auth-device-id-unreadable': 'unreadable global settings reject subscription login on every attempt',
    'auth-device-id-write-failure': 'device ID write failures propagate before login and cannot be bypassed by retry',
    'auth-refresh': 'post-login refresh stays cancellable and never starts an unbounded full refresh',
    'native-theme': 'native macOS appearance and vibrancy follow saved choices',
    'native-theme-windows': 'Windows 11 22H2 uses acrylic and supports switching to solid',
    'native-theme-windows10': 'Windows 10 stays solid even with copied glass preferences',
    'native-theme-windows11-old': 'Windows 11 before 22H2 stays solid without unsupported material calls',
    'native-theme-linux': 'Linux stays solid even with copied glass preferences',
    'pig-settings': 'concurrent preference updates preserve each other and recover after a write failure'
  })) {
    test(`main settings lifecycle: ${title}`, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--main-settings-fixture', name], { stdout: 'pipe', stderr: 'pipe' })
      const timeout = setTimeout(() => child.kill(), 8_000)
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
        ])
        assert.equal(exitCode, 0, stderr || stdout)
      } finally {
        clearTimeout(timeout)
        child.kill()
      }
    }, 10_000)
  }
}
