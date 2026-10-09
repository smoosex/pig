import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorktreeService } from '../src/main/worktrees'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function observe<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (error: unknown) => ({ status: 'rejected' as const, error })
  )
}

function mockExtensionUI(): void {
  mock.module(fileURLToPath(new URL('../src/main/extension-ui.ts', import.meta.url)), () => ({
    createExtensionUI: async () => ({}), cancelExtensionUI: () => {}, openMcpUrl: () => {}
  }))
}

async function reproduce(stage: string, useAlias: boolean): Promise<void> {
  mockExtensionUI()
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pig-session-registry-race-')))
  const cwd = join(root, 'worktree')
  const alias = join(root, 'alias')
  const service = new WorktreeService(join(root, 'state'))
  const started = deferred()
  const release = deferred()
  const operations: Promise<unknown>[] = []
  let registry: typeof import('../src/main/pi/session-registry') | undefined
  let createCalls = 0
  let openCalls = 0
  let bindCalls = 0
  let disposeCalls = 0
  let shutdownCalls = 0
  let subscribeCalls = 0
  let closed = false
  let removed = false

  try {
    await mkdir(cwd)
    if (useAlias) await symlink(cwd, alias, process.platform === 'win32' ? 'junction' : 'dir')
    process.env.PIG_DIR = join(root, 'pig')
    const sessionCwd = useAlias ? alias : cwd
    const sessionId = 'opening-session'
    const sessionFile = join(cwd, 'session.jsonl')
    const session = {
      sessionId,
      sessionFile,
      bindExtensions: async () => {
        bindCalls++
        if (stage === 'bind') {
          started.resolve()
          await release.promise
        }
      },
      subscribe: () => { subscribeCalls++; return () => {} },
      dispose: () => { disposeCalls++ },
      abort: async () => {},
      extensionRunner: {
        emit: async (event: unknown) => {
          assert.deepEqual(event, { type: 'session_shutdown', reason: 'quit' })
          shutdownCalls++
        }
      }
    }

    mock.module('electron', () => ({
      app: { isPackaged: false },
      BrowserWindow: { getAllWindows: () => [] }
    }))
    mock.module(fileURLToPath(new URL('../src/main/project-worktrees.ts', import.meta.url)), () => ({ worktrees: service }))
    const sdk = await import('@earendil-works/pi-coding-agent')
    mock.module('@earendil-works/pi-coding-agent', () => ({
      ...sdk,
      createAgentSession: async () => {
        createCalls++
        if (stage === 'create') {
          started.resolve()
          await release.promise
        }
        return { session }
      },
      ModelRuntime: { create: async () => ({ refresh: async () => {} }) },
      SessionManager: {
        open: () => {
          openCalls++
          return { getCwd: () => sessionCwd, getSessionId: () => sessionId, getLeafId: () => null, getBranch: () => [] }
        }
      },
      SettingsManager: { fromStorage: sdk.SettingsManager.fromStorage, create: () => ({}) },
      DefaultResourceLoader: class {
        async reload() {}
        getExtensions() { return { extensions: [], errors: [] } }
      },
      getAgentDir: () => join(root, 'agent')
    }))

    const { applyLocaleSetting } = await import('../src/main/i18n')
    // Pig's own errors come from the dictionary: pin the wording these tests spell out.
    applyLocaleSetting('zh-CN')
    registry = await import('../src/main/pi/session-registry')
    const sessions = registry
    const win = {} as Parameters<typeof sessions.openSession>[1]
    const opening = observe(sessions.openSession(sessionFile, win))
    // Opening only reads the JSONL projection; prepareSession owns the SDK build.
    const preparing = observe(sessions.prepareSession(sessionId))
    operations.push(opening, preparing)
    await started.promise
    const duplicate = observe(sessions.openSession(join(sessionCwd, 'session.jsonl'), win))
    operations.push(duplicate)
    assert.equal(createCalls, 1)
    assert.equal(openCalls, 2, 'a duplicate open re-reads the file but must not start a second build')

    const deleting = observe(service.withBlockedCwds([cwd], async () => {
      await sessions.closeSessionsForCwd(cwd)
      closed = true
      assert.equal(disposeCalls, 1, 'close must wait for the opening session to be disposed')
      assert.equal(sessions.getLive(sessionId), undefined)
      await rm(cwd, { recursive: true })
      removed = true
    }))
    operations.push(deleting)

    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(closed, false, 'close must remain pending while the SDK build is paused')
    assert.equal(removed, false)
    assert.throws(() => service.assertAvailable(cwd), /Worktree 正在删除/)
    assert.throws(() => sessions.createPendingSession(sessionCwd, win), /Worktree 正在删除/)

    release.resolve()
    const [first, second, preparation, deletion] = await Promise.all([opening, duplicate, preparing, deleting])
    assert.equal(deletion.status, 'fulfilled', JSON.stringify(deletion))
    for (const result of [first, second]) {
      assert.equal(result.status, 'fulfilled', 'opening only returns the stored projection')
      if (result.status === 'fulfilled') assert.equal(result.value.sessionId, sessionId)
    }
    assert.equal(preparation.status, 'rejected', 'an opening session must not outlive deletion')
    if (preparation.status === 'rejected') assert.match(String(preparation.error), /Worktree 正在删除/)
    assert.equal(closed, true)
    assert.equal(removed, true)
    assert.equal(disposeCalls, 1)
    assert.equal(shutdownCalls, 1)
    assert.equal(bindCalls, stage === 'bind' ? 1 : 0)
    assert.equal(subscribeCalls, 0)
    assert.equal(sessions.getLive(sessionId), undefined)
    assert.equal(await stat(cwd).catch(() => null), null)
    assert.doesNotThrow(() => service.assertAvailable(cwd))
  } finally {
    release.resolve()
    await Promise.allSettled(operations)
    try {
      await registry?.disposeAll()
      await service.shutdown()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
}

async function reproduceReopen(): Promise<void> {
  mockExtensionUI()
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pig-session-reopen-')))
  const cwd = join(root, 'worktree')
  const service = new WorktreeService(join(root, 'state'))
  const started = deferred()
  const release = deferred()
  const operations: Promise<unknown>[] = []
  let registry: typeof import('../src/main/pi/session-registry') | undefined
  let openCalls = 0
  let buildCalls = 0

  try {
    await mkdir(cwd)
    process.env.PIG_DIR = join(root, 'pig')
    const sessionId = 'draft-session'
    const sessionFile = join(cwd, 'draft.jsonl')
    const header = { id: sessionId }
    const session = {
      sessionId,
      sessionFile,
      bindExtensions: async () => {},
      subscribe: () => () => {},
      dispose: () => {},
      abort: async () => {},
      extensionRunner: { emit: async () => {} }
    }
    const manager = {
      getCwd: () => cwd,
      getSessionId: () => sessionId,
      getLeafId: () => null,
      getBranch: () => [],
      getSessionFile: () => sessionFile,
      getHeader: () => header,
      setSessionFile: () => {},
      getEntries: () => []
    }

    mock.module('electron', () => ({
      app: { isPackaged: false },
      BrowserWindow: { getAllWindows: () => [] }
    }))
    mock.module(fileURLToPath(new URL('../src/main/project-worktrees.ts', import.meta.url)), () => ({ worktrees: service }))
    const sdk = await import('@earendil-works/pi-coding-agent')
    mock.module('@earendil-works/pi-coding-agent', () => ({
      ...sdk,
      createAgentSession: async () => {
        buildCalls++
        if (buildCalls === 1) {
          started.resolve()
          await release.promise
        }
        return { session }
      },
      ModelRuntime: { create: async () => ({ refresh: async () => {} }) },
      SessionManager: {
        create: () => manager,
        open: () => {
          openCalls++
          return manager
        }
      },
      SettingsManager: { fromStorage: sdk.SettingsManager.fromStorage, create: () => ({}) },
      DefaultResourceLoader: class {
        async reload() {}
        getExtensions() { return { extensions: [], errors: [] } }
      },
      getAgentDir: () => join(root, 'agent')
    }))

    const { applyLocaleSetting } = await import('../src/main/i18n')
    // Pig's own errors come from the dictionary: pin the wording these tests spell out.
    applyLocaleSetting('zh-CN')
    registry = await import('../src/main/pi/session-registry')
    const sessions = registry
    const win = {} as Parameters<typeof sessions.openSession>[1]

    const draft = sessions.createPendingSession(cwd, win)
    const preparing = observe(sessions.activateSession(draft.sessionId))
    operations.push(preparing)
    await started.promise

    // The draft JSONL exists while its build is still in flight.
    const opening = observe(sessions.openSession(sessionFile, win))
    operations.push(opening)
    assert.equal(openCalls, 1)
    assert.equal(buildCalls, 1)

    release.resolve()
    const prepared = await preparing
    assert.equal(prepared.status, 'fulfilled', prepared.status === 'rejected' ? String(prepared.error) : '')
    assert.equal((await opening).status, 'fulfilled')
    await new Promise<void>((resolve) => setImmediate(resolve))

    await sessions.closeSession(sessionId)
    assert.equal(sessions.getLive(sessionId), undefined)

    // The cached preview must not outlive the first build; reopening starts a fresh preparation.
    const reopened = await sessions.openSession(sessionFile, win)
    assert.equal(reopened.sessionId, sessionId)
    assert.equal(openCalls, 2, 'reopening must read the JSONL again instead of using a stale preview')
    const preparedAgain = observe(sessions.prepareSession(sessionId))
    operations.push(preparedAgain)
    const settled = await preparedAgain
    assert.equal(settled.status, 'fulfilled', JSON.stringify(settled))
    assert.equal(buildCalls, 2)
  } finally {
    release.resolve()
    await Promise.allSettled(operations)
    try {
      await registry?.disposeAll()
      await service.shutdown()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
}

if (process.argv[2] === '--reopen-fixture') {
  await reproduceReopen()
} else if (process.argv[2] === '--race-fixture') {
  await reproduce(process.argv[3], process.argv[4] === 'alias')
} else {
  test('reopening a path whose preparation was in flight does not serve a stale preview', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--reopen-fixture'], {
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const timeout = setTimeout(() => child.kill(), 5_000)
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

  for (const stage of ['create', 'bind']) {
    for (const pathKind of ['direct', 'alias']) {
      test(`deletion waits for ${stage} during openSession (${pathKind} cwd)`, async () => {
        const child = Bun.spawn([process.execPath, import.meta.path, '--race-fixture', stage, pathKind], {
          stdout: 'pipe',
          stderr: 'pipe'
        })
        const timeout = setTimeout(() => child.kill(), 5_000)
        try {
          const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text()
          ])
          assert.equal(exitCode, 0, stderr || stdout)
        } finally {
          clearTimeout(timeout)
          child.kill()
        }
      }, 10_000)
    }
  }
}
