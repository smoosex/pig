import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PASSING_TURNS = 120
const PADDING = 20_000

/** A real JSONL with more turns than the tail window covers, so opening has to stay provisional. */
async function writeSession(
  file: string,
  cwd: string,
  id = 'tail-session',
  turns = PASSING_TURNS,
  padding = PADDING
): Promise<void> {
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id, cwd, timestamp: '2026-01-01T00:00:00.000Z' })
  ]
  let parent: string | null = null
  for (let i = 0; i < turns; i++) {
    const stamp = `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`
    lines.push(
      JSON.stringify({
        type: 'message', id: `u${i}`, parentId: parent, timestamp: stamp,
        message: { role: 'user', content: `question ${i}`, timestamp: i * 1000 }
      })
    )
    lines.push(
      JSON.stringify({
        type: 'message', id: `a${i}`, parentId: `u${i}`, timestamp: stamp,
        message: {
          role: 'assistant', provider: 'acme', model: 'one', stopReason: 'stop',
          content: [{ type: 'text', text: `answer ${i} ${'x'.repeat(padding)}` }],
          usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 },
          timestamp: i * 1000 + 1
        }
      })
    )
    parent = `a${i}`
  }
  await writeFile(file, `${lines.join('\n')}\n`)
}

/** A session whose mid-file row passes the probe but no parser can read: only the SDK can judge it. */
function corruptSessionText(id: string, cwd: string, corrupt: string): string {
  return `${[
    JSON.stringify({ type: 'session', version: 3, id, cwd, timestamp: '2026-01-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'message', id: 'u0', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: 'q0' } }),
    JSON.stringify({
      type: 'message', id: 'a0', parentId: 'u0', timestamp: '2026-01-01T00:00:02.000Z',
      message: {
        role: 'assistant', provider: 'test', model: 'recorder', stopReason: 'stop',
        content: [{ type: 'text', text: 'first' }],
        usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 }
      }
    }),
    corrupt,
    JSON.stringify({ type: 'message', id: 'u1', parentId: 'm1', timestamp: '2026-01-01T00:00:04.000Z', message: { role: 'user', content: 'q1' } }),
    JSON.stringify({
      type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-01-01T00:00:05.000Z',
      message: {
        role: 'assistant', provider: 'test', model: 'recorder', stopReason: 'stop',
        content: [{ type: 'text', text: 'second' }],
        usage: { input: 20, output: 3, cacheRead: 0, cacheWrite: 0 }
      }
    })
  ].join('\n')}\n`
}

/** A trailing comma: the probe only sees a well-shaped line that ends in `}`. */
const CORRUPT_MODEL_CHANGE =
  '{"type":"model_change","id":"m1","parentId":"a0","timestamp":"2026-01-01T00:00:03.000Z","provider":"test","modelId":"reasoner",}'

