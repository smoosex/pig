import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function fixture(): Promise<{ dir: string; settings: typeof import('../src/main/pi/web-search-settings') }> {
  const root = await mkdtemp(join(tmpdir(), 'pig-web-search-'))
  process.env.PIG_DIR = join(root, 'pig')
  const { mock } = await import('bun:test')
  mock.module('electron', () => ({ app: { isPackaged: false, getAppPath: () => root } }))
  const settings = await import('../src/main/pi/web-search-settings')
  return { dir: join(root, 'pig'), settings }
}

test('provider table covers every engine with a stable id', async () => {
  const { settings } = await fixture()
  const ids = settings.WEB_SEARCH_PROVIDERS.map((provider) => provider.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(ids.includes('duckduckgo') && ids.includes('gemini') && ids.includes('xcrawl'))
  for (const provider of settings.WEB_SEARCH_PROVIDERS) {
    if (provider.kind !== 'key') continue
    assert.ok(provider.apiKeyKey, `${provider.id} needs a config key`)
    if (provider.baseUrlKey !== undefined) assert.ok(provider.baseUrlKey.endsWith('BaseUrl'))
  }
})

test('settings default to unset provider, all engines, and every tool on', async () => {
  const { settings } = await fixture()
  const state = await settings.webSearchSettingsState()
  assert.equal(state.settings.provider, null)
  assert.equal(state.settings.allowedProviders, null)
  assert.equal(state.settings.maxInlineContentChars, null)
  assert.deepEqual(state.settings.tools, { webSearch: true, sourceCheck: true, fetchContent: true, getSearchContent: true })
  const brave = state.providers.find((provider) => provider.id === 'brave')!
  assert.equal(brave.source, null)
  assert.equal(brave.apiKey, '')
})

test('patches write web-search.json, preserve unknown keys, and keep the file private', async () => {
  const { dir, settings } = await fixture()
  const path = join(dir, 'web-search.json')
  await mkdir(dir, { recursive: true })
  await writeFile(path, JSON.stringify({ provider: 'exa', futureKey: { keep: true } }))
  const next = await settings.patchWebSearchSettings({
    provider: 'brave',
    allowedProviders: ['brave', 'duckduckgo'],
    maxInlineContentChars: 12_000,
    fetchDefaultMode: 'raw',
    fetchAllowedModes: ['readable', 'raw'],
    ssrfAllowRanges: ['198.18.0.0/15'],
    ssrfTrustEnvProxy: true,
    tools: { sourceCheck: false },
    providers: {
      brave: { apiKey: 'brave-key', baseUrl: 'https://brave.example' },
      gemini: { extras: { 'browserCookies.browser': 'chrome', 'browserCookies.profile': 'Default' } }
    }
  })
  assert.equal(next.settings.provider, 'brave')
  assert.deepEqual(next.settings.allowedProviders, ['brave', 'duckduckgo'])
  assert.equal(next.settings.fetchDefaultMode, 'raw')
  assert.deepEqual(next.settings.tools, { webSearch: true, sourceCheck: false, fetchContent: true, getSearchContent: true })
  const stored = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(stored.provider, undefined)
  assert.equal(stored.searchProvider, 'brave')
  assert.deepEqual(stored.futureKey, { keep: true })
  assert.equal(stored.braveApiKey, 'brave-key')
  assert.equal(stored.braveBaseUrl, 'https://brave.example')
  assert.deepEqual(stored.browserCookies, { browser: 'chrome', profile: 'Default' })
  assert.equal(stored.tools.sourceCheck.enabled, false)
  assert.deepEqual(stored.ssrf, { allowRanges: ['198.18.0.0/15'], trustEnvProxy: true })
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  const reread = await settings.webSearchSettingsState()
  assert.equal(reread.providers.find((provider) => provider.id === 'brave')!.source, 'config')
  assert.equal(reread.providers.find((provider) => provider.id === 'gemini')!.extraValues['browserCookies.profile'], 'Default')
})

test('null clears values and environment variables count as configured', async () => {
  const { dir, settings } = await fixture()
  process.env.TAVILY_API_KEY = 'from-env'
  try {
    await settings.patchWebSearchSettings({
      provider: 'tavily',
      allowedProviders: ['tavily'],
      maxInlineContentChars: 5_000,
      providers: { tavily: { apiKey: 'explicit' } }
    })
    const state = await settings.webSearchSettingsState()
    const tavily = state.providers.find((provider) => provider.id === 'tavily')!
    assert.equal(tavily.source, 'config')
    const cleared = await settings.patchWebSearchSettings({ providers: { tavily: { apiKey: null } }, maxInlineContentChars: null, allowedProviders: null })
    assert.equal(cleared.providers.find((provider) => provider.id === 'tavily')!.source, 'env')
    assert.equal(cleared.settings.maxInlineContentChars, null)
    assert.equal(cleared.settings.allowedProviders, null)
    const stored = JSON.parse(await readFile(join(dir, 'web-search.json'), 'utf8'))
    assert.equal(stored.tavilyApiKey, undefined)
    assert.equal(stored.maxInlineContentChars, undefined)
  } finally {
    delete process.env.TAVILY_API_KEY
  }
})

test('invalid patches are rejected before writing', async () => {
  const { settings } = await fixture()
  await assert.rejects(settings.patchWebSearchSettings({ provider: 'not-a-provider' }), /Unknown web search provider/)
  await assert.rejects(settings.patchWebSearchSettings({ maxInlineContentChars: 10 }), /maxInlineContentChars/)
  await assert.rejects(settings.patchWebSearchSettings({ fetchDefaultMode: 'sideways' }), /fetch mode/)
  await assert.rejects(settings.patchWebSearchSettings({ allowedProviders: ['nope'] }), /Unknown web search provider/)
  await assert.rejects(settings.patchWebSearchSettings({ tools: { nope: false } as never }), /Unknown web search tool/)
  await assert.rejects(settings.patchWebSearchSettings({ providers: { duckduckgo: { apiKey: 'x' } } }), /does not take an API key/)
  await assert.rejects(settings.patchWebSearchSettings({ providers: { brave: { extras: { nope: 'x' } } } }), /no setting named/)
  await assert.rejects(
    settings.patchWebSearchSettings({ provider: 'tavily', allowedProviders: ['brave'] }),
    /Default provider tavily is not in webSearch.allowedProviders/
  )
  await assert.rejects(settings.patchWebSearchSettings({ ssrfTrustEnvProxy: 'true' as never }), /ssrf.trustEnvProxy must be a boolean/)
  await assert.rejects(settings.patchWebSearchSettings({ allowedProviders: 'brave' as never }), /webSearch.allowedProviders must be an array/)
  await assert.rejects(settings.patchWebSearchSettings({ fetchAllowedModes: 'readable' as never }), /fetch.allowedModes must be an array/)
  await assert.rejects(settings.patchWebSearchSettings({ ssrfAllowRanges: '198.18.0.0/15' as never }), /ssrf.allowRanges must be an array/)
  await assert.rejects(settings.patchWebSearchSettings({ tools: 'webSearch' as never }), /tools must be an object/)
  await assert.rejects(settings.patchWebSearchSettings({ providers: 'brave' as never }), /providers must be an object/)
  await assert.rejects(settings.patchWebSearchSettings({ providers: { brave: 'x' } as never }), /brave settings must be an object/)
  await assert.rejects(settings.patchWebSearchSettings({ allowedProviders: ['brave', 7] as never }), /must contain only provider ids/)
  await assert.rejects(settings.patchWebSearchSettings({ provider: 123 as never }), /provider must be a string or null/)
  await assert.rejects(settings.patchWebSearchSettings({ tools: { webSearch: 'yes' } as never }), /tools.webSearch.enabled must be a boolean/)
  await assert.rejects(settings.patchWebSearchSettings({ ssrfAllowRanges: ['198.18.0.0/33'] }), /Invalid CIDR notation/)
  await assert.rejects(settings.patchWebSearchSettings({ ssrfAllowRanges: ['not-an-address'] }), /Invalid CIDR notation/)
  await assert.rejects(settings.patchWebSearchSettings({ ssrfAllowRanges: ['198.18.0.0/'] }), /Invalid CIDR notation/)
  await assert.rejects(settings.patchWebSearchSettings({ ssrfAllowRanges: ['198.18.0.0/0'] }), /Invalid CIDR notation/)
})

test('provider ids are matched case-insensitively like the extension', async () => {
  const { settings } = await fixture()
  const state = await settings.patchWebSearchSettings({ provider: 'Brave', allowedProviders: ['Brave', 'DuckDuckGo'] })
  assert.equal(state.settings.provider, 'brave')
  assert.deepEqual(state.settings.allowedProviders, ['brave', 'duckduckgo'])
})

test('a config the extension would reject reports the problem and stays editable', async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ webSearch: { allowedProviders: [] } }, /webSearch.allowedProviders must be a non-empty array/],
    [{ webSearch: { allowedProviders: ['brave', 'brave'] } }, /must not contain duplicates/],
    [{ webSearch: { allowedProviders: ['nope'] } }, /Unknown web search provider/],
    [{ webSearch: { allowedProviders: ['datalab'] } }, /content extractor, not a search provider/],
    [{ fetch: { allowedModes: ['readable', 'sideways'] } }, /Unsupported fetch mode: sideways/],
    [{ fetch: { allowedModes: [] } }, /fetch.allowedModes must be a non-empty array/],
    [{ fetch: { allowedModes: ['raw'] } }, /fetch.defaultMode must be one of fetch.allowedModes/],
    [{ fetch: { allowedModes: ['raw'], defaultMode: 'readable' } }, /fetch.defaultMode must be one of fetch.allowedModes/],
    [{ ssrf: { trustEnvProxy: 'yes' } }, /ssrf.trustEnvProxy must be a boolean/],
    [{ ssrf: { allowRanges: ['nope'] } }, /Invalid CIDR notation/]
  ]
  for (const [config, expected] of cases) {
    const { dir, settings } = await fixture()
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'web-search.json'), JSON.stringify(config))
    const state = await settings.webSearchSettingsState()
    assert.match(state.error ?? '', expected, JSON.stringify(config))
    // The unreadable field reads as unset and everything else still loads, so the panel can repair it.
    assert.deepEqual(state.settings.tools, { webSearch: true, sourceCheck: true, fetchContent: true, getSearchContent: true })
  }
})

