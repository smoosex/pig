import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testWebSearchProvider } from '../src/main/pi/web-search-test'

test('settings search tests use the same adapter without a model session or hidden fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pig-web-search-test-'))
  const previous = process.env.PIG_DIR, key = process.env.BRAVE_API_KEY
  process.env.PIG_DIR = root
  delete process.env.BRAVE_API_KEY
  try {
    const result = await testWebSearchProvider('brave')
    assert.equal(result.ok, false)
    assert.match(result.message, /Brave API key is missing/)
    assert.equal((await testWebSearchProvider('all')).ok, false)
  } finally {
    if (previous === undefined) delete process.env.PIG_DIR
    else process.env.PIG_DIR = previous
    if (key === undefined) delete process.env.BRAVE_API_KEY
    else process.env.BRAVE_API_KEY = key
    await rm(root, { recursive: true, force: true })
  }
})
