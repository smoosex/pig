import { test, mock } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSelf } from './helpers/subprocess'

if (process.argv.includes('--dream-service-fixture')) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pig-topic-service-')))
  process.env.PIG_DIR = root
  let enabled = true, mode = 'default', scenario = 'good', calls = 0
  const listeners = new Set<() => void>()
  mock.module('../src/main/pig-dir', () => ({ pigPath: (...parts: string[]) => join(root, ...parts) }))
  mock.module('../src/main/features/memory-settings', () => ({ getMemorySettings: async () => ({ fileMemory: { enabled } }) }))
  mock.module('../src/main/permissions/store', () => ({ readPermissionSettings: () => ({ defaultMode: mode }), onPermissionsChanged: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) } }))
  mock.module('../src/main/features/memory/dream/runner', () => ({ runDreamWorker: async () => '' }))
  const { DreamService, validateDreamRequest } = await import('../src/main/features/memory/dream/service')
  const { MemoryFiles } = await import('../src/main/features/memory/long-term/files')
  const { memoryRoot } = await import('../src/main/features/memory/long-term/files')
  const service = new DreamService(async () => [], async options => {
    calls++
    assert.equal(options.topic, 'Permission lessons')
    const staged = new MemoryFiles(join(options.directory, 'staged'))
    if (scenario === 'scope') staged.save('projects/' + 'a'.repeat(64) + '/escape.md', 'Invalid', null)
    else {
      const current = staged.list().find(file => file.path === 'global/MEMORY.md')
      staged.save('global/MEMORY.md', 'Clue ' + calls, current ? staged.read(current.path).revision : null)
    }
    if (scenario === 'conflict') new MemoryFiles(memoryRoot()).save('global/concurrent.md', 'Keep concurrent edit', null)
    if (scenario === 'permission') { mode = 'read-only'; for (const listener of listeners) listener(); mode = 'default'; for (const listener of listeners) listener() }
    if (scenario === 'cancel') await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
    options.check()
    if (scenario === 'soft') {
      assert.equal(options.usage({ input: 2_000_000, cacheRead: 13_000_000, cacheWrite: 999_999, output: 1, cost: null, requests: 300 }), 'tokens')
      assert.equal(service.status().phase, 'wrappingUp')
      options.progress('maintaining', 'global')
      assert.equal(service.status().phase, 'wrappingUp', 'later tools cannot hide wrap-up status')
      options.check()
    } else if (scenario === 'token-limit') {
      options.usage({ input: 2_000_000, cacheRead: 17_000_000, cacheWrite: 999_999, output: 1, cost: null, requests: 1 })
      options.check()
    } else if (scenario === 'cost-limit') {
      options.usage({ input: 3, cacheRead: 4, cacheWrite: 5, output: 2, cost: 20, requests: 1 })
      options.check()
    } else options.usage({ input: 3, cacheRead: 0, cacheWrite: 0, output: 2, cost: null, requests: 1 })
    return 'Established a clue; other questions remain unresolved.'
  })
  const settle = async () => {
    for (let i = 0; i < 200 && service.status().state === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 5))
    return service.status()
  }
  try {
    assert.throws(() => validateDreamRequest({ topic: ' ' }), /DREAM_TOPIC/)
    assert.throws(() => validateDreamRequest({ topic: 'x', days: 1 }), /DREAM_TOPIC/)
    assert.throws(() => validateDreamRequest({ mode: 'global', days: 7 }), /DREAM_TOPIC/)
    const request = { topic: 'Permission lessons' }
    service.start(1, request)
    assert.throws(() => service.start(1, request), /BUSY/)
    let status = await settle()
    assert.equal(status.state, 'done')
    assert.deepEqual(status.changes, ['global/MEMORY.md'])
    assert.match(status.report!, /unresolved/)
    assert.equal(existsSync(join(root, 'dream', 'checkpoints.json')), false)
    assert.equal(existsSync(join(root, 'dream', status.id!, 'staged')), false)
    assert.equal(JSON.parse(readFileSync(join(root, 'dream', status.id!, 'result.json'), 'utf8')).topic, request.topic)
    service.start(1, request); assert.equal((await settle()).state, 'done')
    assert.equal(calls, 2, 'topics may be revisited without whole-history completion flags')
    for (const [value, error] of [['scope', 'DREAM_SCOPE'], ['conflict', 'DREAM_CONFLICT'], ['permission', 'DREAM_PERMISSION']]) {
      scenario = value; service.start(1, request); status = await settle(); assert.equal(status.error, error)
      assert.equal(new MemoryFiles(memoryRoot()).read('global/MEMORY.md').content, 'Clue 2')
    }
    scenario = 'cancel'; service.start(1, request)
    await new Promise(resolve => setTimeout(resolve, 10))
    await assert.rejects(service.stop(2), /another window/)
    assert.equal((await service.stop(1)).state, 'cancelled')
    scenario = 'soft'; service.start(1, request); status = await settle()
    assert.equal(status.state, 'done', '16M tokens and 300 requests can finish normally')
    assert.equal(status.wrappingUp, 'tokens')
    assert.equal(status.costKnown, false)
    assert.equal(status.cacheRead, 13_000_000)
    assert.equal(status.cacheWrite, 999_999)
    const saved = new MemoryFiles(memoryRoot()).read('global/MEMORY.md').content
    for (const [value, kind, error, used, limit] of [
      ['token-limit', 'tokens', 'DREAM_TOKEN_BUDGET', 20_000_000, 20_000_000],
      ['cost-limit', 'cost', 'DREAM_COST_BUDGET', 20, 20]
    ] as const) {
      scenario = value; service.start(1, request); status = await settle()
      assert.equal(status.state, 'limited')
      assert.equal(status.error, error)
      assert.deepEqual(status.budgetStop, { kind, used, limit })
      assert.deepEqual(status.changes, [])
      assert.equal(new MemoryFiles(memoryRoot()).read('global/MEMORY.md').content, saved, 'unfinished work is never published')
      assert.deepEqual(JSON.parse(readFileSync(join(root, 'dream', status.id!, 'result.json'), 'utf8')).budgetStop, status.budgetStop)
    }
    enabled = false; service.start(1, request); assert.equal((await settle()).error, 'DREAM_DISABLED')
  } finally { rmSync(root, { recursive: true, force: true }) }
} else test('topic Dream publishes once with backups and report, without completion checkpoints or revived cancelled work', async () => {
  const result = await runSelf(import.meta.path, ['--dream-service-fixture'])
  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
})