test('a healthy config reports no error', async () => {
  const { settings } = await fixture()
  const state = await settings.webSearchSettingsState()
  assert.equal(state.error, null)
})

test('an invalid file is reported and the next save rewrites it', async () => {
  const { dir, settings } = await fixture()
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'web-search.json'), '{ not json')
  const broken = await settings.webSearchSettingsState()
  assert.match(broken.error ?? '', /Invalid .*web-search\.json/)
  assert.equal(broken.settings.allowedProviders, null)
  const repaired = await settings.patchWebSearchSettings({ allowedProviders: ['brave'], tools: { webSearch: false } })
  assert.equal(repaired.error, null)
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'web-search.json'), 'utf8')), {
    webSearch: { allowedProviders: ['brave'] },
    tools: { webSearch: { enabled: false } }
  })
})

test('a broken field does not block saving an unrelated one', async () => {
  const { dir, settings } = await fixture()
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'web-search.json'), JSON.stringify({ webSearch: { allowedProviders: ['nope'] }, braveApiKey: 'keep' }))
  await settings.patchWebSearchSettings({ tools: { webSearch: false } })
  const stored = JSON.parse(await readFile(join(dir, 'web-search.json'), 'utf8'))
  assert.deepEqual(stored.webSearch.allowedProviders, ['nope'], 'the untouched field is left alone')
  assert.equal(stored.braveApiKey, 'keep')
  // And the panel can repair the field it does own.
  const repaired = await settings.patchWebSearchSettings({ allowedProviders: ['brave'] })
  assert.equal(repaired.error, null)
  assert.deepEqual(repaired.settings.allowedProviders, ['brave'])
})

