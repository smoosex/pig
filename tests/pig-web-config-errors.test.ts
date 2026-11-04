/** Run with Node: V8, unlike Bun, includes offending file text in JSON parse errors. */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runChild } from './helpers/subprocess.ts'

if (process.argv.includes('--web-parse-fixture')) {
  const root = await mkdtemp(join(tmpdir(), 'pig-web-parse-'))
  process.env.PIG_DIR = root
  try {
    const { readConfig } = await import('../src/main/plugins/pig-web/config.ts')
    const { loadFetchContentDomainPolicy } = await import('../src/main/plugins/pig-web/transport.ts')
    const { loadConfiguredProxy } = await import('../src/main/plugins/pig-web/utils.ts')
    await writeFile(join(root, 'web-search.json'), '{"exaApiKey": sk-SECRET-SENTINEL}')
    for (const read of [readConfig, loadFetchContentDomainPolicy, loadConfiguredProxy]) {
      assert.throws(read, (error: Error) => /invalid JSON/.test(error.message) && !error.message.includes('SECRET'))
    }
  } finally { await rm(root, { recursive: true, force: true }) }
} else {
  const { test } = await import('bun:test')
  test('configuration errors never disclose credential source text under V8', async () => {
    const result = await runChild(['node', '--experimental-strip-types', import.meta.path, '--web-parse-fixture'])
    assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  })
}
