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
  mock.module('electron', () => ({
    app: { isPackaged: false },
    BrowserWindow: { getAllWindows: () => [] }
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
    ModelRuntime: { create: async () => ({ refresh: async () => {} }) },
    DefaultResourceLoader: class {
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
      resourceLoader: { getExtensions(): { errors: { path: string; error: string }[] } }
    }) => {
      let listener: ((event: unknown) => void) | undefined
      const session = {
        sessionId: sessionManager.getSessionId(),
        sessionManager,
        resourceLoader,
        starts: 0,
        isIdle: false,
        isBashRunning: false,
        reloads: 0,
        bindExtensions: async () => {},
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
          await options?.beforeSessionStart?.()
          session.starts++
        },
        abort: async () => {},
        dispose: noop,
        extensionRunner: { emit: async () => {} }
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
    for (const session of sessions) session.isIdle = true
    await registry.refreshToolSessions()
    assert.deepEqual(
      sessions.map((session) => session.reloads),
      [3, 3, 3]
    )
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