test('an unreadable config is reported but never overwritten by an unrelated save', async () => {
  const { dir, settings } = await fixture()
  const { chmod } = await import('node:fs/promises')
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'web-search.json')
  await writeFile(path, JSON.stringify({ braveApiKey: 'keep', futureKey: { keep: true } }))
  await chmod(path, 0o000)
  try {
    const state = await settings.webSearchSettingsState()
    assert.match(state.error ?? '', /Cannot read .*web-search\.json/)
    await assert.rejects(settings.patchWebSearchSettings({ tools: { webSearch: false } }), /Cannot read .*web-search\.json/)
  } finally {
    await chmod(path, 0o600)
  }
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { braveApiKey: 'keep', futureKey: { keep: true } })
})

test('an unset default outside fetch.allowedModes reads back as a mode the panel can save', async () => {
  const { dir, settings } = await fixture()
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'web-search.json'), JSON.stringify({ fetch: { allowedModes: ['raw'] } }))
  const broken = await settings.webSearchSettingsState()
  assert.match(broken.error ?? '', /fetch.defaultMode must be one of fetch.allowedModes/)
  assert.deepEqual(broken.settings.fetchAllowedModes, ['raw'])
  assert.equal(broken.settings.fetchDefaultMode, 'raw', 'the fallback has to be a mode the file accepts')
  const repaired = await settings.patchWebSearchSettings({ fetchDefaultMode: broken.settings.fetchDefaultMode, fetchAllowedModes: ['raw'] })
  assert.equal(repaired.error, null)
  assert.equal(repaired.settings.fetchDefaultMode, 'raw')
})

test('an invalid default that readable would repair reads back as unset', async () => {
  const { dir, settings } = await fixture()
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'web-search.json'), JSON.stringify({ fetch: { allowedModes: ['readable', 'raw'], defaultMode: 'sideways' } }))
  const broken = await settings.webSearchSettingsState()
  assert.match(broken.error ?? '', /Unsupported fetch mode: sideways/)
  assert.equal(broken.settings.fetchDefaultMode, null, 'deleting the invalid default falls back to readable')
  const repaired = await settings.patchWebSearchSettings({ fetchDefaultMode: null, fetchAllowedModes: ['readable', 'raw'] })
  assert.equal(repaired.error, null)
})

