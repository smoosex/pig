/** Real Node sockets exercise provider adapters, page fallback, and configured proxy transport. */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { fetchRemoteUrl } from '../src/main/plugins/pig-web/transport.ts'
import { runWithProxy } from '../src/main/plugins/pig-web/utils.ts'
import { runChild } from './helpers/subprocess.ts'

async function adaptersFixture() {
  const requests: { url: string; key: unknown; body: Record<string, unknown> }[] = []
  let mode = 'ok'
  let redirectHits = 0
  let abortRemote: (() => void) | undefined
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    const key = req.headers.authorization ?? req.headers['x-api-key'] ?? req.headers['x-subscription-token']
    requests.push({ url: req.url!, key, body })
    res.setHeader('Connection', 'close')
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/leak') { redirectHits++; res.end('{}'); return }
    if (req.url === '/page') {
      if (mode === 'both-error') { res.writeHead(500).end('unavailable'); return }
      res.setHeader('Content-Type', 'text/html'); res.end('<html><body><h1>Local page</h1></body></html>'); return
    }
    if (mode === 'socket-error') { req.socket.destroy(); return }
    if (abortRemote) { abortRemote(); res.end('{}'); return }
    if (mode === 'both-error') { res.writeHead(502).end('unavailable'); return }
    if (mode === 'forbidden') { res.writeHead(403).end('sk-SECRET'); return }
    if (mode === 'redirect') { res.writeHead(307, { location: '/leak' }).end(); return }
    if (mode === 'http-error') { res.writeHead(401).end('sk-SECRET'); return }
    if (mode === 'invalid-json') { res.end('sk-SECRET not JSON'); return }
    if (req.url === '/moved') { res.writeHead(302, { location: '/nested/page' }).end(); return }
    if (req.url === '/nested/page') { res.setHeader('Content-Type', 'text/html'); res.end('<html><body><a href="child">Link</a></body></html>'); return }
    if (req.url === '/oversized') { res.end('x'.repeat(2 * 1024 * 1024 + 1)); return }
    if (req.url === '/empty') { res.setHeader('Content-Type', 'text/plain'); res.end(''); return }
    if (req.url === '/binary') { res.setHeader('Content-Type', 'application/pdf'); res.end('%PDF'); return }
    if (mode === 'malformed') { res.end('{}'); return }
    if (req.url === '/deepseek/fetch') { res.end(JSON.stringify({ content: '# deepseek remote' })); return }
    if (req.url === '/exa/contents') { res.end(JSON.stringify({ results: [{ text: '# exa remote' }] })); return }
    if (req.url === '/tavily/extract') { res.end(JSON.stringify({ results: [{ raw_content: '# tavily remote' }] })); return }
    const item = { title: 'Example', url: 'https://example.com', highlights: ['Exa excerpt'], description: 'Brave excerpt', content: 'Tavily excerpt', snippet: 'DeepSeek snippet', summary: 'DeepSeek summary', date: null }
    res.end(JSON.stringify(req.url!.startsWith('/brave/') ? { web: { results: [item] } } : { results: [item] }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  // Official endpoints stay fixed in production. Only this subprocess substitutes loopback fixtures.
  const { mock } = await import('node:test')
  const actual = await import('../src/main/plugins/pig-web/config.ts')
  mock.module(new URL('../src/main/plugins/pig-web/config.ts', import.meta.url).href, {
    namedExports: { ...actual, providerConnection: (id: Parameters<typeof actual.providerConnection>[0], config: Record<string, unknown>) =>
      ({ ...actual.providerConnection(id, config), baseUrl: base + '/' + id }) }
  })
  const { searchWeb } = await import('../src/main/plugins/pig-web/search.ts')
  const { fetchPage } = await import('../src/main/plugins/pig-web/fetch.ts')
  const configPath = join(process.env.PIG_DIR!, 'web-search.json')
  const config: Record<string, unknown> = { ssrf: 'obsolete settings must not affect web requests' }
  for (const id of ['exa', 'deepseek', 'brave', 'tavily']) { config[id + 'ApiKey'] = 'sk-SECRET'; config[id + 'BaseUrl'] = base + '/' + id }
  try {
    await writeFile(configPath, JSON.stringify(config))
    for (const provider of ['exa', 'deepseek', 'brave', 'tavily'] as const) {
      const result = await searchWeb(['query'], 3, undefined, provider)
      assert.equal(result.sources.length, 1)
      assert.equal(result.provider, provider)
      assert.equal(result.sources[0]!.snippet, { exa: 'Exa excerpt', deepseek: 'DeepSeek summary', brave: 'Brave excerpt', tavily: 'Tavily excerpt' }[provider])
      assert.ok(requests.at(-1)!.key)
    }
    assert.deepEqual(requests[0]!.body, { query: 'query', numResults: 3, contents: { highlights: true } })
    assert.deepEqual(requests[1]!.body, { query: 'query', count: 3, need_content: false })
    assert.match(requests[2]!.url, /\/brave\/search\?q=query&count=3/)
    assert.equal(requests[3]!.body.include_answer, false)
    const count = requests.length
    await assert.rejects(searchWeb(['a'.repeat(129)], 3, undefined, 'deepseek'), /128/)
    const cancelled = new AbortController(); cancelled.abort()
    await assert.rejects(searchWeb(['query'], 3, cancelled.signal, 'exa'))
    assert.equal(requests.length, count, 'invalid/cancelled calls never dispatch')

    for (const failure of ['http-error', 'invalid-json', 'malformed', 'redirect']) {
      mode = failure
      for (const provider of ['exa', 'deepseek', 'brave', 'tavily'] as const) {
        await assert.rejects(searchWeb(['query'], 3, undefined, provider), (error: Error) => !error.message.includes('sk-SECRET'))
      }
    }
    assert.equal(redirectHits, 0, 'credentialed adapters never follow redirects')
    mode = 'ok'
    assert.match((await fetchPage(base + '/page')).content, /Local page/)
    const moved = await fetchPage(base + '/moved')
    assert.equal(moved.url, base + '/nested/page')
    assert.match(moved.content, /\/nested\/child/)
    await assert.rejects(fetchPage(base + '/oversized'), /2 MiB/)
    await assert.rejects(fetchPage(base + '/binary'), /Unsupported content type/)
    await assert.rejects(fetchPage(base + '/empty'), /no usable text/)
    for (const provider of ['deepseek', 'exa', 'tavily'] as const) {
      config.searchProvider = provider
      config.fetchProvider = 'http' // Obsolete override must not control the new routing.
      await writeFile(configPath, JSON.stringify(config))
      let start = requests.length
      const remote = await fetchPage(base + '/page')
      assert.equal(remote.content, '# ' + provider + ' remote')
      assert.deepEqual(remote.retrieval, { provider })
      assert.equal(requests.length - start, 1, 'successful remote fetch never duplicates a local request')
      assert.deepEqual(requests.at(-1)!.body, provider === 'deepseek' ? { url: base + '/page' } : provider === 'exa' ? { ids: [base + '/page'], text: true } : { urls: [base + '/page'], format: 'markdown' })
      for (const failure of ['http-error', 'invalid-json', 'malformed', 'socket-error']) {
        mode = failure
        start = requests.length
        const fallback = await fetchPage(base + '/page')
        assert.match(fallback.content, /Local page/)
        assert.equal(fallback.retrieval?.provider, 'http')
        assert.equal(fallback.retrieval?.fallbackFrom, provider)
        assert.ok(fallback.retrieval?.reason)
        assert.equal(requests.length - start, 2)
        assert.equal(requests.at(-1)!.key, undefined, 'provider credentials never reach the target page')
        assert.doesNotMatch(fallback.retrieval!.reason!, /sk-SECRET/)
      }
      for (const failure of ['forbidden', 'redirect']) {
        mode = failure
        start = requests.length
        await assert.rejects(fetchPage(base + '/page'))
        assert.equal(requests.length - start, 1, 'security refusals never fall back')
      }
      mode = 'both-error'
      await assert.rejects(fetchPage(base + '/page'), /HTTP 502.*Local HTTP fallback failed:.*HTTP 500/)
      mode = 'ok'
    }
    for (const provider of ['brave', 'duckduckgo']) {
      config.searchProvider = provider
      await writeFile(configPath, JSON.stringify(config))
      const start = requests.length
      assert.deepEqual((await fetchPage(base + '/page')).retrieval, { provider: 'http' })
      assert.equal(requests.length - start, 1, 'providers without fetch go directly to local HTTP')
      assert.equal(requests.at(-1)!.key, undefined)
    }
    config.searchProvider = 'deepseek'
    let start = requests.length
    config.fetchContent = { domainPolicy: { deny: ['127.0.0.1'] } }
    await writeFile(configPath, JSON.stringify(config))
    await assert.rejects(fetchPage(base + '/page'), /domain policy/)
    assert.equal(requests.length, start)
    delete config.fetchContent
    await writeFile(configPath, JSON.stringify(config))
    const controller = new AbortController()
    abortRemote = () => controller.abort()
    await assert.rejects(fetchPage(base + '/page', controller.signal))
    abortRemote = undefined
    assert.equal(requests.length - start, 1, 'cancellation during the remote request never triggers local HTTP')
    const preCancelled = new AbortController(); preCancelled.abort()
    start = requests.length
    await assert.rejects(fetchPage(base + '/page', preCancelled.signal))
    assert.equal(requests.length, start)
    const merged = await searchWeb(['first', 'second'], 3, undefined, 'exa')
    assert.equal(merged.sources.length, 1, 'multi-query results deduplicate by URL')
    delete config.exaApiKey
    await writeFile(configPath, JSON.stringify(config))
    await assert.rejects(searchWeb(['query'], 3, undefined, 'exa'), /API key is missing/)
    config.searchProvider = 'exa'
    await writeFile(configPath, JSON.stringify(config))
    start = requests.length
    await assert.rejects(fetchPage(base + '/page'), /API key is missing/)
    assert.equal(requests.length, start, 'configuration failures never silently fall back')
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

async function proxyFixture() {
  let received = ''
  const proxy = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    received = Buffer.concat(chunks).toString()
    assert.equal(req.url, 'http://provider.test/search')
    assert.equal(req.headers.authorization, 'Bearer fixture-token')
    res.setHeader('Connection', 'close')
    res.end('proxied')
  })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const proxyUrl = 'http://127.0.0.1:' + (proxy.address() as AddressInfo).port
  await writeFile(join(process.env.PIG_DIR!, 'web-search.json'), JSON.stringify({ proxy: proxyUrl }))
  try {
    const response = await runWithProxy(undefined, () => fetchRemoteUrl('http://provider.test/search', {
      method: 'POST', headers: { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' },
      body: '{"query":"hello"}', signal: AbortSignal.timeout(3000),
    }))
    assert.equal(await response.text(), 'proxied')
    assert.equal(received, '{"query":"hello"}')
  } finally {
    await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()))
  }
}

async function proxyFailureFixture() {
  const proxy = createServer((req, res) => {
    const path = new URL(req.url!).pathname
    res.setHeader('Connection', 'close')
    res.setHeader('Content-Type', 'text/plain')
    if (path === '/partial') {
      res.setHeader('Content-Length', '1024')
      res.end('partial')
    } else if (path === '/chunked' || path === '/known-size') {
      if (path === '/known-size') res.setHeader('Content-Length', String(3 * 1024 * 1024))
      const body = Readable.from(Array(12).fill(Buffer.alloc(256 * 1024, 'x')))
      res.once('close', () => body.destroy())
      body.pipe(res)
    } else {
      res.end('complete page')
    }
  })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const proxyUrl = 'http://127.0.0.1:' + (proxy.address() as AddressInfo).port
  await writeFile(join(process.env.PIG_DIR!, 'web-search.json'), JSON.stringify({ proxy: proxyUrl }))
  try {
    const { fetchPage } = await import('../src/main/plugins/pig-web/fetch.ts')
    assert.equal((await fetchPage('http://provider.test/ok')).content, 'complete page')
    for (const [path, exitCode] of [['/chunked', 63], ['/known-size', 63], ['/partial', 18]] as const) {
      await assert.rejects(runWithProxy(undefined, () => fetchRemoteUrl('http://provider.test' + path, {
        signal: AbortSignal.timeout(3000),
      })), (error: Error & { exitCode?: number }) => error.exitCode === exitCode, `${path}: curl failures with write-out metadata must reject`)
      await assert.rejects(fetchPage('http://provider.test' + path), 'partial content must not become a successful page')
    }
    assert.equal((await fetchPage('http://provider.test/ok')).content, 'complete page', 'a failed download does not break later requests')
  } finally {
    await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()))
  }
}

const fixtures = {
  failures: proxyFailureFixture,
  adapters: adaptersFixture,
  proxy: proxyFixture,
}
if (process.argv.includes('--web-network-fixture')) {
  const root = await mkdtemp(join(tmpdir(), 'pig-web-network-'))
  process.env.PIG_DIR = root
  for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy', 'EXA_API_KEY', 'BRAVE_API_KEY', 'TAVILY_API_KEY', 'DEEPSEEK_API_KEY', 'EXA_BASE_URL', 'BRAVE_BASE_URL', 'TAVILY_BASE_URL', 'DEEPSEEK_WEB_BASE_URL']) delete process.env[key]
  try { await fixtures[process.argv.at(-1) as keyof typeof fixtures]() }
  finally { await rm(root, { recursive: true, force: true }) }
} else {
  const { test } = await import('bun:test')
  for (const key of Object.keys(fixtures)) test('web transport: ' + key, async () => {
    const result = await runChild(['node', '--experimental-strip-types', '--experimental-test-module-mocks', import.meta.path, '--web-network-fixture', key], { timeoutMs: 20_000 })
    assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  }, 22_000)
}
