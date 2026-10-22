import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { WorktreeService } from '../src/main/worktrees'

async function fixture(): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pig-tools-reload-')))
  process.env.PIG_DIR = join(root, 'pig')
  const service = new WorktreeService(join(root, 'state'))
  const noop = () => {}
  let models: { id: string; provider: string; name: string; contextWindow: number; reasoning: boolean }[] = []
  const pushed: import('../src/shared/api').ModelCatalog[] = []
  mock.module('electron', () => ({
    app: { isPackaged: false },
    BrowserWindow: { getAllWindows: () => [{
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: (channel: string, catalog: import('../src/shared/api').ModelCatalog) => {
        assert.equal(channel, 'models:changed')
        pushed.push(catalog)
      } }
    }] }
  }))
  mock.module(fileURLToPath(new URL('../src/main/project-worktrees.ts', import.meta.url)), () => ({
    worktrees: service
  }))
  mock.module(fileURLToPath(new URL('../src/main/extension-ui.ts', import.meta.url)), () => ({
    createExtensionUI: async () => ({}),
    cancelExtensionUI: noop,
    openMcpUrl: noop
  }))
  const sdk = await import('@earendil-works/pi-coding-agent')
  let count = 0
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const reloading = new Promise<void>((resolve) => {
    started = resolve
  })
  let extensionErrors: { path: string; error: string }[] = []
  const sessions: {
    isIdle: boolean
    reloads: number
    starts: number
    paths: string[]
    emit(event: unknown): void
  }[] = []
  mock.module('@earendil-works/pi-coding-agent', () => ({
    ...sdk,
    SessionManager: {
      create: (cwd: string) => {
        const id = `session-${++count}`
        return {
          getSessionId: () => id,
          getSessionFile: () => join(cwd, `${id}.jsonl`),
          getCwd: () => cwd
        }
      }
    },
    ModelRuntime: { create: async () => ({
      refresh: async () => { throw new Error('Lifecycle synchronization must not refresh the network') },
      getAvailableSnapshot: () => models,
      getProvider: () => ({ name: 'Extensions' })
    }) },
    DefaultResourceLoader: class {
      constructor(readonly options: { additionalExtensionPaths: string[] }) {}
      async reload() {}
      getExtensions() {
        return { extensions: [], errors: extensionErrors }
      }
    },
    getAgentDir: () => join(root, 'agent'),
    createAgentSession: async ({
      sessionManager,
      resourceLoader
    }: {
      sessionManager: { getSessionId(): string }
      resourceLoader: { options: { additionalExtensionPaths: string[] }; getExtensions(): { errors: { path: string; error: string }[] } }
    }) => {
      let listener: ((event: unknown) => void) | undefined
      const session = {
        sessionId: sessionManager.getSessionId(),
        sessionManager,
        agent: { streamFunction: () => { throw new Error('Unexpected model request') } },
        getActiveToolNames: () => [], getAllTools: () => [], setActiveToolsByName() {},
        settingsManager: { getDefaultTools: () => undefined },
        resourceLoader,
        paths: resourceLoader.options.additionalExtensionPaths,
        starts: 0,
        isIdle: false,
        isBashRunning: false,
        reloads: 0,
        bindExtensions: async () => {
          models.push({ id: session.sessionId, provider: 'extensions', name: 'Bound', contextWindow: 100, reasoning: false })
        },
        subscribe: (callback: (event: unknown) => void) => {
          listener = callback
          return () => {
            listener = undefined
          }
        },
        emit: (event: unknown) => listener?.(event),
        reload: async (options?: { beforeSessionStart?(): Promise<void> }) => {
          session.reloads++
          if (sessions[0] === session && session.reloads === 1) {
            started()
            await gate
          }
          models = models.filter((model) => model.id !== session.sessionId)
          await options?.beforeSessionStart?.()
          models.push({ id: session.sessionId, provider: 'extensions', name: `Reload ${session.reloads}`, contextWindow: 200, reasoning: true })
          session.starts++
        },
        abort: async () => {},
        dispose: noop,
        extensionRunner: { emit: async () => { models = models.filter((model) => model.id !== session.sessionId) } }
      }
      sessions.push(session)
      return { session }
    }
  }))
  const registry = await import('../src/main/pi/session-registry')
  const contents = Object.assign(new EventEmitter(), { send: noop, isDestroyed: () => false })
  const win = { webContents: contents, isDestroyed: () => false } as unknown as Parameters<
    typeof registry.createPendingSession
  >[1]
  try {
    const plugins = await import('../src/main/pi/plugins')
    await plugins.setPluginScopes('pi-web-access', [])
    await plugins.setPluginScopes('pi-persona', [])
    const cwds = [
      join(root, 'project'),
      join(root, 'other'),
      join(process.env.PIG_DIR, 'chats', 'chat')
    ]
    for (const cwd of cwds) await mkdir(cwd, { recursive: true })
    const ids: string[] = []
    for (const cwd of cwds) {
      const pending = registry.createPendingSession(cwd, win)
      ids.push(pending.sessionId)
      await registry.prepareSession(pending.sessionId)
    }
    assert.ok(sessions[0].paths.length > 0)
    assert.deepEqual(sessions[2].paths, [], 'Chat starts without project-only plugins')
    const { currentModelCatalog } = await import('../src/main/pi/model-catalog')
    assert.deepEqual((await currentModelCatalog()).models.map((model) => model.id), ids)
    assert.deepEqual(pushed.at(-1)!.models.map((model) => model.id), ids, 'binding extensions updates every selector')
    const { beginSessionInput } = await import('../src/main/pi/event-bridge')
    for (const session of sessions) session.isIdle = true
    const releaseInput = beginSessionInput(registry.getLive(ids[0])!.agentSession)
    const pluginRefreshReturned = await Promise.race([
      registry.refreshPluginSessions(false, cwds[0]).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100))
    ])
    assert.equal(
      pluginRefreshReturned,
      true,
      'preflight-busy plugin changes must return without blocking settings'
    )
    await registry.refreshToolSessions()
    assert.deepEqual(registry.pendingToolSessions(), [ids[0]])
    await new Promise((resolve) => setTimeout(resolve, 350))
    assert.equal(sessions[0].reloads, 0, 'input hooks are protected even before SDK agent_start')
    sessions[0].emit({ type: 'agent_start' })
    releaseInput()
    await new Promise((resolve) => setTimeout(resolve, 350))
    assert.equal(sessions[0].reloads, 0, 'SDK isIdle alone does not mean settlement hooks finished')
    sessions[0].emit({ type: 'agent_settled', aborted: false })
    await reloading
    let ready = false
    const preparing = registry.prepareSession(ids[0]).then(() => {
      ready = true
    })
    await Promise.resolve()
    assert.equal(ready, false, 'new prompts must wait while the extension runtime is replaced')
    await registry.refreshToolSessions()
    release()
    await preparing
    for (let n = 0; n < 100 && registry.pendingToolSessions().length; n++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(registry.pendingToolSessions(), [])
    assert.equal(sessions[0].reloads, 2, 'a change arriving during reload is not lost')
    assert.equal(sessions[1].reloads, 2, 'global changes also reload other projects')
    assert.equal(sessions[2].reloads, 2, 'ordinary chats use the same global tools')
    assert.ok((await currentModelCatalog()).models.every((model) => model.name === 'Reload 2'))
    assert.ok(pushed.at(-1)!.models.every((model) => model.name === 'Reload 2'), 'reload broadcasts replacement models')
    for (const session of sessions) session.isIdle = true
    await registry.refreshToolSessions()
    assert.deepEqual(
      sessions.map((session) => session.reloads),
      [3, 3, 3]
    )
    const hasReview = (index: number) => sessions[index].paths.some((path) => path.endsWith(join('pi-review', 'index.ts')))
    await plugins.setPluginScopes('pi-review', ['chat'])
    await registry.refreshPluginSessions()
    assert.deepEqual(sessions.map((session) => session.reloads), [4, 4, 4])
    assert.deepEqual(sessions.map((_, index) => hasReview(index)), [false, false, true])
    await plugins.setPluginScopes('pi-review', ['project', 'chat'])
    await registry.refreshPluginSessions()
    assert.deepEqual(sessions.map((session) => session.reloads), [5, 5, 4], 'unchanged Chat resources are not reloaded')
    assert.deepEqual(sessions.map((_, index) => hasReview(index)), [true, true, true])
    sessions[2].isIdle = false
    await plugins.setPluginScopes('pi-review', [])
    await registry.refreshPluginSessions()
    assert.deepEqual(sessions.map((session) => session.reloads), [6, 6, 4])
    assert.equal(hasReview(2), true, 'a busy Chat retains its runtime until idle')
    sessions[2].isIdle = true
    for (let n = 0; n < 100 && hasReview(2); n++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    await registry.prepareSession(ids[2])
    assert.equal(sessions[2].reloads, 5)
    assert.deepEqual(sessions[2].paths, [], 'Chat unloads the plugin after becoming idle')
    for (const error of ['Invalid JSON in tool-settings.json', 'EACCES reading mcp.json']) {
      const starts = sessions.map((session) => session.starts)
      const reloads = sessions.map((session) => session.reloads)
      extensionErrors = [{ path: 'inline:pig-tools', error }]
      await assert.rejects(registry.refreshToolSessions(), {
        code: 'ERR_SESSION_RESOURCES_UNAVAILABLE'
      })
      // Global refresh fails fast; the other sessions may still be preparing their reloads.
      for (let n = 0; n < 100 && sessions.some((session, i) => session.reloads === reloads[i]); n++)
        await new Promise((resolve) => setTimeout(resolve, 10))
      assert.deepEqual(
        sessions.map((session) => session.reloads),
        reloads.map((value) => value + 1)
      )
      assert.deepEqual(
        sessions.map((session) => session.starts),
        starts
      )
      for (const id of ids) {
        assert.ok(registry.pendingToolSessions().includes(id))
        await assert.rejects(registry.prepareSession(id), {
          code: 'ERR_SESSION_RESOURCES_UNAVAILABLE'
        })
      }
      assert.deepEqual((await currentModelCatalog()).models, [], 'removals before failed reloads are also synchronized')
      assert.deepEqual(pushed.at(-1)!.models, [])
      extensionErrors = []
      await registry.refreshToolSessions()
      await registry.prepareSession(ids[0])
      assert.equal(registry.pendingToolSessions().includes(ids[0]), false)
    }
    const beforeBackground = sessions[0].reloads
    sessions[0].isIdle = false
    extensionErrors = [{ path: 'inline:pig-tools', error: 'Background reload failed' }]
    await assert.rejects(registry.refreshToolSessions(), {
      code: 'ERR_SESSION_RESOURCES_UNAVAILABLE'
    })
    sessions[0].isIdle = true
    for (let n = 0; n < 100 && sessions[0].reloads === beforeBackground; n++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    await assert.rejects(registry.prepareSession(ids[0]), {
      code: 'ERR_SESSION_RESOURCES_UNAVAILABLE'
    })
    extensionErrors = []
    await registry.refreshToolSessions()
  } finally {
    release()
    await registry.disposeAll()
    assert.deepEqual(pushed.at(-1)!.models, [], 'shutdown removals are published')
    await service.shutdown()
    await rm(root, { recursive: true, force: true })
  }
}
if (process.argv.includes('--fixture')) await fixture()
else
  test('tool settings reload: global scope, settlement boundary, prompt gate, queued writes and ordinary chats', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--fixture'], {
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const timer = setTimeout(() => child.kill(), 6000)
    try {
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
      ])
      assert.equal(code, 0, err || out)
    } finally {
      clearTimeout(timer)
    }
  }, 8000)
