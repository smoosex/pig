import { test } from 'bun:test'
import assert from 'node:assert/strict'
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

    mock.module('electron', () => ({ app: { isPackaged: false } }))
    mock.module(fileURLToPath(new URL('../src/main/project-worktrees.ts', import.meta.url)), () => ({
      worktrees: { assertAvailable() {} }
    }))
    const pushes: Array<{ channel: string; update: Record<string, unknown> }> = []
    const win = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: (channel: string, update: Record<string, unknown>) => { pushes.push({ channel, update }) }
      }
    } as unknown as import('electron').BrowserWindow

    registry = await import('../src/main/pi/session-registry')
    const preview = await registry.openSession(file, win)
    assert.equal(preview.sessionId, 'tail-session')
    assert.equal(preview.display.indexPending, true, 'opening must not wait for the branch index')
    assert.equal(preview.display.startIndex, 0)
    assert.equal(preview.display.turns.length, 60, 'the tail window is what the first paint shows')
    assert.equal(preview.display.summary, undefined, 'the third place stays provisional too')
    assert.deepEqual(pushes, [], 'nothing is pushed before the index exists')

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
      })) as typeof globalThis.setImmediate
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
