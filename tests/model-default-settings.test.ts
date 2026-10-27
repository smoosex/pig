/** Exercise default preference persistence with real SDK storage and an offline model runtime. */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import type { ThinkingLevel } from '../src/shared/api'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture(name: string) {
  const sdk = await import('@earendil-works/pi-coding-agent')
  const RealSettingsManager = sdk.SettingsManager
  const models: Array<{
    id: string
    provider: string
    name: string
    contextWindow: number
    reasoning: boolean
    thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>
  }> = [
    { id: 'a', provider: 'test', name: 'A', contextWindow: 1000, reasoning: true },
    { id: 'b', provider: 'test', name: 'B', contextWindow: 2000, reasoning: true,
      thinkingLevelMap: { low: null, high: null, xhigh: 'extra', max: 'maximum' } },
    { id: 'plain', provider: 'test', name: 'Plain', contextWindow: 1000, reasoning: false },
    { id: 'locked', provider: 'test', name: 'Unavailable', contextWindow: 1000, reasoning: true }
  ]
  let available = models.filter(({ id }) => id !== 'locked')
  let stored = JSON.stringify({
    defaultProvider: 'test', defaultModel: 'a', defaultThinkingLevel: 'medium',
    modelThinkingLevels: { 'test/b': 'xhigh', 'test/other': 'high' },
    unrelated: 'private-value'
  })
  let project: string | undefined
  let failRead = false
  let failWrite = false
  let denyReadAfterWriteFailure = false
  let failReadAfterFlush = false
  let failAfterWrites = Infinity
  let accesses = 0
  let writes = 0
  let creates = 0
  let pauseFlush: { entered: ReturnType<typeof deferred>; released: ReturnType<typeof deferred> } | undefined
  const readError = new Error('Settings are unreadable')
  const writeError = new Error('Disk is read-only')
  const disk = () => JSON.parse(stored)
  const createSettings = () => {
    creates++
    const settings = RealSettingsManager.fromStorage({
      withLock(scope, fn) {
        accesses++
        if (failRead) throw readError
        const next = fn(scope === 'global' ? stored : project)
        if (next === undefined) return
        writes++
        if (failWrite || writes > failAfterWrites) {
          if (denyReadAfterWriteFailure) failRead = true
          throw writeError
        }
        if (scope === 'global') stored = next
        else project = next
      }
    })
    const flush = settings.flush.bind(settings)
    settings.flush = async () => {
      const pause = pauseFlush
      pauseFlush = undefined
      await flush()
      if (pause) {
        pause.entered.resolve()
        await pause.released.promise
      }
      if (failReadAfterFlush) {
        failReadAfterFlush = false
        failRead = true
      }
    }
    return settings
  }
  mock.module('@earendil-works/pi-coding-agent', () => ({
    ...sdk,
    SettingsManager: { create: createSettings },
    ModelRuntime: { create: async () => ({
      getModel: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
      getAvailableSnapshot: () => available,
      getProvider: () => undefined
    }) }
  }))
  const api = await import('../src/main/pi/model-settings')
  const setDefaultModel = async (provider: string, id: string) => (await api.updateDefaultSettings({ model: { provider, id } })).effective
  const setDefaultThinking = async (thinkingLevel: ThinkingLevel) => (await api.updateDefaultSettings({ thinkingLevel })).effective

  if (name === 'read') {
    const first = await api.readDefaultSettings()
    assert.deepEqual(first.stored, { model: { provider: 'test', id: 'a' }, thinkingLevel: 'medium' })
    assert.equal(first.effective.model?.id, 'a')
    assert.equal(first.effective.thinkingLevel, 'medium')
    assert.deepEqual(first.effective.thinkingLevels, ['low', 'medium', 'high'])
    assert.equal(first.modelThinkingLevel, null)
    assert.match(first.revision, /^[a-f0-9]{64}$/)
    assert.deepEqual(await api.getDefaultSessionSettings(), first.effective)
    stored = JSON.stringify({
      authToken: 'never-expose-this',
      modelThinkingLevels: { 'test/other': 'high', 'test/b': 'xhigh' },
      defaultThinkingLevel: 'medium', defaultModel: 'a', defaultProvider: 'test'
    })
    assert.equal((await api.readDefaultSettings()).revision, first.revision, 'key ordering and unrelated settings do not invalidate CAS')
    assert.doesNotMatch(JSON.stringify(await api.readDefaultSettings()), /never-expose-this|authToken|private-value/)
    stored = JSON.stringify({ ...disk(), modelThinkingLevels: { ...disk().modelThinkingLevels, 'test/unselected': 'low' } })
    assert.notEqual((await api.readDefaultSettings()).revision, first.revision, 'all persisted model preferences participate in CAS')
    project = JSON.stringify({ defaultModel: 'b', modelThinkingLevels: { 'test/b': 'off' } })
    const layered = await api.readDefaultSettings()
    assert.deepEqual(layered.stored, first.stored, 'stored reports personal defaults, not project overrides')
    assert.equal(layered.effective.model?.id, 'b')
    assert.equal(layered.modelThinkingLevel, 'off', 'the raw model preference is not hidden by the default picker')
    assert.equal(layered.effective.thinkingLevel, 'medium', 'unsupported/hidden preferences fall back to the first visible level')
    assert.notEqual(layered.revision, first.revision, 'persisted project overrides also affect the revision')
    project = undefined
    stored = '{}'
    const empty = await api.readDefaultSettings()
    assert.deepEqual(empty.stored, { model: null, thinkingLevel: null })
    assert.equal(empty.effective.model?.id, 'a')
    assert.equal(empty.effective.thinkingLevel, 'low')
    stored = '{"defaultProvider":"test"}'
    assert.notEqual((await api.readDefaultSettings()).revision, empty.revision, 'incomplete saved model identities still participate in CAS')
    available = []
    assert.deepEqual((await api.readDefaultSettings()).effective, { model: null, thinkingLevel: null, thinkingLevels: [] })
    assert.equal(writes, 0, 'reads must never persist defaults or migrations')
    return
  }

  if (name === 'validation') {
    const before = stored
    for (const level of ['off', 'minimal', 'invalid'] as ThinkingLevel[]) {
      await assert.rejects(api.updateDefaultSettings({ model: { provider: 'test', id: 'b' }, thinkingLevel: level }), /Invalid thinking level/)
    }
    for (const level of ['low', 'high'] as const) {
      await assert.rejects(api.updateDefaultSettings({ model: { provider: 'test', id: 'b' }, thinkingLevel: level }), /not supported/)
    }
    await assert.rejects(api.updateDefaultSettings({ thinkingLevel: 'xhigh' }), /not supported/)
    await assert.rejects(api.updateDefaultSettings({ model: { provider: 'test', id: 'plain' }, thinkingLevel: 'low' }), /not supported/)
    await assert.rejects(api.updateDefaultSettings({}), /empty/)
    await assert.rejects(api.updateDefaultSettings({ thinkingLevel: undefined }), /empty/)
    await assert.rejects(api.updateDefaultSettings({ model: { provider: 'test', id: 'missing' }, thinkingLevel: 'high' }), /Model not found/)
    await assert.rejects(api.updateDefaultSettings({ model: { provider: 'test', id: 'locked' }, thinkingLevel: 'high' }), /Model not available/)
    await assert.rejects(setDefaultModel('missing', 'a'), /Model not found/)
    await assert.rejects(setDefaultThinking('off'), /Invalid thinking level/)
    assert.equal(stored, before)
    assert.equal(writes, 0, 'every field is validated before any SDK setter runs')
    available = []
    stored = '{}'
    await assert.rejects(api.updateDefaultSettings({ thinkingLevel: 'high' }), /Model not available/)
    assert.equal(writes, 0)
    // A signed-out default model keeps the levels the settings page shows, so they stay selectable.
    stored = JSON.stringify({ defaultProvider: 'test', defaultModel: 'locked', defaultThinkingLevel: 'medium' })
    const locked = await api.updateDefaultSettings({ thinkingLevel: 'high' })
    assert.equal(locked.effective.model?.id, 'locked')
    assert.equal(locked.stored.thinkingLevel, 'high')
    assert.equal(disk().modelThinkingLevels['test/locked'], 'high')
    return
  }

  if (name === 'updates') {
    const initial = await api.readDefaultSettings()
    const combined = await api.updateDefaultSettings({ model: { provider: 'test', id: 'b' }, thinkingLevel: 'max' }, initial.revision)
    assert.deepEqual(combined.stored, { model: { provider: 'test', id: 'b' }, thinkingLevel: 'max' })
    assert.equal(combined.effective.thinkingLevel, 'max')
    assert.equal(combined.modelThinkingLevel, 'max')
    assert.deepEqual(combined.effective.thinkingLevels, ['medium', 'xhigh', 'max'])
    assert.notEqual(combined.revision, initial.revision)
    assert.deepEqual(await api.readDefaultSettings(), combined, 'the update returns a fresh persisted snapshot')
    const a = await setDefaultModel('test', 'a')
    assert.equal(a.thinkingLevel, 'low', 'model-only changes keep the picker fallback, not nearest-level clamping')
    assert.equal(disk().defaultThinkingLevel, 'low')
    assert.equal(disk().modelThinkingLevels['test/a'], 'low')
    assert.equal(disk().modelThinkingLevels['test/b'], 'max')
    assert.equal((await setDefaultThinking('high')).thinkingLevel, 'high')
    assert.equal(disk().defaultThinkingLevel, 'high')
    assert.equal(disk().modelThinkingLevels['test/a'], 'high')
    const b = await setDefaultModel('test', 'b')
    assert.equal(b.thinkingLevel, 'max', 'the target model preference wins over the global level')
    assert.equal(disk().defaultThinkingLevel, 'max', 'model-only changes persist the selected level globally too')
    const plain = await setDefaultModel('test', 'plain')
    assert.equal(plain.thinkingLevel, null)
    assert.deepEqual(plain.thinkingLevels, [])
    assert.equal(disk().defaultThinkingLevel, 'max', 'models without visible thinking levels leave thinking preferences untouched')
    assert.equal(disk().modelThinkingLevels['test/plain'], undefined)
    assert.equal(disk().unrelated, 'private-value')
    return
  }

  if (name === 'cas') {
    const first = await api.readDefaultSettings()
    const results = await Promise.allSettled([
      api.updateDefaultSettings({ thinkingLevel: 'low' }, first.revision),
      api.updateDefaultSettings({ thinkingLevel: 'high' }, first.revision)
    ])
    assert.equal(results[0]!.status, 'fulfilled')
    assert.equal(results[1]!.status, 'rejected')
    if (results[1]!.status === 'rejected') assert.match(String(results[1]!.reason), /revision conflict/)
    assert.equal(disk().defaultThinkingLevel, 'low')
    const next = await api.readDefaultSettings()
    await api.saveModelThinkingPreference({ provider: 'test', id: 'b' }, 'medium')
    const writesBeforeConflict = writes
    await assert.rejects(api.updateDefaultSettings({ thinkingLevel: 'high' }, next.revision), /revision conflict/)
    assert.equal(writes, writesBeforeConflict)
    assert.equal(disk().defaultThinkingLevel, 'low', 'model preference actions never change the global default')
    assert.notEqual((await api.readDefaultSettings()).revision, next.revision)
    await api.saveModelThinkingPreference({ provider: 'test', id: 'b' }, null)
    assert.equal(disk().modelThinkingLevels['test/b'], undefined)
    return
  }

  if (name === 'queue') {
    await api.readDefaultSettings()
    const pause = { entered: deferred(), released: deferred() }
    pauseFlush = pause
    const update = api.updateDefaultSettings({ model: { provider: 'test', id: 'b' }, thinkingLevel: 'xhigh' })
    await pause.entered.promise
    const accessesBefore = accesses
    const preference = api.saveModelThinkingPreference({ provider: 'test', id: 'a' }, 'high')
    const read = api.readDefaultSettings()
    const device = api.getOrCreateDeviceId()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    assert.equal(accesses, accessesBefore, 'preference reads/writes and installation identity must not overtake a pending default flush')
    pause.released.resolve()
    await update
    await preference
    const next = await read
    const deviceId = await device
    assert.equal(next.effective.model?.id, 'b')
    assert.equal(next.effective.thinkingLevel, 'xhigh')
    assert.equal(disk().modelThinkingLevels['test/a'], 'high')
    assert.equal(disk().modelThinkingLevels['test/b'], 'xhigh')
    assert.equal(disk().deviceId, deviceId)
    return
  }

  if (name === 'write-failure') {
    const before = await api.readDefaultSettings()
    failWrite = true
    await assert.rejects(setDefaultModel('test', 'b'), (error) => {
      assert.ok(error instanceof AggregateError)
      assert.match(error.message, /Could not save default settings/)
      assert.ok(error.errors.includes(writeError))
      return true
    })
    const createsBefore = creates
    assert.deepEqual(await api.readDefaultSettings(), before, 'failed writes cannot leak the attempted model or thinking level')
    assert.ok(creates > createsBefore, 'failed writers are discarded')
    denyReadAfterWriteFailure = true
    await assert.rejects(api.updateDefaultSettings({ model: { provider: 'test', id: 'b' }, thinkingLevel: 'max' }), /Could not save default settings/)
    await assert.rejects(api.readDefaultSettings(), /Could not read default settings/)
    assert.throws(() => api.defaultModelFromSettings(), /Could not reload thinking preferences/)
    assert.throws(() => api.modelThinkingFromSettings({ provider: 'test', id: 'b' }), /Could not reload thinking preferences/)
    await assert.rejects(api.getDefaultSessionSettings(), /Could not read default settings/)
    await assert.rejects(api.saveModelThinkingPreference({ provider: 'test', id: 'a' }, 'high'), /Could not reload thinking preferences/)
    failRead = false
    failWrite = false
    assert.deepEqual(await api.readDefaultSettings(), before, 'recovery must read persisted values, not a discarded snapshot')
    assert.equal((await api.updateDefaultSettings({ thinkingLevel: 'high' }, before.revision)).stored.thinkingLevel, 'high')
    return
  }

  if (name === 'read-failure') {
    const original = stored
    stored = '{"defaultModel":'
    await assert.rejects(api.getDefaultSessionSettings(), (error) => {
      assert.ok(error instanceof AggregateError)
      assert.ok(error.errors.every((cause) => cause instanceof SyntaxError))
      return true
    })
    await assert.rejects(api.updateDefaultSettings({ thinkingLevel: 'high' }), /Could not read default settings/)
    assert.equal(writes, 0)
    stored = original
    const good = await api.readDefaultSettings()
    failRead = true
    await assert.rejects(api.readDefaultSettings(), /Could not read default settings/)
    await assert.rejects(setDefaultThinking('high'), /Could not read default settings/)
    assert.equal(writes, 0, 'unreadable settings cannot be replaced with a default or cached value')
    failRead = false
    assert.deepEqual(await api.readDefaultSettings(), good)
    return
  }

  if (name === 'partial-write') {
    stored = JSON.stringify({ defaultProvider: 'test', defaultModel: 'a', defaultThinkingLevel: 'medium', unrelated: 'keep' })
    failAfterWrites = 1
    await assert.rejects(api.updateDefaultSettings({ model: { provider: 'test', id: 'b' }, thinkingLevel: 'max' }), /Could not save default settings/)
    assert.equal(disk().defaultModel, 'b', 'SDK setters are separate writes: IO failures can leave a partial update')
    assert.equal(disk().defaultThinkingLevel, 'medium')
    stored = JSON.stringify({ ...disk(), concurrentWriter: 'must-survive' })
    const attempts = writes
    const actual = await api.readDefaultSettings()
    assert.deepEqual(actual.stored, { model: { provider: 'test', id: 'b' }, thinkingLevel: 'medium' })
    assert.equal(actual.effective.thinkingLevel, 'medium')
    assert.equal(actual.modelThinkingLevel, null, 'a failed model preference write is not remembered')
    assert.equal(disk().concurrentWriter, 'must-survive')
    assert.equal(writes, attempts, 'failure recovery must not attempt rollback writes')
    return
  }

  if (name === 'reread-failure') {
    const before = await api.readDefaultSettings()
    failReadAfterFlush = true
    await assert.rejects(api.updateDefaultSettings({ thinkingLevel: 'high' }), /Could not reread default settings/)
    assert.equal(disk().defaultThinkingLevel, 'high', 'successful writes are not rolled back when verification fails')
    await assert.rejects(api.readDefaultSettings(), /Could not read default settings/)
    failRead = false
    const actual = await api.readDefaultSettings()
    assert.equal(actual.stored.thinkingLevel, 'high')
    assert.equal(actual.modelThinkingLevel, 'high')
    assert.notEqual(actual.revision, before.revision)
    return
  }

  throw new Error(`Unknown fixture: ${name}`)
}

if (process.argv.includes('--fixture')) {
  await fixture(process.argv.at(-1)!)
} else {
  for (const name of ['read', 'validation', 'updates', 'cas', 'queue', 'write-failure', 'read-failure', 'partial-write', 'reread-failure']) {
    test(`default model settings: ${name}`, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--fixture', name], { stdout: 'pipe', stderr: 'pipe' })
      const timeout = setTimeout(() => child.kill(), 10_000)
      try {
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
        assert.equal(code, 0, stderr || stdout)
      } finally {
        clearTimeout(timeout)
        child.kill()
      }
    })
  }
}
