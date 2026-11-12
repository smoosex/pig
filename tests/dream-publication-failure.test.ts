import { test, mock } from 'bun:test'
import assert from 'node:assert/strict'
import { runSelf } from './helpers/subprocess'

if (process.argv.includes('--dream-publication-fixture')) {
  const fs = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const rename = fs.renameSync
  let inject = false
  let renames = 0
  let failAt = 2
  mock.module('node:fs', () => ({ ...fs, renameSync: (...args: Parameters<typeof rename>) => {
    if (inject && ++renames === failAt) throw Object.assign(new Error('Injected rename failure'), { code: 'EIO' })
    return rename(...args)
  } }))
  const { DreamStage } = await import('../src/main/features/memory/dream/staging')
  const { MemoryFiles } = await import('../src/main/features/memory/long-term/files')
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'pig-dream-publication-')))
  const live = new MemoryFiles(join(root, 'live'))
  try {
    live.save('global/a.md', 'Original A', null)
    live.save('global/b.md', 'Original B', null)
    const stage = new DreamStage(join(root, 'run'), live)
    for (const path of ['global/a.md', 'global/b.md']) {
      const file = stage.store.read(path)
      stage.store.save(path, 'Updated', file.revision)
    }
    inject = true
    assert.throws(() => stage.publish(new Set(['global']), () => {}), error => (error as { code?: string }).code === 'EIO')
    inject = false
    assert.equal(live.read('global/a.md').content, 'Original A')
    assert.equal(live.read('global/b.md').content, 'Original B')
    assert.equal(fs.readFileSync(join(root, 'run', 'before', 'global', 'a.md'), 'utf8'), 'Original A')
    assert.deepEqual(fs.readdirSync(join(root, 'live', 'global')).sort(), ['a.md', 'b.md'])
    for (let index = 0; index < 1997; index++) fs.mkdirSync(join(live.root, `empty-${index}`))
    const replacement = new DreamStage(join(root, 'replacement'), live)
    for (const path of ['global/a.md', 'global/b.md']) {
      const file = replacement.store.read(path)
      replacement.store.delete(path, file.revision)
    }
    replacement.store.save('global/nested/new.md', 'New clue', null)
    failAt = 1; renames = 0; inject = true
    assert.throws(() => replacement.publish(new Set(['global']), () => {}), error => (error as { code?: string }).code === 'EIO')
    inject = false
    assert.equal(live.list().length, 2, 'rollback also removes newly created directories to keep the catalog within its entry budget')
    assert.equal(fs.existsSync(join(live.root, 'global', 'nested')), false)
    assert.equal(live.read('global/a.md').content, 'Original A')
    assert.equal(live.read('global/b.md').content, 'Original B')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
} else test('a partial Dream publication restores earlier replacements and preserves recoverable backups', async () => {
  const result = await runSelf(import.meta.path, ['--dream-publication-fixture'])
  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
})
