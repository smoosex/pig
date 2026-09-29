import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The provider test drives the real bundled plugin through a throwaway session, so it needs the
// esbuild output from `bun run plugins:build`; the brave provider fails on its missing key before
// any network call, which keeps the case deterministic.
test('the provider test runs the bundled plugin without a chat session', async () => {
  if (!existsSync(join(process.cwd(), 'out/system-plugins/pi-web-access/index.js'))) return
  const root = await mkdtemp(join(tmpdir(), 'pig-web-search-test-'))
  process.env.PIG_DIR = join(root, 'pig')
  delete process.env.BRAVE_API_KEY
  const { mock } = await import('bun:test')
  mock.module('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
  const { testWebSearchProvider } = await import('../src/main/pi/web-search-test')
  const result = await testWebSearchProvider('brave')
  assert.equal(result.ok, false)
  assert.match(result.message, /Brave Search API key not found/)
  assert.match(result.message, /\*\*Provider:\*\*/, 'the message came from the real web_search tool')
})
