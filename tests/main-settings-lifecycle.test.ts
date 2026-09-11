import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture(name: string): Promise<void> {
  if (name === 'preparation') {
    const root = await mkdtemp(join(tmpdir(), 'pig-controls-preparation-'))
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
    const session = {
      sessionId: 'draft', bindExtensions: async () => {},
      subscribe: () => () => {}, abort: async () => {}, dispose() {},
      extensionRunner: { emit: async () => {} }
    }
    mock.module('electron', () => ({ app: { isPackaged: false } }))
    mock.module('@earendil-works/pi-coding-agent', () => ({
      createAgentSession: async () => ({ session }),
      SessionManager: { create: () => manager }
    }))
    mock.module(fileURLToPath(new URL('../src/main/pi/model-settings.ts', import.meta.url)), () => ({
      startModelRuntime: async () => ({}), getDefaultSessionSettings() {}, listAvailableModels() {},
      setDefaultModel() {}, setDefaultThinking() {}
    }))
    mock.module(fileURLToPath(new URL('../src/main/pi/session-controls.ts', import.meta.url)), () => ({
      applyPendingControls: async () => { started.resolve(); await release.promise },
      setSessionModel: async (state: object) => { applied.push({ kind: 'model', live: 'agentSession' in state }) },
      setSessionThinking: async (state: object) => { applied.push({ kind: 'thinking', live: 'agentSession' in state }) },
      controlsFor() {}, refreshSessionModels() {}
    }))
    mock.module(fileURLToPath(new URL('../src/main/pi/chat-resources.ts', import.meta.url)), () => ({
      createChatResourceLoader: async () => undefined, createNoExtensionsResourceLoader: async () => undefined
    }))
    mock.module(fileURLToPath(new URL('../src/main/chats.ts', import.meta.url)), () => ({ isChatCwd: () => false }))
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
    } finally {
      release.resolve()
      await registry?.disposeAll()
      await rm(root, { recursive: true, force: true })
    }
    return
  }

  if (name === 'runtime') {
    let creates = 0
    const logged: unknown[][] = []
    const originalError = console.error
    console.error = (...values) => { logged.push(values) }
    const runtime = { refresh: async () => { throw new Error('refresh unavailable') } }
    mock.module('@earendil-works/pi-coding-agent', () => ({
      ModelRuntime: { create: async () => {
        if (++creates === 1) throw new Error('temporary startup failure')
        return runtime
      } },
      SettingsManager: {}
    }))
    try {
      const { startModelRuntime } = await import('../src/main/pi/model-settings')
      const first = startModelRuntime()
      const concurrent = startModelRuntime()
      assert.equal(first, concurrent)
      await assert.rejects(first, /temporary startup failure/)
      assert.equal(await startModelRuntime(), runtime)
      assert.equal(await startModelRuntime(), runtime)
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(creates, 2)
      assert.equal(logged.length, 1)
      assert.match(String(logged[0][1]), /refresh unavailable/)
    } finally {
      console.error = originalError
    }
    return
  }

  if (name === 'controls') {
    const model = { id: 'reasoner', provider: 'test', name: 'Reasoner', reasoning: true, contextWindow: 1000 }
    let available = true
    mock.module('@earendil-works/pi-coding-agent', () => ({
      ModelRuntime: { create: async () => ({
        refresh: async () => {},
        getModel: () => available ? model : undefined,
        getProvider: () => ({ name: 'Test' }),
        getAvailableSnapshot: () => available ? [model] : []
      }) },
      SettingsManager: { create: () => ({
        getDefaultProvider: () => 'test', getDefaultModel: () => 'reasoner',
        getModelThinkingLevel: () => 'high', getDefaultThinkingLevel: () => 'medium'
      }) }
    }))
    const controls = await import('../src/main/pi/session-controls')
    const pending = {
      sessionId: 'draft', cwd: '/tmp', sessionManager: { getEntries: () => [] }, win: {}
    } as unknown as import('../src/main/pi/session-state').PendingSession
    const selected = await controls.setSessionModel(pending, 'test', 'reasoner')
    assert.equal(selected.thinkingLevel, 'high')
    assert.equal(pending.thinkingLevel, selected.thinkingLevel)
    let applied: string | undefined
    const session = {
      setModel: async () => {},
      setThinkingLevel: (level: string) => { applied = level },
      getAvailableThinkingLevels: () => ['low', 'medium', 'high']
    } as unknown as import('@earendil-works/pi-coding-agent').AgentSession
    await controls.applyPendingControls(pending, session)
    assert.equal(applied, selected.thinkingLevel)
    await assert.rejects(controls.setSessionThinking({ sessionId: 'live', cwd: '/tmp', agentSession: session, unsubscribe() {} }, 'max'), /not supported/)
    available = false
    await assert.rejects(controls.applyPendingControls(pending, session), /Model not found/)
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
    mock.module('electron', () => ({ shell: { openExternal: async (url: string) => { urls.push(url) } } }))
    mock.module(fileURLToPath(new URL('../src/main/pi/model-settings.ts', import.meta.url)), () => ({ startModelRuntime: async () => runtime }))
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

  if (name === 'pig-settings') {
    const root = await mkdtemp(join(tmpdir(), 'pig-settings-lifecycle-'))
    const previous = process.env.PIG_DIR
    mock.module('electron', () => ({ app: { isPackaged: false } }))
    try {
      process.env.PIG_DIR = join(root, 'settings')
      const { loadPigSettings, savePigSettings } = await import('../src/main/pig-settings')
      await Promise.all([
        savePigSettings({ appearance: 'dark' }),
        savePigSettings({ sendShortcut: 'shift-enter' }),
        savePigSettings({ lightTheme: 'everforest' }),
        savePigSettings({ darkTheme: 'everforest' })
      ])
      assert.deepEqual(await loadPigSettings(), {
        appearance: 'dark', sendShortcut: 'shift-enter', lightTheme: 'everforest', darkTheme: 'everforest'
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
    preparation: 'choices made during materialization apply to the published live session',
    runtime: 'failed startup retries and background refresh errors stay handled',
    controls: 'pending model selection applies the same reasoning level the picker displays',
    auth: 'an old login cannot clear a newer prompt or open a stale login URL',
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
