/**
 * The catalog is app-wide state, so its two guarantees are the ones a session-level list could not
 * make: a refresh reaches every window (not only the one whose button started it), and a refresh
 * that changed nothing still reports the pass ending, or every other picker spins forever.
 *
 * The SDK mock is a real object with a switchable model list, so a refresh that adds a provider is
 * the same code path the app runs. Runs in a child process like the other main-process fixtures
 * because bun's module mocks are process-wide.
 */
import { test } from 'bun:test'
import assert from 'node:assert/strict'

async function fixture(): Promise<void> {
  const { mock } = await import('bun:test')
  const sent: { window: number; channel: string; catalog: unknown }[] = []
  let windows = 0
  mock.module('electron', () => ({
    BrowserWindow: {
      getAllWindows: () => Array.from({ length: windows }, (_, index) => ({
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: (channel: string, catalog: unknown) => sent.push({ window: index, channel, catalog })
        }
      }))
    }
  }))

  let models = [{ id: 'one', name: 'One', provider: 'test', contextWindow: 100, reasoning: false }]
  let refreshError: Error | undefined
  let refreshes = 0
  mock.module('@earendil-works/pi-coding-agent', () => ({
    ModelRuntime: {
      create: async () => ({
        refresh: async () => {
          refreshes += 1
          if (refreshError) throw refreshError
        },
        getProvider: () => ({ name: 'Test' }),
        getAvailableSnapshot: () => models
      })
    },
    SettingsManager: {}
  }))

  const catalog = await import('../src/main/pi/model-catalog')
  const { toModelInfo } = await import('../src/main/pi/model-settings')
  const reasoner = { id: 'reasoner', name: 'Reasoner', provider: 'test', contextWindow: 100, reasoning: true }
  assert.deepEqual(toModelInfo(reasoner).thinkingLevels, ['off', 'minimal', 'low', 'medium', 'high'])
  assert.deepEqual(toModelInfo({ ...reasoner, thinkingLevelMap: { minimal: null, xhigh: 'xhigh' } }).thinkingLevels,
    ['off', 'low', 'medium', 'high', 'xhigh'], 'plugin levels keep off/minimal when supported, but exclude explicitly unsupported levels')
  assert.deepEqual(toModelInfo({ ...reasoner, reasoning: false }).thinkingLevels, [])

  windows = 2
  const first = await catalog.currentModelCatalog()
  assert.equal(first.refreshing, false)
  assert.deepEqual(first.models.map((model) => model.id), ['one'], 'the on-disk list is read on demand')
  assert.equal(first.revision, 0, 'reading is not a change')

  // A pass that finds the same list still announces both of its ends.
  const unchanged = await catalog.refreshModelCatalog()
  assert.equal(unchanged.revision, 0, 'an unchanged list does not move the revision')
  assert.equal(unchanged.refreshing, false)
  assert.deepEqual(sent.map((item) => item.catalog && (item.catalog as { refreshing: boolean }).refreshing),
    [true, true, false, false], 'every window hears the pass start and end')

  // A pass that adds a provider moves the revision and carries the new list to both windows.
  sent.length = 0
  models = [
    { id: 'one', name: 'One', provider: 'test', contextWindow: 100, reasoning: false },
    { id: 'two', name: 'Two', provider: 'test', contextWindow: 200, reasoning: true }
  ]
  const added = await catalog.refreshModelCatalog()
  assert.equal(added.revision, 1)
  assert.deepEqual(added.models.map((model) => model.id), ['one', 'two'])
  assert.equal(sent.length, 4, 'two windows, two ends of the pass')
  assert.deepEqual(sent.map((item) => item.window), [0, 1, 0, 1])
  assert.ok(sent.every((item) => item.channel === 'models:changed'))

  // Concurrent callers share one pass instead of stacking requests behind the SDK's own throttle.
  sent.length = 0
  const started = [catalog.refreshModelCatalog(), catalog.refreshModelCatalog(), catalog.refreshModelCatalog()]
  assert.equal(started[0], started[1], 'the in-flight pass is handed back rather than restarted')
  await Promise.all(started)
  assert.equal(refreshes, 3, 'one pass per caller group: two so far plus this one')
  assert.deepEqual(
    sent.filter((item) => (item.catalog as { refreshing: boolean }).refreshing).length,
    2,
    'the shared pass is announced once per window, not once per caller'
  )

  // A failed pass must still end: a picker spinning on `refreshing` would never stop otherwise.
  sent.length = 0
  refreshError = new Error('network unavailable')
  await assert.rejects(catalog.refreshModelCatalog(), (error) => error === refreshError)
  assert.equal((await catalog.currentModelCatalog()).refreshing, false)
  assert.equal(sent.length, 4, 'a failed pass announces its own start and end too')
  assert.equal((sent.at(-1)!.catalog as { refreshing: boolean }).refreshing, false)

  // A closed window is skipped rather than failing the refresh that fed it.
  refreshError = undefined
  windows = 1
  sent.length = 0
  await catalog.refreshModelCatalog()
  assert.ok(sent.every((item) => item.window === 0))

  sent.length = 0
  const before = refreshes
  models = models.filter((model) => model.id !== 'two')
  const removed = catalog.synchronizeModelCatalog()
  assert.deepEqual(removed.models.map((model) => model.id), ['one'])
  assert.equal(removed.revision, added.revision + 1)
  assert.equal(sent.length, 1)
  assert.equal(refreshes, before, 'syncing extension/auth changes never starts another refresh')
  catalog.synchronizeModelCatalog()
  assert.equal(sent.length, 1, 'an unchanged runtime does not cause another push')
}

if (process.argv[2] === '--model-catalog-fixture') {
  await fixture()
} else {
  test('model catalog: refreshes reach every window and always end', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--model-catalog-fixture'], {
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const timeout = setTimeout(() => child.kill(), 8_000)
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
      ])
      assert.equal(exitCode, 0, stderr || stdout)
    } finally {
      clearTimeout(timeout)
    }
  })
}