/** Let the deferred index task run: it is scheduled behind the IPC reply, not inline. */
async function settleIndex(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

async function runFixture(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pig-open-window-'))
  const cwd = join(root, 'project')
  const file = join(cwd, 'session.jsonl')
  const previous = process.env.PIG_DIR
  const { mock } = await import('bun:test')
  let registry: typeof import('../src/main/pi/session-registry') | undefined
  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(cwd, { recursive: true }))
    process.env.PIG_DIR = join(root, 'pig')
    await writeSession(file, cwd)

    // The IPC layer is exercised through the handlers it registers, so the validation guards can be
    // tested where they run rather than through a copy of them.
    const handlers = new Map<string, (...args: any[]) => any>()
    mock.module('electron', () => ({
      app: { isPackaged: false },
      ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => { handlers.set(channel, handler) } },
      dialog: {},
      nativeTheme: { shouldUseDarkColors: false },
      BrowserWindow: { fromWebContents: () => ({}), getAllWindows: () => [] },
      // The branch namer forks a worker process; no handler under test reaches it.
      utilityProcess: {}
    }))
    mock.module(fileURLToPath(new URL('../src/main/project-worktrees.ts', import.meta.url)), () => ({
      worktrees: { assertAvailable() {} }
    }))
    mock.module(fileURLToPath(new URL('../src/main/pi/chat-resources.ts', import.meta.url)), () => ({
      sessionResourceSettings: () => resourceSettings,
      createChatResourceLoader: async () => ({ getExtensions: () => ({ extensions: [], errors: [] }) }),
      createNoExtensionsResourceLoader: async () => ({ getExtensions: () => ({ extensions: [], errors: [] }) }),
      sessionSkillChoices: () => []
    }))
    // Bun rebinds the module's exports when a mock is registered, so the real function has to be
    // captured as a value before the mock replaces it.
    const realTreeViews = (await import('../src/main/pi/session-tree')).buildSessionTreeViews
    let treeBuilds = 0
    mock.module(fileURLToPath(new URL('../src/main/pi/session-tree.ts', import.meta.url)), () => ({
      buildSessionTreeViews: (...args: Parameters<typeof realTreeViews>) => {
        treeBuilds += 1
        return realTreeViews(...args)
      }
    }))
    // The model runtime is faked so the controls read has a deterministic picker; the session file
    // readers stay real, because that is what these cases are about.
    const models = [
      { id: 'reasoner', provider: 'test', name: 'Reasoner', reasoning: true, contextWindow: 1000 },
      { id: 'recorder', provider: 'test', name: 'Recorder', reasoning: true, contextWindow: 500 },
      { id: 'plain', provider: 'test', name: 'Plain', reasoning: false, contextWindow: 200 }
    ]
    const sdk = await import('@earendil-works/pi-coding-agent')
    const resourceSettings = sdk.SettingsManager.fromStorage({ withLock(_scope, fn) { assert.equal(fn('{"packages":[]}'), undefined) } })
    mock.module('@earendil-works/pi-coding-agent', () => ({
      ...sdk,
      ModelRuntime: { create: async () => ({
        refresh: async () => {},
        getModel: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
        getProvider: () => ({ name: 'Test' }),
        getAvailableSnapshot: () => models
      }) },
      SettingsManager: { create: () => ({
        getDefaultProvider: () => 'test',
        getDefaultModel: () => 'plain',
        getModelThinkingLevel: () => 'medium',
        getDefaultThinkingLevel: () => 'low', getCompactionSettings: () => ({ enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 })
      }) },
      createAgentSession: async () => ({
        session: {
          sessionId: 'guard-session',
          agent: { streamFunction: () => { throw new Error('Unexpected model request') } },
          subscribe: () => () => {},
          bindExtensions: async () => {},
          abort: async () => {},
          dispose() {},
          extensionRunner: { emit: async () => {} }
        }
      })
    }))
    const pushes: Array<{ channel: string; update: Record<string, unknown> }> = []
    const win = {
      isDestroyed: () => false,
      webContents: Object.assign(new EventEmitter(), {
        isDestroyed: () => false,
        send: (channel: string, update: Record<string, unknown>) => { pushes.push({ channel, update }) }
      })
    } as unknown as import('electron').BrowserWindow

    registry = await import('../src/main/pi/session-registry')
    const preview = await registry.openSession(file, win)
    assert.equal(preview.sessionId, 'tail-session')
    assert.equal(preview.display.indexPending, true, 'opening must not wait for the branch index')
    assert.equal(preview.display.startIndex, 0)
    assert.equal(preview.display.turns.length, 60, 'the tail window is what the first paint shows')
    assert.equal(preview.display.summary, undefined, 'the third place stays provisional too')
    assert.equal(pushes.length, 0, 'nothing is pushed before the index exists')

    // The index is built after the reply; its window replaces the provisional counts.
    await settleIndex()
    assert.equal(pushes.length, 1, 'the deferred index announces exactly one window')
    assert.equal(pushes[0]!.channel, 'session:window')
    const update = pushes[0]!.update as {
      sessionId: string; startIndex: number; totalTurns: number; summary: { bytes: number }[]
    }
    assert.equal(update.sessionId, 'tail-session')
    assert.equal(update.totalTurns, PASSING_TURNS)
    assert.equal(update.startIndex, PASSING_TURNS - 60, 'the tail sits at the end of the branch')
    assert.equal(update.summary.length, PASSING_TURNS, 'the minimap gets one weight per turn')
    assert.ok(update.summary[0]!.bytes > 0)

    // A second open of the same session answers from the index it already built.
    const again = await registry.openSession(file, win)
    assert.equal(again.display.startIndex, PASSING_TURNS - 60)
    assert.equal(again.display.indexPending, undefined)
    assert.equal(again.display.summary?.length, PASSING_TURNS)

    const { getTurnWindow } = await import('../src/main/pi/session-display')
    const older = await getTurnWindow('tail-session', 0, 5)
    assert.equal(older.startIndex, 0)
    assert.deepEqual(older.turns.map((turn) => turn.id), ['u0', 'u1', 'u2', 'u3', 'u4'])

    // A row the byte index accepted but no parser can read: the index counts it, the SDK does not.
    const brokenDir = join(root, 'broken')
    const broken = join(brokenDir, 'session.jsonl')
    await mkdir(brokenDir, { recursive: true })
    await writeFile(broken, `${[
      JSON.stringify({ type: 'session', version: 3, id: 'broken-session', cwd, timestamp: '2026-01-01T00:00:00.000Z' }),
      JSON.stringify({ type: 'message', id: 'u0', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: 'q0' } }),
      JSON.stringify({ type: 'message', id: 'a0', parentId: 'u0', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
      // A trailing comma: the probe only sees a well-shaped line that ends with `}`.
      '{"type":"message","id":"u1","parentId":"a0","timestamp":"2026-01-01T00:00:03.000Z","message":{"role":"user","content":"q1",}}',
      JSON.stringify({ type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-01-01T00:00:04.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] } })
    ].join('\n')}\n`)
    const brokenMark = pushes.length
    const brokenPreview = await registry.openSession(broken, win)
    assert.equal(brokenPreview.sessionId, 'broken-session')
    await settleIndex()
    const indexUpdate = pushes[brokenMark]!.update as { totalTurns: number }
    assert.equal(indexUpdate.totalTurns, 2, 'the byte index counts the row a parser drops')

    const { getDisplayTurns } = await import('../src/main/pi/session-display')
    const { managerSource } = await import('../src/main/pi/session-source')
    const { displayWindow } = await import('../src/main/pi/session-source')
    const { SessionManager } = await import('@earendil-works/pi-coding-agent')
    // The SDK is the source of truth for a file the index cannot reproduce, whatever it makes of it.
    const expected = displayWindow(managerSource(SessionManager.open(broken)))
    const downgraded = await getDisplayTurns('broken-session')
    assert.deepEqual(downgraded.turns.map((turn) => turn.id), expected.turns.map((turn) => turn.id))
    assert.equal(downgraded.totalTurns, expected.totalTurns)
    const correction = pushes[pushes.length - 1]!.update as { totalTurns: number; startIndex: number }
    assert.equal(correction.totalTurns, expected.totalTurns, 'the renderer is told the corrected window')
    assert.equal(correction.startIndex, expected.startIndex)
    // Every later read stays on the manager the file was downgraded to.
    const after = await getDisplayTurns('broken-session')
    assert.deepEqual(after.turns.map((turn) => turn.id), expected.turns.map((turn) => turn.id))
    assert.equal(after.totalTurns, expected.totalTurns)

    // A tail that already reached the file start must not be relabelled as a slice of the branch.
    const smallDir = join(root, 'small')
    const small = join(smallDir, 'session.jsonl')
    await mkdir(smallDir, { recursive: true })
    await writeSession(small, cwd, 'small-session', 100, 0)
    const smallMark = pushes.length
    const smallPreview = await registry.openSession(small, win)
    assert.equal(smallPreview.sessionId, 'small-session')
    assert.equal(smallPreview.display.turns.length, 100)
    assert.equal(smallPreview.display.indexPending, false, 'the tail already covered the whole file')
    await settleIndex()
    const smallUpdate = pushes[smallMark]!.update as { startIndex: number; totalTurns: number }
    assert.equal(smallUpdate.startIndex, 0, 'a window that holds every turn keeps its first turn')
    assert.equal(smallUpdate.totalTurns, 100)

    // The controls read is the picker's only source, and it reads the same rows the index does: a
    // row the probe accepted but the parser refuses must degrade to the SDK instead of rejecting.
    const controlsDir = join(root, 'controls')
    const controlsFile = join(controlsDir, 'session.jsonl')
    const controlsId = 'controls-session'
    await mkdir(controlsDir, { recursive: true })
    await writeFile(controlsFile, corruptSessionText(controlsId, cwd, CORRUPT_MODEL_CHANGE))
    const controlsMark = pushes.length
    assert.equal((await registry.openSession(controlsFile, win)).sessionId, controlsId)
    await settleIndex()
    const controlsUpdate = pushes[controlsMark]!.update as { error?: string; totalTurns: number }
    assert.equal(controlsUpdate.error, undefined, 'the index accepted a line it cannot parse')
    assert.equal(controlsUpdate.totalTurns, 2, 'the index counts the row a parser drops')
    const controls = await registry.getSessionControls(controlsId)
    assert.equal(controls.model?.id, 'recorder', 'the SDK answers for the file the index disagreed with')
    assert.ok(controls.thinkingLevels.length > 0, 'the picker is filled instead of left at defaults')

    // Lightbox images read the same file: a row no parser can read is an absent image, not a
    // rejected protocol request that renders as a broken picture.
    const imageDir = join(root, 'image')
    const imageFile = join(imageDir, 'session.jsonl')
    const imageId = 'image-session'
    await mkdir(imageDir, { recursive: true })
    await writeFile(imageFile, corruptSessionText(imageId, cwd, CORRUPT_MODEL_CHANGE))
    assert.equal((await registry.openSession(imageFile, win)).sessionId, imageId)
    await settleIndex()
    assert.equal((await registry.sessionEntryLookup(imageId, 'a0'))?.id, 'a0', 'a readable entry still resolves')
    assert.equal(await registry.sessionEntryLookup(imageId, 'm1'), undefined,
      'the unrelated row is an absent image, and the read does not throw')

    // A choice made while the file was still readable has to survive the fallback that a later read
    // triggers: the replacement session carries it, so the picker does not silently reset.
    const carryDir = join(root, 'carry')
    const carryFile = join(carryDir, 'session.jsonl')
    const carryId = 'carry-session'
    await mkdir(carryDir, { recursive: true })
    await writeFile(carryFile, `${[
      JSON.stringify({ type: 'session', version: 3, id: carryId, cwd, timestamp: '2026-01-01T00:00:00.000Z' }),
      JSON.stringify({ type: 'message', id: 'u0', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: 'q0' } }),
      JSON.stringify({
        type: 'message', id: 'a0', parentId: 'u0', timestamp: '2026-01-01T00:00:02.000Z',
        message: { role: 'assistant', provider: 'test', model: 'recorder', stopReason: 'stop', content: [{ type: 'text', text: 'first' }], usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 } }
      }),
      '{"type":"message","id":"u1","parentId":"a0","timestamp":"2026-01-01T00:00:03.000Z","message":{"role":"user","content":"q1",}}',
      JSON.stringify({
        type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-01-01T00:00:04.000Z',
        message: { role: 'assistant', provider: 'test', model: 'recorder', stopReason: 'stop', content: [{ type: 'text', text: 'second' }], usage: { input: 20, output: 3, cacheRead: 0, cacheWrite: 0 } }
      })
    ].join('\n')}\n`)
    assert.equal((await registry.openSession(carryFile, win)).sessionId, carryId)
    await settleIndex()
    // Controls only read the last model/thinking/assistant rows, so this pick succeeds untouched.
    assert.equal((await registry.setSessionModel(carryId, 'test', 'reasoner')).model?.id, 'reasoner')
    // Reading the tree walks every branch row, finds the corrupt one, and falls back to the SDK.
    await registry.getSessionTrees(carryId)
    assert.equal((await registry.getSessionControls(carryId)).model?.id, 'reasoner',
      'the model the user picked before the fallback is not replaced by the file default')

    // The prompt path can promote a pending file session before its deferred scan runs: the scan has
    // nobody left to answer, and its file-index window must not overwrite the live session's view.
    const guardDir = join(root, 'guard')
    const guardFile = join(guardDir, 'session.jsonl')
    await mkdir(guardDir, { recursive: true })
    await writeFile(guardFile, `${[
      JSON.stringify({ type: 'session', version: 3, id: 'guard-session', cwd, timestamp: '2026-01-01T00:00:00.000Z' }),
      JSON.stringify({ type: 'message', id: 'u0', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: 'q0' } }),
      '{"type":"message","id":"a0","parentId":"u0","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"x",}],}}',
      JSON.stringify({ type: 'message', id: 'u1', parentId: 'u0', timestamp: '2026-01-01T00:00:03.000Z', message: { role: 'user', content: 'q1' } })
    ].join('\n')}\n`)
    const guardMark = pushes.length
    assert.equal((await registry.openSession(guardFile, win)).sessionId, 'guard-session')
    await registry.prepareSession('guard-session')
    // The SDK owns the file now, and the queued scan has to stand down rather than read anything:
    // removing the file is how the test tells "did not scan" apart from "scanned and stayed quiet".
    await rm(guardFile, { force: true })
    const guardErrors: unknown[][] = []
    const originalGuardError = console.error
    console.error = (...args: unknown[]) => { guardErrors.push(args) }
    try {
      await settleIndex()
    } finally {
      console.error = originalGuardError
    }
    assert.deepEqual(guardErrors, [], 'a promoted session is not scanned by the index it no longer needs')
    assert.deepEqual(pushes.slice(guardMark), [], 'a promoted session is not answered by a file index')

    // Two readers of the same pending file share one tree build: the index cannot change while it is
    // pending, so a second walk would only duplicate work.
    treeBuilds = 0
    const [treeA, treeB] = await Promise.all([
      registry.getSessionTrees('tail-session'),
      registry.getSessionTrees('tail-session')
    ])
    assert.equal(treeBuilds, 1, 'concurrent tree reads build the tree once')
    assert.ok(treeA.default && treeA.default.length > 0)
    assert.deepEqual(
      treeA.default?.map((row) => row.id),
      treeB.default?.map((row) => row.id)
    )
    assert.equal(treeBuilds, 1, 'a cached tree is not rebuilt')

    // A window request is the one read with numeric arguments: a NaN start must not reach the reader
    // (it would make the renderer's own offset NaN and paging would silently stop), and a fat count
    // must not turn into one huge read.
    const ipcDir = join(root, 'ipc')
    const ipcFile = join(ipcDir, 'session.jsonl')
    await mkdir(ipcDir, { recursive: true })
    await writeSession(ipcFile, cwd, 'ipc-session', 260, 0)
    assert.equal((await registry.openSession(ipcFile, win)).sessionId, 'ipc-session')
    await settleIndex()
    const { registerSessionIpc } = await import('../src/main/ipc/session')
    registerSessionIpc()
    const turnWindow = handlers.get('session:get-turn-window')!
    assert.ok(turnWindow, 'the window handler is registered')
    await assert.rejects(turnWindow({}, 'ipc-session', Number.NaN, 10), /non-negative integer/)
    await assert.rejects(turnWindow({}, 'ipc-session', -1, 10), /non-negative integer/)
    await assert.rejects(turnWindow({}, 'ipc-session', 1.5, 10), /non-negative integer/)
    await assert.rejects(turnWindow({}, 'ipc-session', 0, Number.NaN), /must be a number/)
    const clamped = (await turnWindow({}, 'ipc-session', 0, 5000)) as { turns: unknown[]; startIndex: number }
    assert.equal(clamped.startIndex, 0)
    assert.equal(clamped.turns.length, 200, 'one request never reads more than the page cap')
    const tiny = (await turnWindow({}, 'ipc-session', 0, 0)) as { turns: unknown[] }
    assert.equal(tiny.turns.length, 1, 'a count below one still reads one turn')
    const tail = (await turnWindow({}, 'ipc-session', 1000, 5)) as { turns: unknown[] }
    assert.equal(tail.turns.length, 0, 'a start beyond the branch is an empty window, not an error')

    // A session file that stops being one before the deferred index runs must surface as a reported
    // failure instead of escaping as an unhandled rejection: the reader refuses it and the SDK
    // fallback throws on it.
    const doomedDir = join(root, 'doomed')
    const doomed = join(doomedDir, 'session.jsonl')
    await mkdir(doomedDir, { recursive: true })
    await writeSession(doomed, cwd, 'doomed-session', 80, 0)
    const reported: unknown[][] = []
    const previousError = console.error
    // The index is queued with setImmediate: replacing the file inside the wrapper provably happens
    // before the queued task, whichever order the runtime dispatches its callbacks in.
    const immediate = globalThis.setImmediate
    globalThis.setImmediate = ((callback: (...args: never[]) => void, ...args: never[]) =>
      immediate(() => {
        writeFileSync(doomed, 'not a session anymore\n')
        callback(...args)
      })) as unknown as typeof globalThis.setImmediate
    console.error = (...args: unknown[]) => { reported.push(args) }
    const beforeDoomed = pushes.length
    try {
      await registry.openSession(doomed, win)
      await settleIndex()
      assert.equal(reported.length, 1, 'the failed background index is reported once')
      assert.match(String(reported[0]), /Failed to index session/)
      // The renderer waits on this index: it has to hear that it will never arrive.
      assert.equal(pushes.length, beforeDoomed + 1, 'the failure reaches the renderer as well')
      const failure = pushes[beforeDoomed]!.update as { sessionId: string; error?: string }
      assert.equal(failure.sessionId, 'doomed-session')
      assert.match(String(failure.error), /not a valid/, 'the push carries the reason')
    } finally {
      console.error = previousError
      globalThis.setImmediate = immediate
    }

    // A failed scan is not a verdict on the file: reopening it asks for the index again, so a reader
    // who reopens a session whose first scan died is not left with a provisional window forever.
    await writeSession(doomed, cwd, 'doomed-session', 80, 0)
    const retriedPreview = await registry.openSession(doomed, win)
    assert.equal(retriedPreview.sessionId, 'doomed-session')
    assert.equal(retriedPreview.display.turns.length, 80, 'the tail answers again while the index is rebuilt')
    const retryMark = pushes.length
    await settleIndex()
    const retried = pushes[retryMark]!.update as { error?: string; totalTurns: number }
    assert.equal(retried.error, undefined, 'the second scan reports the index instead of another failure')
    assert.equal(retried.totalTurns, 80)
  } finally {
    if (previous === undefined) delete process.env.PIG_DIR
    else process.env.PIG_DIR = previous
    await registry?.disposeAll()
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv.includes('--open-window-fixture')) {
  await runFixture()
} else {
  test('opening shows the tail before the branch index exists', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--open-window-fixture'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const timeout = setTimeout(() => child.kill(), 25_000)
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
      ])
      assert.equal(exitCode, 0, stderr || stdout)
    } finally {
      clearTimeout(timeout)
      child.kill()
    }
  }, 30_000)
}
