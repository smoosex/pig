/** Real shells: output capture, exit codes, waits, ownership and group cleanup of background processes. */
import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackgroundProcessController, RUNNING_LIMIT } from '../src/main/processes/controller'

const roots: string[] = []
const controllers: BackgroundProcessController[] = []
afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.shutdown()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function setup(live = new Set(['one', 'two'])) {
  const root = await mkdtemp(join(tmpdir(), 'pig-processes-'))
  roots.push(root)
  const changes: string[] = []
  const controller = new BackgroundProcessController({ sessionDirectory: (id) => live.has(id) ? root : undefined, changed: (id) => changes.push(id) })
  controllers.push(controller)
  const delivered: string[] = []
  controller.attach('one', ({ text }) => delivered.push(text))
  return { root, controller, live, changes, delivered }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const caught = (promise: Promise<unknown>) => promise.then(() => undefined, (error: Error) => error)

test('captures stdout and stderr, reports the real exit code and closes stdin', async () => {
  const { controller } = await setup()
  await controller.start('one', 'echo out; echo err >&2; read line; echo "read=$?"; printf "\\033[31mred\\033[0m 10%%\\r100%%\\n"; exit 3', {})
  const done = await controller.wait('one', 'proc-1', {})
  expect(done.text).toContain('proc-1: exited with code 3')
  const read = (await controller.read('one', 'proc-1', 100)).text
  // Separate pipes have no common order, only each stream's own.
  expect(read).toContain('out\nread=1\n100%')
  expect(read).toContain('[stderr] err')
  expect(read).not.toContain('\x1b')
  expect(read).toContain('Output (untrusted):')
})

test('text waits honour afterVersion, fail when the process exits first, time out and abort', async () => {
  const { controller } = await setup()
  await controller.start('one', 'echo ready; sleep 30', { name: 'server' })
  expect((await controller.wait('one', 'proc-1', { text: 'ready' })).text).toContain('Text appeared.')
  const version = Number(/output version (\d+)/.exec((await controller.list('one')).text)![1])
  const late = caught(controller.wait('one', 'proc-1', { text: 'ready', afterVersion: version, timeoutMs: 200 }))
  expect((await late)?.message).toMatch(/Timed out after 200 ms; proc-1 is running/)
  const abort = new AbortController()
  const aborted = caught(controller.wait('one', 'proc-1', { text: 'never' }, abort.signal))
  abort.abort(new Error('stopped by user'))
  expect((await aborted)?.message).toBe('stopped by user')
  expect((await controller.list('one')).text).toContain('proc-1 "server": running')

  await controller.start('one', 'echo bye', {})
  expect((await caught(controller.wait('one', 'proc-2', { text: 'missing' })))?.message).toBe('proc-2 exited with code 0 before the text appeared')
})

test('stop ends the whole process group, including children that ignore SIGTERM', async () => {
  const { controller } = await setup()
  await controller.start('one', "sh -c 'trap \"\" TERM; while :; do sleep 1; done' & echo child=$!; wait", {})
  await controller.wait('one', 'proc-1', { text: 'child=' })
  const child = Number(/child=(\d+)/.exec((await controller.read('one', 'proc-1', 10)).text)![1])
  expect(alive(child)).toBe(true)
  expect((await controller.stop('one', 'proc-1')).text).toContain('proc-1: stopped')
  await new Promise((resolve) => setTimeout(resolve, 1300))
  expect(alive(child)).toBe(false)
  expect((await controller.stop('one', 'proc-1')).text).toBe('proc-1 had already stopped.')
})

test('processes belong to their session, which kills them on close', async () => {
  const { root, controller, live } = await setup()
  await mkdir(join(root, 'sub'))
  await controller.start('one', 'pwd; sleep 30', { cwd: 'sub' })
  await controller.wait('one', 'proc-1', { text: 'sub' })
  await expect(controller.read('two', 'proc-1', 10)).rejects.toThrow('Unknown background process in this session: proc-1')
  expect((await controller.list('two')).text).toBe('No background processes in this session.')
  await expect(controller.start('one', 'true', { cwd: 'missing' })).rejects.toThrow('Directory does not exist')
  await expect(controller.start('gone', 'true', {})).rejects.toThrow('This session is not open in Pig')

  const pid = Number(/pid (\d+)/.exec((await controller.list('one')).text)![1])
  live.delete('one')
  await controller.sessionClosed('one')
  expect(alive(pid)).toBe(false)
  expect((await controller.list('one')).text).toBe('No background processes in this session.')
})

test('a session runs at most the running limit at once', async () => {
  const { controller } = await setup()
  for (let index = 0; index < RUNNING_LIMIT; index++) await controller.start('one', 'sleep 30', {})
  await expect(controller.start('one', 'sleep 30', {})).rejects.toThrow(`already runs ${RUNNING_LIMIT}`)
  await controller.start('two', 'true', {})
  await controller.stop('one', 'proc-1')
  await controller.start('one', 'true', {})
})

test('shutdown kills every process and refuses new ones', async () => {
  const { controller } = await setup()
  await controller.start('one', 'sleep 30', {})
  const pid = Number(/pid (\d+)/.exec((await controller.list('one')).text)![1])
  await controller.shutdown()
  expect(alive(pid)).toBe(false)
  await expect(controller.start('one', 'true', {})).rejects.toThrow('Pig is quitting')
})

test('only exits the agent did not observe are delivered, and the snapshot classifies every ending', async () => {
  const { controller, changes, delivered } = await setup()
  await controller.start('one', 'echo hi; exit 2', { name: 'build' })
  await controller.start('one', 'exit 0', {})
  await controller.start('one', 'sleep 30', {})
  await controller.start('one', 'sleep 30', {})
  await controller.start('one', 'exit 5', {})
  await controller.wait('one', 'proc-5', {})
  await controller.stop('one', 'proc-3')
  await controller.stopByUser('one', 'proc-4')
  await Bun.sleep(100)

  expect(delivered).toHaveLength(3)
  // proc-1 and proc-2 race to exit, so find each message by content.
  const build = delivered.find((text) => text.startsWith('Background process proc-1 "build" exited on its own with code 2'))
  expect(build).toContain('```text\nhi\n```')
  expect(delivered.some((text) => text.startsWith('Background process proc-2 exited on its own with code 0'))).toBe(true)
  expect(delivered.some((text) => text.startsWith('Background process proc-4 was stopped by the user'))).toBe(true)
  expect(changes.every((id) => id === 'one')).toBe(true)

  const snapshot = controller.snapshot('one')
  expect(snapshot.map((item) => [item.id, item.status, item.exitCode])).toEqual([
    ['proc-1', 'failed', 2], ['proc-2', 'exited', 0], ['proc-3', 'stopped', null], ['proc-4', 'stopped', null], ['proc-5', 'failed', 5]
  ])
  expect(snapshot[0]).toMatchObject({ name: 'build', output: ['hi'] })
  expect(controller.snapshot('two')).toEqual([])

  await controller.start('one', 'sleep 30', {})
  expect(() => controller.remove('one', 'proc-6')).toThrow('Stop the background process before removing it')
  controller.remove('one', 'proc-1')
  expect(controller.snapshot('one').map((item) => item.id)).not.toContain('proc-1')
  expect(() => controller.remove('two', 'proc-2')).toThrow('Unknown background process')
})

test('a child that left the group cannot keep a stop, an exit or a session close waiting', async () => {
  const { controller } = await setup()
  const escaped = `perl -e 'use POSIX; setsid(); $|=1; print "escaped=$$\\n"; sleep 30'`
  const pids: number[] = []
  const escapedPid = async (id: string) => {
    await controller.wait('one', id, { text: 'escaped=' })
    pids.push(Number(/escaped=(\d+)/.exec((await controller.read('one', id, 10)).text)![1]))
  }
  try {
    await controller.start('one', `${escaped} & sleep 30`, {})
    await escapedPid('proc-1')
    const stopping = Date.now()
    expect((await controller.stop('one', 'proc-1')).text).toContain('proc-1: stopped')
    expect(Date.now() - stopping).toBeLessThan(4000)

    await controller.start('one', `${escaped} & echo done`, {})
    await escapedPid('proc-2')
    expect((await controller.wait('one', 'proc-2', { timeoutMs: 4000 })).text).toContain('proc-2: exited with code 0')

    await controller.start('one', `${escaped} & sleep 30`, {})
    await escapedPid('proc-3')
    const closing = Date.now()
    await controller.sessionClosed('one')
    expect(Date.now() - closing).toBeLessThan(4000)
  } finally {
    for (const pid of pids) process.kill(pid, 'SIGKILL')
  }
}, 20_000)

test('a partial line keeps the version it was first shown at once it completes', async () => {
  const { controller } = await setup()
  await controller.start('one', "printf 'loading'; sleep 0.3; echo ' done'; sleep 30", {})
  await controller.wait('one', 'proc-1', { text: 'loading' })
  const version = Number(/output version (\d+)/.exec((await controller.list('one')).text)![1])
  const error = await controller.wait('one', 'proc-1', { text: 'loading', afterVersion: version, timeoutMs: 800 }).then(() => undefined, (failure: Error) => failure)
  expect(error?.message).toMatch(/Timed out after 800 ms/)
  expect((await controller.read('one', 'proc-1', 10)).text).toContain('loading done')
})

test('the environment drops Electron and Pig variables', async () => {
  const { controller } = await setup()
  process.env.ELECTRON_TEST_FLAG = '1'
  try {
    await controller.start('one', 'env', {})
    await controller.wait('one', 'proc-1', {})
    const output = (await controller.read('one', 'proc-1', 500)).text
    expect(output).not.toContain('ELECTRON_TEST_FLAG')
    expect(output).toContain('NO_COLOR=1')
  } finally {
    delete process.env.ELECTRON_TEST_FLAG
  }
})
