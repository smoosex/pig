import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorktreeService } from '../src/main/worktrees'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture(scenario: string): Promise<void> {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'pig-session-lifecycle-')))
  const service = new WorktreeService(join(cwd, 'state'))
  const configuring = deferred()
  const configured = deferred()
  const aborting = deferred()
  const aborted = deferred()
  const sessionId = 'draft-session'
  const sessionFile = join(cwd, 'session.jsonl')
  const header = { type: 'session', version: 3, id: sessionId, cwd }
  let createCalls = 0
  let modelCalls = 0
  let subscribeCalls = 0
  let disposeCalls = 0
  let registry: typeof import('../src/main/pi/session-registry') | undefined
  const manager = {
    getCwd: () => cwd,
    getSessionId: () => sessionId,
    getSessionFile: () => sessionFile,
    getHeader: () => header,
    setSessionFile: () => {},
    getEntries: () => []
  }
  const session = {
    sessionId,
    sessionFile,
    sessionManager: manager,
    bindExtensions: async () => {},
    setModel: async () => {
      modelCalls++
      configuring.resolve()
      await configured.promise
      if (scenario === 'retry' && modelCalls === 1) throw new Error('Model configuration failed')
    },
    setThinkingLevel: () => {},
    subscribe: () => { subscribeCalls++; return () => {} },
    abort: async () => {
      if (scenario !== 'close') return
      aborting.resolve()
      await aborted.promise
    },
    extensionRunner: { emit: async () => {} },
    dispose: () => { disposeCalls++ }
  }

  try {
    process.env.PIG_DIR = join(cwd, 'pig')
    mock.module('electron', () => ({
      app: { isPackaged: false },
      BrowserWindow: { getAllWindows: () => [] }
    }))
    mock.module(fileURLToPath(new URL('../src/main/project-worktrees.ts', import.meta.url)), () => ({ worktrees: service }))
    const sdk = await import('@earendil-works/pi-coding-agent')
    mock.module('@earendil-works/pi-coding-agent', () => ({
      ...sdk,
      createAgentSession: async () => ({ session }),
      ModelRuntime: { create: async () => ({ refresh: async () => {}, getModel: () => ({ id: 'test' }) }) },
      SessionManager: { create: () => { createCalls++; return manager }, open: () => manager },
      SettingsManager: { create: () => ({}) },
      DefaultResourceLoader: class { async reload() {} },
      getAgentDir: () => join(cwd, 'agent')
    }))
    registry = await import('../src/main/pi/session-registry')
    const sessions = registry
    const win = {} as Parameters<typeof sessions.createPendingSession>[1]
    const draft = sessions.createPendingSession(cwd, win)
    assert.equal(await stat(sessionFile).catch(() => null), null)

    if (scenario === 'existing-file') {
      await writeFile(sessionFile, 'existing session data\n')
      await assert.rejects(sessions.prepareSession(sessionId), /EEXIST/)
      assert.equal(await readFile(sessionFile, 'utf8'), 'existing session data\n')
      assert.equal(subscribeCalls, 0)
      return
    }

    if (scenario === 'close') {
      await sessions.prepareSession(sessionId)
      const first = sessions.closeSession(sessionId)
      await aborting.promise
      assert.equal(sessions.closeSession(sessionId), first)
      let directoryClosed = false
      let allClosed = false
      const directory = sessions.closeSessionsForCwd(cwd).then(() => { directoryClosed = true })
      const all = sessions.disposeAll().then(() => { allClosed = true })
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(directoryClosed, false)
      assert.equal(allClosed, false)
      assert.throws(() => sessions.prepareSession(sessionId), /Session is closing/)
      await assert.rejects(sessions.openSession(sessionFile, win), /Session is closing/)
      aborted.resolve()
      await Promise.all([first, directory, all])
      assert.equal(disposeCalls, 1)
      assert.equal(sessions.getLive(sessionId), undefined)
      return
    }

    draft.modelProvider = 'test'
    draft.modelId = 'test'
    const opening = sessions.prepareSession(sessionId)
    const result = opening.then((value) => ({ value }), (error: unknown) => ({ error }))
    await configuring.promise
    assert.equal(sessions.getLive(sessionId), undefined)
    assert.equal(subscribeCalls, 0)
    assert.equal(sessions.prepareSession(sessionId), opening)

    if (scenario === 'delete') {
      const deletion = service.withBlockedCwds([cwd], () => sessions.closeSessionsForCwd(cwd))
      configured.resolve()
      await deletion
      const failed = await result
      assert.ok('error' in failed)
      assert.match(String(failed.error), /Worktree 正在删除/)
      assert.equal(await stat(sessionFile).catch(() => null), null)
      assert.equal(disposeCalls, 1)
      assert.equal(sessions.getLive(sessionId), undefined)
      return
    }

    configured.resolve()
    const settled = await result
    if (scenario === 'retry') {
      assert.ok('error' in settled)
      assert.match(String(settled.error), /Model configuration failed/)
      assert.equal(await stat(sessionFile).catch(() => null), null)
      assert.equal(disposeCalls, 1)
      assert.equal(sessions.isPendingDraft(sessionId), true)
      await sessions.prepareSession(sessionId)
      assert.equal(modelCalls, 2)
      assert.equal(createCalls, 1)
    } else {
      assert.ok('value' in settled)
      assert.equal(sessions.getLive(sessionId), settled.value)
      assert.equal(modelCalls, 1)
    }
    assert.equal(subscribeCalls, 1)
    assert.equal(await readFile(sessionFile, 'utf8'), `${JSON.stringify(header)}\n`)
  } finally {
    configured.resolve()
    aborted.resolve()
    await registry?.disposeAll()
    await service.shutdown()
    await rm(cwd, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--lifecycle-fixture') {
  await fixture(process.argv[3])
} else {
  const scenarios = {
    publish: 'concurrent preparation waits for pending model configuration before publishing',
    retry: 'failed pending controls dispose the SDK session and allow a clean retry',
    close: 'concurrent close and directory cleanup await the same teardown',
    delete: 'directory deletion waits for pending controls and prevents publication',
    'existing-file': 'materialization never overwrites or removes an existing session file'
  }
  for (const [scenario, name] of Object.entries(scenarios)) {
    test(name, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--lifecycle-fixture', scenario], {
        stdout: 'pipe',
        stderr: 'pipe'
      })
      const timeout = setTimeout(() => child.kill(), 5_000)
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text()
        ])
        assert.equal(code, 0, stderr || stdout)
      } finally {
        clearTimeout(timeout)
        child.kill()
      }
    }, 10_000)
  }
}
