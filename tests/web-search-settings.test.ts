import { test, mock } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebSearchSettingsPatch } from '../src/shared/api'

test('small web settings preserve credentials and legacy keys, validate writes, and fail closed on bad JSON', async () => {
  mock.module('electron', () => ({ app: { isPackaged: false } }))
  const { patchWebSearchSettings, webSearchSettingsState } = await import('../src/main/pi/web-search-settings')
  const root = await mkdtemp(join(tmpdir(), 'pig-web-settings-'))
  const previous = process.env.PIG_DIR
  const keys = ['EXA_API_KEY', 'DEEPSEEK_API_KEY', 'BRAVE_API_KEY', 'TAVILY_API_KEY']
  const previousKeys = keys.map(name => [name, process.env[name]] as const)
  for (const name of keys) delete process.env[name]
  process.env.PIG_DIR = root
  const path = join(root, 'web-search.json')
  try {
    const initial = await webSearchSettingsState()
    assert.deepEqual(initial.providers.map(provider => provider.id), ['exa', 'deepseek', 'brave', 'tavily', 'duckduckgo'])
    assert.equal(initial.settings.provider, 'duckduckgo')
    assert.deepEqual(Object.keys(initial.settings).sort(), ['addedProviders', 'maxInlineContentChars', 'provider'])
    assert.deepEqual(initial.settings.addedProviders, ['duckduckgo'])
    await writeFile(path, JSON.stringify({ searchProvider: 'openai', legacy: { untouched: true }, exaApiKey: 'existing-secret' }))
    assert.match((await webSearchSettingsState()).error!, /supported search provider/)
    const state = await patchWebSearchSettings({ provider: 'exa', addedProviders: ['exa', 'deepseek', 'brave'], providers: { deepseek: { apiKey: 'new-secret' } } })
    assert.equal(state.error, null)
    const stored = JSON.parse(await readFile(path, 'utf8'))
    assert.deepEqual(stored.legacy, { untouched: true })
    assert.equal(stored.exaApiKey, 'existing-secret')
    assert.equal(stored.deepseekApiKey, 'new-secret')
    assert.deepEqual(stored.addedProviders, ['exa', 'deepseek', 'brave'])
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    const before = await readFile(path, 'utf8')
    for (const patch of [
      { provider: 'all' }, { provider: 'openai' }, { maxInlineContentChars: 999 },
      { fetchProvider: 'deepseek' }, { addedProviders: [] }, { addedProviders: ['exa', 'exa'] }, { addedProviders: ['openai'] }, { addedProviders: ['deepseek'] },
      { providers: { duckduckgo: { apiKey: 'not-supported' } } },
      { providers: { exa: { baseUrl: 'https://user:pass@example.com' } } },
      { providers: { exa: { baseUrl: 'http://remote.example' } } },
      { ssrfAllowRanges: ['198.18.0.0/15'] }, { ssrfTrustEnvProxy: true }, { unknown: true },
    ]) {
      await assert.rejects(patchWebSearchSettings(patch as WebSearchSettingsPatch))
      assert.equal(await readFile(path, 'utf8'), before, 'invalid patches are atomic')
    }
    await Promise.all([
      patchWebSearchSettings({ provider: 'brave' }),
      patchWebSearchSettings({ providers: { tavily: { apiKey: 'tavily-secret' } } }),
    ])
    const merged = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(merged.searchProvider, 'brave')
    assert.equal(merged.tavilyApiKey, 'tavily-secret')
    const { providerConnection } = await import('../src/main/plugins/pi-web-access/config')
    process.env.EXA_API_KEY = 'fixture-environment-value'
    let provider = (await webSearchSettingsState()).providers.find(provider => provider.id === 'exa')!
    assert.equal(provider.envAvailable, true)
    assert.equal(provider.apiKeySource, 'config', 'a stored custom key remains selected for legacy configurations')
    const environment = await patchWebSearchSettings({ providers: { exa: { apiKeySource: 'env' } } })
    provider = environment.providers.find(provider => provider.id === 'exa')!
    assert.equal(provider.source, 'env')
    assert.equal(provider.apiKeySource, 'env')
    assert.equal(provider.apiKey, 'existing-secret', 'inactive custom keys are preserved for switching back')
    assert.doesNotMatch(JSON.stringify(environment), /fixture-environment-value/, 'environment values never cross IPC')
    let config = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(config.exaApiKeySource, 'env')
    assert.equal(providerConnection('exa', config).apiKey, 'fixture-environment-value')
    delete process.env.EXA_API_KEY
    assert.throws(() => providerConnection('exa', config), /API key is missing/, 'an unavailable environment key never falls back to the stored custom key')
    assert.equal((await webSearchSettingsState()).providers.find(provider => provider.id === 'exa')!.envAvailable, false)
    const unchanged = await readFile(path, 'utf8')
    await assert.rejects(patchWebSearchSettings({ providers: { exa: { apiKeySource: 'env' } } }), /not available/)
    await assert.rejects(patchWebSearchSettings({ providers: { exa: { apiKeySource: 'automatic' } } } as unknown as WebSearchSettingsPatch), /Invalid API key source/)
    assert.equal(await readFile(path, 'utf8'), unchanged)
    process.env.EXA_API_KEY = 'fixture-environment-value'
    await patchWebSearchSettings({ providers: { exa: { apiKeySource: 'config' } } })
    config = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(providerConnection('exa', config).apiKey, 'existing-secret')
    await patchWebSearchSettings({ providers: { exa: { apiKeySource: 'config', apiKey: null } } })
    config = JSON.parse(await readFile(path, 'utf8'))
    assert.throws(() => providerConnection('exa', config), /API key is missing/, 'custom mode never borrows an environment key')
    await writeFile(path, '{"exaApiKey": SECRET-SENTINEL}')
    assert.doesNotMatch((await webSearchSettingsState()).error!, /SENTINEL/)
    await assert.rejects(patchWebSearchSettings({ provider: 'duckduckgo' }), /invalid JSON/)
    assert.equal(await readFile(path, 'utf8'), '{"exaApiKey": SECRET-SENTINEL}')
  } finally {
    for (const [name, value] of previousKeys) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    if (previous === undefined) delete process.env.PIG_DIR
    else process.env.PIG_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})
