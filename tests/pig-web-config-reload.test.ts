import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readConfig, selectedSearchProvider, providerConnection } from '../src/main/plugins/pig-web/config'

test('configuration follows PIG_DIR and file replacement without stale provider state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pig-web-reload-'))
  const previous = process.env.PIG_DIR
  try {
    process.env.PIG_DIR = root
    assert.equal(selectedSearchProvider(), 'duckduckgo')
    await writeFile(join(root, 'web-search.json'), JSON.stringify({ searchProvider: 'exa' }))
    assert.equal(selectedSearchProvider(), 'exa')
    await writeFile(join(root, 'web-search.json'), JSON.stringify({ searchProvider: 'brave' }))
    await utimes(join(root, 'web-search.json'), new Date(), new Date(Date.now() + 1000))
    assert.equal(selectedSearchProvider(), 'brave')
    const oldEndpoint = process.env.DEEPSEEK_WEB_BASE_URL
    process.env.DEEPSEEK_WEB_BASE_URL = 'http://127.0.0.1:9'
    try {
      assert.equal(providerConnection('deepseek', { deepseekApiKey: 'fixture', deepseekBaseUrl: 'http://127.0.0.1:9' }).baseUrl, 'https://api.deepseek.com/v1/tools')
    } finally {
      if (oldEndpoint === undefined) delete process.env.DEEPSEEK_WEB_BASE_URL
      else process.env.DEEPSEEK_WEB_BASE_URL = oldEndpoint
    }
    process.env.PIG_DIR = join(root, 'missing')
    assert.deepEqual(readConfig(), {})
    process.env.PIG_DIR = root
    assert.equal(selectedSearchProvider(), 'brave')
    await writeFile(join(root, 'web-search.json'), '{ broken SECRET')
    assert.throws(readConfig, /invalid JSON/)
  } finally {
    if (previous === undefined) delete process.env.PIG_DIR
    else process.env.PIG_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})
