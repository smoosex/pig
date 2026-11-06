import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { runSelf } from './helpers/subprocess.ts'

async function fixture(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pig-built-in-features-'))
  const previous = process.env.PIG_DIR
  process.env.PIG_DIR = root
  const activated: string[] = []
  mock.module('../src/main/features/persona', () => ({ default: () => { activated.push('persona') } }))
  mock.module('../src/main/features/memory', () => ({ default: () => { activated.push('memory') } }))
  try {
    const legacy = JSON.stringify({ personaScopes: [], memoryScopes: [], memoryEnabled: false })
    const retired = JSON.stringify({ version: 1, persona: [], memory: [] })
    await writeFile(join(root, 'plugins.json'), legacy)
    await writeFile(join(root, 'conversation-features.json'), retired)
    const { conversationFeatureFactories } = await import('../src/main/features/runtime')
    for (const scope of ['project', 'chat']) {
      activated.length = 0
      for (const extension of conversationFeatureFactories()) {
        const factory = typeof extension === 'function' ? extension : extension.factory
        await factory({} as ExtensionAPI)
      }
      assert.deepEqual(activated, ['persona', 'memory'], `${scope} always loads both built-in features, ignoring retired switches`)
    }
    assert.equal(await readFile(join(root, 'plugins.json'), 'utf8'), legacy)
    assert.equal(await readFile(join(root, 'conversation-features.json'), 'utf8'), retired)
  } finally {
    if (previous === undefined) delete process.env.PIG_DIR
    else process.env.PIG_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv.includes('--fixture')) await fixture()
else test('persona and memory always load without reading or rewriting retired enablement settings', async () => {
  const { exitCode, stdout, stderr } = await runSelf(import.meta.path, ['--fixture'], { timeoutMs: 10_000 })
  assert.equal(exitCode, 0, stderr || stdout)
}, 12_000)
