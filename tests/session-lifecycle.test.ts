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
  const stamp = '2026-01-01T00:00:00.000Z'
  const entries: unknown[] = []
  let createCalls = 0
  let modelCalls = 0
  let subscribeCalls = 0
  let disposeCalls = 0
  let setSessionFileCalls = 0
  const renamedNames: string[] = []
  const forgottenNames: string[] = []
  let registry: typeof import('../src/main/pi/session-registry') | undefined
  const manager = {
    getCwd: () => cwd,
    getSessionId: () => sessionId,
    getSessionFile: () => sessionFile,
    getHeader: () => header,
    setSessionFile: () => { setSessionFileCalls++ },
    getEntries: () => entries,
    appendSessionInfo: (name: string) => { renamedNames.push(name) }
  }
  const session = {
    sessionId,
    sessionFile,
    sessionManager: manager,
    agent: { streamFunction: () => { throw new Error('Unexpected model request') } },
    bindExtensions: async () => {},
    setModel: async () => {
      modelCalls++
      configuring.resolve()
      await configured.promise
      if (scenario === 'retry' && modelCalls === 1) throw new Error('Model configuration failed')
    },
    setSessionName: (name: string) => { renamedNames.push(name) },
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
      ModelRuntime: { create: async () => ({ refresh: async () => {}, getAvailableSnapshot: () => [], getModel: () => ({ id: 'test' }) }) },
      SessionManager: { create: () => { createCalls++; return manager }, open: () => manager },
      SettingsManager: { fromStorage: sdk.SettingsManager.fromStorage, create: () => ({}) },
      DefaultResourceLoader: class {
        async reload() {}
        getExtensions() { return { extensions: [], errors: [] } }
      },
      getAgentDir: () => join(cwd, 'agent')
    }))
    const { applyLocaleSetting } = await import('../src/main/i18n')
    // Pig's own errors come from the dictionary: pin the wording these tests spell out.
    applyLocaleSetting('zh-CN')
    const loader = await import('../src/main/pi/session-loader')
    const forgetSessionName = loader.forgetSessionName
    mock.module('../src/main/pi/session-loader', () => ({
      ...loader,
      forgetSessionName: (file: string) => { forgottenNames.push(file); forgetSessionName(file) }
    }))
    registry = await import('../src/main/pi/session-registry')
    const sessions = registry
    const win = {} as Parameters<typeof sessions.createPendingSession>[1]
    const draft = sessions.createPendingSession(cwd, win, {
      draft: scenario !== 'persistent'
    })
    assert.equal(await stat(sessionFile).catch(() => null), null)

    if (scenario === 'rename-live' || scenario === 'rename-pending') {
      configured.resolve()
      if (scenario === 'rename-live') await sessions.prepareSession(sessionId)
      await sessions.renameSession(sessionId, '  新名字  ')
      assert.deepEqual(renamedNames, ['新名字'])
      assert.deepEqual(forgottenNames, [sessionFile], 'a rename invalidates the name reused by post-turn catalog refreshes')
      return
    }

    if (scenario === 'discard-pending') {
      await sessions.discardDraftSession(sessionId)
      assert.equal(await stat(sessionFile).catch(() => null), null)
      assert.equal(sessions.getLive(sessionId), undefined)
      return
    }

    if (scenario === 'discard-foreign') {
      const foreign = `${JSON.stringify({ ...header, id: 'someone-else' })}\n`
      await writeFile(sessionFile, foreign)
      await sessions.discardDraftSession(sessionId)
      assert.equal(await readFile(sessionFile, 'utf8'), foreign)
      assert.equal(sessions.getLive(sessionId), undefined)
      return
    }

    if (scenario === 'read-then-send') {
      // The slash-command path builds the session without giving it a file.
      const read = await sessions.prepareSession(sessionId)
      assert.equal(await stat(sessionFile).catch(() => null), null)
      assert.equal(setSessionFileCalls, 0)
      entries.push({ type: 'model_change', id: 'm1', parentId: null, timestamp: stamp, provider: 'test', modelId: 'test' })
      const activated = await sessions.activateSession(sessionId)
      assert.equal(activated.created, true)
      assert.equal(activated.session, read)
      assert.equal(setSessionFileCalls, 1)
      // The entry the live manager collected before the send is in the file the send published.
      const published = `${JSON.stringify(header)}\n${JSON.stringify(entries[0])}\n`
      assert.equal(await readFile(sessionFile, 'utf8'), published)
      // A later send finds its own file and leaves the manager attached to it.
      const again = await sessions.activateSession(sessionId)
      assert.equal(again.created, false)
      assert.equal(setSessionFileCalls, 1)
      assert.equal(await readFile(sessionFile, 'utf8'), published)
      return
    }

    if (scenario === 'promoted') sessions.promoteDraftSession(sessionId)

    if (scenario === 'existing-file') {
      // A stranger's file at our path has to stop the send here, not inside the SDK's first write.
      const foreign = `${JSON.stringify({ ...header, id: 'someone-else' })}\n`
      await writeFile(sessionFile, foreign)
      await assert.rejects(sessions.activateSession(sessionId), /Session file already exists/)
      assert.equal(await readFile(sessionFile, 'utf8'), foreign)
      // A file with no header is no more adoptable than a foreign one.
      await writeFile(sessionFile, 'existing session data\n')
      await assert.rejects(sessions.activateSession(sessionId), /Session file already exists/)
      assert.equal(await readFile(sessionFile, 'utf8'), 'existing session data\n')
      return
    }

    if (scenario === 'close') {
      await sessions.activateSession(sessionId)
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
    const opening = sessions.activateSession(sessionId)
    const result = opening.then((value) => ({ value }), (error: unknown) => ({ error }))
    await configuring.promise
    assert.equal(sessions.getLive(sessionId), undefined)
    assert.equal(subscribeCalls, 0)
    // A reader arriving mid-send joins the send's build, and the send only ever started one.
    const shared = sessions.prepareSession(sessionId)
    assert.equal(sessions.prepareSession(sessionId), shared)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(modelCalls, 1)

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
      // A build that fails takes the file the send had just created back out with it.
      assert.equal(await stat(sessionFile).catch(() => null), null)
      assert.equal(disposeCalls, 1)
      assert.equal(sessions.getLive(sessionId), undefined)
      const retry = await sessions.activateSession(sessionId)
      assert.equal(retry.created, true)
      assert.equal(modelCalls, 2)
      assert.equal(createCalls, 1)
    } else {
      assert.ok('value' in settled)
      assert.equal(sessions.getLive(sessionId), settled.value.session)
      assert.equal(modelCalls, 1)
    }
    assert.equal(subscribeCalls, 1)
    assert.equal(await readFile(sessionFile, 'utf8'), `${JSON.stringify(header)}\n`)
    if (scenario === 'discard-materialized') {
      await sessions.discardDraftSession(sessionId)
      assert.equal(await stat(sessionFile).catch(() => null), null)
      assert.equal(sessions.getLive(sessionId), undefined)
    } else if (scenario === 'directory-draft') {
      await sessions.closeSessionsForCwd(cwd)
      assert.equal(await stat(sessionFile).catch(() => null), null)
      assert.equal(sessions.getLive(sessionId), undefined)
    } else if (scenario === 'close-reopen') {
      const message = {
        type: 'message',
        id: 'message-1',
        parentId: null,
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'user', content: 'keep me' }
      }
      await writeFile(sessionFile, `${JSON.stringify(message)}\n`, { flag: 'a' })
      await sessions.closeSession(sessionId)
      assert.equal(sessions.getLive(sessionId), undefined)
      await sessions.openSession(sessionFile, win)
      await sessions.disposeAll()
      assert.match(await readFile(sessionFile, 'utf8'), /message-1/)
    } else if (scenario === 'promoted') {
      await sessions.disposeAll()
      assert.equal(await readFile(sessionFile, 'utf8'), `${JSON.stringify(header)}\n`)
    } else if (scenario === 'persistent') {
      await writeFile(sessionFile, `${JSON.stringify({ type: 'message', id: 'message-1' })}\n`, { flag: 'a' })
      await sessions.disposeAll()
      assert.match(await readFile(sessionFile, 'utf8'), /message-1/)
    }
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
    'rename-live': 'renaming a live session invalidates its cached catalog name',
    'rename-pending': 'renaming an in-memory pending session invalidates its cached catalog name',
    retry: 'failed pending controls dispose the SDK session and allow a clean retry',
    close: 'concurrent close and directory cleanup await the same teardown',
    delete: 'directory deletion waits for pending controls and prevents publication',
    'existing-file': 'a session file this session does not own stops the send',
    'read-then-send': 'reading a draft through the slash-command path leaves no file until the send',
    'discard-pending': 'discarding an unused draft creates no session file',
    'discard-foreign': 'discarding a draft leaves a session file it does not own alone',
    'discard-materialized': 'discarding a draft that was sent removes its empty session file',
    'directory-draft': 'closing a directory discards its sent draft',
    'close-reopen': 'closing a draft clears its identity before the same file is reopened',
    promoted: 'a promoted session keeps its file when the app closes',
    persistent: 'a persistent pending session preserves its messages during shutdown'
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
