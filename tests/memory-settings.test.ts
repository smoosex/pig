/** File-memory preferences survive removal of the session-memory workers. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { MemorySettingsPatch } from '../src/shared/api'
import { runSelf } from './helpers/subprocess'

async function fixture(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pig-memory-settings-'))
  const previous = process.env.PIG_DIR
  process.env.PIG_DIR = root
  const { getMemorySettings, setMemorySettings } = await import('../src/main/features/memory-settings')
  const path = join(root, 'memory-settings.json')
  const legacy = join(root, 'plugins', 'observational-memory', 'settings.json')
  try {
    assert.deepEqual(await getMemorySettings(), {}, 'missing settings keep file memory enabled by default')
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    await rm(path)
    await mkdir(dirname(legacy), { recursive: true })
    const old = JSON.stringify({ 'observational-memory': {
      fileMemory: { enabled: false }, model: { provider: 'unused', id: 'unused' }, passive: true
    } })
    await writeFile(legacy, old)
    assert.deepEqual(await getMemorySettings(), { fileMemory: { enabled: false } })
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { fileMemory: { enabled: false } })
    assert.equal(await readFile(legacy, 'utf8'), old, 'the old file remains untouched')

    await writeFile(legacy, '{broken')
    assert.deepEqual(await getMemorySettings(), { fileMemory: { enabled: false } }, 'new settings never consult old worker config')
    await Promise.all([
      setMemorySettings({ fileMemory: { enabled: true } }),
      setMemorySettings({ fileMemory: { enabled: false } })
    ])
    assert.deepEqual(await getMemorySettings(), { fileMemory: { enabled: false } })
    assert.deepEqual(await setMemorySettings({ fileMemory: null }), {})
    assert.deepEqual(await getMemorySettings(), {}, 'reset does not resurrect old enablement')

    for (const patch of [
      { observeAfterTokens: 900 }, { model: { provider: 'x', id: 'y' } },
      { fileMemory: { enabled: true, model: {} } }, { fileMemory: { enabled: 'false' } }
    ]) await assert.rejects(setMemorySettings(patch as MemorySettingsPatch), /Unknown memory setting|Invalid/)
    const broken = '{broken'
    await writeFile(path, broken)
    await assert.rejects(getMemorySettings(), SyntaxError)
    await assert.rejects(setMemorySettings({ fileMemory: { enabled: true } }), SyntaxError)
    assert.equal(await readFile(path, 'utf8'), broken)
    await rm(path)
    await assert.rejects(getMemorySettings(), SyntaxError, 'broken previous settings must not silently re-enable file memory')
    await writeFile(legacy, old)
    assert.deepEqual(await getMemorySettings(), { fileMemory: { enabled: false } }, 'failed reads do not poison the queue')
    await rm(path)
    await mkdir(path)
    await assert.rejects(getMemorySettings(), { code: 'EISDIR' })
  } finally {
    if (previous === undefined) delete process.env.PIG_DIR
    else process.env.PIG_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv.includes('--memory-settings-fixture')) await fixture()
else test('file-memory settings preserve enablement without loading worker configuration', async () => {
  const result = await runSelf(import.meta.path, ['--memory-settings-fixture'])
  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
})
