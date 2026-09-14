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

async function reproduce(stage: string, useAlias: boolean): Promise<void> {
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
    mock.module('@earendil-works/pi-coding-agent', () => ({
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
      SettingsManager: { create: () => ({}) },
      DefaultResourceLoader: class {
        async reload() {}
      },
      getAgentDir: () => join(root, 'agent')
    }))

    registry = await import('../src/main/pi/session-registry')
    const sessions = registry
    const win = {} as Parameters<typeof sessions.openSession>[1]
    const opening = observe(sessions.openSession(sessionFile, win))
    // The preview resolves immediately; the SDK build continues in the background.
    const preparing = observe(sessions.prepareSession(sessionId))
    operations.push(opening, preparing)
    await started.promise
    const duplicate = observe(sessions.openSession(join(sessionCwd, 'session.jsonl'), win))
    operations.push(duplicate)
    assert.equal(createCalls, 1)
    assert.equal(openCalls, 1)

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

if (process.argv[2] === '--race-fixture') {
  await reproduce(process.argv[3], process.argv[4] === 'alias')
} else {
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
