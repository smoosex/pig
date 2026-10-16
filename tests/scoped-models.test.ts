/** Exercise Pi's real settings writer and pattern resolver in an isolated agent directory. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pig-scoped-models-'))
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  const previousCwd = process.cwd()
  try {
    await mkdir(join(root, 'agent'))
    await mkdir(join(root, '.pi'))
    process.chdir(root)
    const settingsPath = join(root, 'agent', 'settings.json')
    await writeFile(settingsPath, JSON.stringify({ enabledModels: ['test/alpha*:high'], defaultModel: 'keep' }))
    await writeFile(join(root, '.pi', 'settings.json'), JSON.stringify({ enabledModels: ['test/beta'] }))
    const sdk = await import('@earendil-works/pi-coding-agent')
    const { mock } = await import('bun:test')
    const models = [
      { id: 'alpha', name: 'Alpha', provider: 'test', contextWindow: 100, reasoning: true },
      { id: 'beta', name: 'Beta', provider: 'test', contextWindow: 100, reasoning: false }
    ]
    let availabilityReads = 0
    let availabilityError: Error | undefined
    mock.module('@earendil-works/pi-coding-agent', () => ({
      ...sdk,
      ModelRuntime: {
        create: async () => ({
          getProvider: () => ({ name: 'Test' }),
          getProviders: () => [{ id: 'test' }, { id: 'openai-codex' }, { id: 'configured' }, { id: 'local' }],
          hasConfiguredAuth: (id: string) => id === 'configured',
          getAllModels: () => models,
          getAvailableSnapshot: () => { throw new Error('Scope resolution must reuse its authenticated snapshot') },
          getAvailable: async () => {
            availabilityReads += 1
            if (availabilityError) throw availabilityError
            return models
          }
        })
      }
    }))
    const { getScopedModels, setScopedModels } = await import('../src/main/pi/scoped-models')
    const initial = await getScopedModels()
    assert.deepEqual(initial.patterns, ['test/alpha*:high'], 'personal scope is not replaced by the Pig cwd project')
    assert.deepEqual(initial.models.map((m) => m.id), ['alpha'])
    assert.deepEqual(initial.warnings, [])
    assert.deepEqual(initial.selections.map((entry) => [entry.pattern, entry.models.map((m) => m.id)]), [['test/alpha*:high', ['alpha']]])

    await setScopedModels(['test/beta', 'missing-model'])
    const saved = JSON.parse(await readFile(settingsPath, 'utf8'))
    assert.equal(saved.defaultModel, 'keep')
    assert.deepEqual(saved.enabledModels, ['test/beta', 'missing-model'])
    const scoped = await getScopedModels()
    assert.deepEqual(scoped.models.map((m) => m.id), ['beta'])
    assert.equal(scoped.warnings.length, 1)

    await setScopedModels(['gone/old-model', 'openai-codex/gpt-6-astra', 'configured/unavailable', 'test/unavailable', 'missing-model', '*/no-match'])
    const unavailable = await getScopedModels()
    assert.deepEqual(unavailable.missingProviderPatterns, ['gone/old-model', 'openai-codex/gpt-6-astra'], 'registered but unconfigured providers are eligible; configured and keyless available providers are kept')
    await setScopedModels(unavailable.patterns.filter((p) => !unavailable.missingProviderPatterns.includes(p)))
    assert.deepEqual((await getScopedModels()).patterns, ['configured/unavailable', 'test/unavailable', 'missing-model', '*/no-match'])

    await setScopedModels(['test/beta', 'test/alpha:high'])
    assert.deepEqual((await getScopedModels()).models.map((m) => m.id), ['beta', 'alpha'], 'selection order is preserved')
    await setScopedModels(['test/alpha:high', 'test/beta'])
    assert.deepEqual((await getScopedModels()).models.map((m) => m.id), ['alpha', 'beta'], 'reordering is persisted in Pi scope order')

    await setScopedModels(['test/alpha*:high', 'test/beta', 'test/alpha', 'missing-model'])
    const beforeMultiple = availabilityReads
    const multiple = await getScopedModels()
    assert.equal(availabilityReads - beforeMultiple, 1, 'multiple rules cause exactly one availability/auth scan')
    assert.deepEqual(multiple.models.map((m) => m.id), ['alpha', 'beta'], 'aggregate resolution keeps order and deduplicates')
    assert.deepEqual(multiple.selections.map((entry) => [entry.pattern, entry.models.map((m) => m.id)]), [
      ['test/alpha*:high', ['alpha']], ['test/beta', ['beta']], ['test/alpha', ['alpha']], ['missing-model', []]
    ], 'per-rule selections use the same snapshot while preserving original rules')
    assert.deepEqual(multiple.warnings, ['No models match pattern "missing-model"'])

    availabilityError = new Error('Authentication scan failed')
    const beforeFailure = availabilityReads
    await assert.rejects(getScopedModels(), (error) => error === availabilityError)
    assert.equal(availabilityReads - beforeFailure, 1, 'authentication failure propagates without retry or fallback')
    availabilityError = undefined

    await setScopedModels([])
    const beforeEmpty = availabilityReads
    assert.deepEqual((await getScopedModels()).models.map((m) => m.id), ['alpha', 'beta'])
    assert.equal(availabilityReads - beforeEmpty, 1, 'empty scope also uses one authenticated snapshot')
    await writeFile(settingsPath, JSON.stringify({ enabledModels: ['test/alpha'] }))
    assert.deepEqual((await getScopedModels()).patterns, ['test/alpha'], 'external Pi changes are re-read')
    await assert.rejects(setScopedModels([' ']))
  } finally {
    process.chdir(previousCwd)
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--scoped-models-fixture') {
  await fixture()
} else {
  test('scoped models share Pi settings and SDK pattern semantics', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--scoped-models-fixture'], { stdout: 'pipe', stderr: 'pipe' })
    const timeout = setTimeout(() => child.kill(), 15_000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      assert.equal(code, 0, stderr || stdout)
    } finally {
      clearTimeout(timeout)
    }
  })
}