test('extract providers are not search providers but still take credentials', async () => {
  const { settings } = await fixture()
  await assert.rejects(settings.patchWebSearchSettings({ allowedProviders: ['datalab'] }), /content extractor, not a search provider/)
  await assert.rejects(settings.patchWebSearchSettings({ provider: 'crawl4ai' }), /content extractor, not a search provider/)
  assert.throws(() => settings.assertProviderSelection('datalab'), /content extractor, not a search provider/)
  const state = await settings.patchWebSearchSettings({
    allowedProviders: ['brave'],
    providers: { datalab: { apiKey: 'datalab-key', extras: { datalabMode: 'fast' } } }
  })
  const datalab = state.providers.find((provider) => provider.id === 'datalab')!
  assert.equal(datalab.apiKey, 'datalab-key')
  assert.equal(datalab.extraValues.datalabMode, 'fast')
})

test('a patch that would leave an unusable config is not written', async () => {
  const { dir, settings } = await fixture()
  await mkdir(dir, { recursive: true })
  await assert.rejects(
    settings.patchWebSearchSettings({ fetchAllowedModes: ['raw'] }),
    /fetch.defaultMode must be one of fetch.allowedModes/
  )
  await assert.rejects(readFile(join(dir, 'web-search.json'), 'utf8'), /ENOENT/)
})

test('the legacy webSearch.enabled flag is honoured and retired on save', async () => {
  const { dir, settings } = await fixture()
  const { mkdir: makeDir } = await import('node:fs/promises')
  await makeDir(dir, { recursive: true })
  await writeFile(join(dir, 'web-search.json'), JSON.stringify({ webSearch: { enabled: false } }))
  const before = await settings.webSearchSettingsState()
  assert.deepEqual(before.settings.tools, { webSearch: false, sourceCheck: false, fetchContent: true, getSearchContent: true })
  const after = await settings.patchWebSearchSettings({ tools: { webSearch: true } })
  assert.deepEqual(after.settings.tools, { webSearch: true, sourceCheck: false, fetchContent: true, getSearchContent: true })
  const stored = JSON.parse(await readFile(join(dir, 'web-search.json'), 'utf8'))
  assert.equal(stored.webSearch.enabled, undefined, 'the override replaces the legacy flag')
  assert.deepEqual(stored.tools, { webSearch: { enabled: true }, sourceCheck: { enabled: false } })
})

test('only known providers and auto/all reach the test runner', async () => {
  const { settings } = await fixture()
  settings.assertProviderSelection('brave')
  settings.assertProviderSelection('auto')
  settings.assertProviderSelection('all')
  assert.throws(() => settings.assertProviderSelection('not-a-provider'), /Unknown web search provider/)
})

test('concurrent saves do not lose each other\'s updates', async () => {
  const { settings } = await fixture()
  await Promise.all([
    settings.patchWebSearchSettings({ provider: 'brave' }),
    settings.patchWebSearchSettings({ maxInlineContentChars: 40_000 }),
    settings.patchWebSearchSettings({ providers: { tavily: { apiKey: 'tavily-key' } } })
  ])
  const state = await settings.webSearchSettingsState()
  assert.equal(state.settings.provider, 'brave')
  assert.equal(state.settings.maxInlineContentChars, 40_000)
  assert.equal(state.providers.find((provider) => provider.id === 'tavily')!.apiKey, 'tavily-key')
})

test('the default provider may route inside an allowlist', async () => {
  const { settings } = await fixture()
  const state = await settings.patchWebSearchSettings({ provider: 'auto', allowedProviders: ['brave'] })
  assert.equal(state.settings.provider, 'auto')
  assert.deepEqual(state.settings.allowedProviders, ['brave'])
})

test('SSRF ranges and base URLs are validated and reported as configured', async () => {
  const { settings } = await fixture()
  const state = await settings.patchWebSearchSettings({
    ssrfAllowRanges: ['198.18.0.0/15', 'fd00::/8', '1.2.3.4'],
    providers: { searxng: { baseUrl: 'https://search.example.com' } }
  })
  assert.deepEqual(state.settings.ssrfAllowRanges, ['198.18.0.0/15', 'fd00::/8', '1.2.3.4'])
  const searxng = state.providers.find((provider) => provider.id === 'searxng')!
  assert.equal(searxng.kind, 'none')
  assert.equal(searxng.baseUrl, 'https://search.example.com')
  assert.equal(searxng.source, 'config', 'a base URL alone counts as configured')
  assert.equal(state.providers.find((provider) => provider.id === 'duckduckgo')!.source, null)
})
