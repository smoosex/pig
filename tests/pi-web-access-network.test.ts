/** Real Node connectors: Bun's undici shim ignores dispatchers and cannot exercise DNS rebinding. */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchRemoteUrl } from '../src/main/plugins/pi-web-access/ssrf-protection.ts'
import { runWithProxy } from '../src/main/plugins/pi-web-access/utils.ts'

async function rebindingFixture() {
  let hits = 0
  const server = createServer((_req, res) => {
    hits++
    res.setHeader('Connection', 'close')
    res.end('private')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  process.env.HTTP_PROXY = 'http://127.0.0.1:9'
  try {
    for (const mode of ['scoped-direct', 'option-direct', 'request-direct', 'environment-only']) {
      let resolutions = 0
      const lookup = async () => [{
        address: ++resolutions === 1 && mode !== 'environment-only' ? '93.184.216.34' : '127.0.0.1', family: 4
      }]
      const request = () => fetchRemoteUrl(
        `http://rebind-${mode}.test:${port}/private`,
        { ...(mode === 'request-direct' ? { __proxy: '' } : {}), signal: AbortSignal.timeout(2000) },
        { lookup, trustEnvProxy: true, ...(mode === 'option-direct' ? { proxy: '' } : {}) }
      )
      await assert.rejects(
        mode === 'scoped-direct' ? runWithProxy('', request) : request(),
        (error: Error & { cause?: Error }) => /Blocked internal address/.test(error.cause?.message ?? error.message),
        mode
      )
      assert.equal(resolutions, mode === 'environment-only' ? 1 : 2, `${mode}: connection-time lookup must reject the private address`)
    }
    assert.equal(hits, 0, 'trusting an environment proxy must never exempt an actual direct connection')
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

async function multipartFixture() {
  const pdf = new TextEncoder().encode('%PDF-1.4 fixture').buffer
  let received: { url?: string; method?: string; contentType?: string; body: Buffer } | undefined
  const proxy = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    received = { url: req.url, method: req.method, contentType: req.headers['content-type'], body: Buffer.concat(chunks) }
    res.setHeader('Connection', 'close')
    res.end(JSON.stringify({ markdown: '# Parsed through proxy', pages: 1 }))
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  process.env.PDF_ENDPOINT_URL = 'http://parser.test/parse'
  const { extractPDFViaEndpoint } = await import('../src/main/plugins/pi-web-access/endpoint-pdf-extract.ts')
  try {
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }]
    const pinned = await fetchRemoteUrl('http://parser.test/status', {}, { proxy: proxyUrl, lookup })
    assert.match(await pinned.text(), /Parsed through proxy/, 'a pinned proxy must use proxy transport even without a scope')

    const result = await runWithProxy(proxyUrl, () =>
      extractPDFViaEndpoint(pdf, { maxPages: 7, timeoutMs: 3000, lookup })
    )
    assert.equal(result.markdown, '# Parsed through proxy')
    assert.ok(received)
    assert.equal(received.url, 'http://parser.test/parse')
    assert.equal(received.method, 'POST')
    assert.match(received.contentType ?? '', /^multipart\/form-data; boundary=/)
    const form = await new Request('http://parser.test/parse', {
      method: 'POST', headers: { 'Content-Type': received.contentType! }, body: new Uint8Array(received.body)
    }).formData()
    assert.equal(form.get('max_pages'), '7')
    const file = form.get('file') as File
    assert.equal(file.name, 'document.pdf')
    assert.equal(file.type, 'application/pdf')
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array(pdf))

    await writeFile(join(process.env.PIG_DIR!, 'web-search.json'), JSON.stringify({
      proxy: proxyUrl, ssrf: { trustEnvProxy: true }
    }))
    const configured = await runWithProxy(undefined, () => extractPDFViaEndpoint(pdf, {
      maxPages: 1, lookup: async () => { throw new Error('the configured proxy must resolve this hostname') }
    }))
    assert.equal(configured.markdown, '# Parsed through proxy')

    const blockedLookup = async () => [{ address: '127.0.0.1', family: 4 }]
    await assert.rejects(runWithProxy('http://127.0.0.1:9', () =>
      extractPDFViaEndpoint(pdf, { maxPages: 1, lookup: blockedLookup })
    ), /Blocked internal address/, 'a different per-call proxy never inherits configured-proxy trust')
    process.env.NO_PROXY = 'parser.test'
    await assert.rejects(runWithProxy(undefined, () =>
      extractPDFViaEndpoint(pdf, { maxPages: 1, lookup: blockedLookup })
    ), /Blocked internal address/, 'NO_PROXY targets retain local DNS validation')
  } finally {
    await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()))
  }
}

async function loopbackFixture() {
  let redirect = '/canonical'
  const requested: string[] = []
  const server = createServer((req, res) => {
    requested.push(req.url!)
    res.setHeader('Connection', 'close')
    if (req.url === '/parse') res.writeHead(307, { location: redirect }).end()
    else res.end(JSON.stringify({ markdown: '# Local parser' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '::1', resolve))
  const port = (server.address() as AddressInfo).port
  process.env.PDF_ENDPOINT_URL = `http://localhost:${port}/parse`
  const { extractPDFViaEndpoint } = await import('../src/main/plugins/pi-web-access/endpoint-pdf-extract.ts')
  const pdf = new TextEncoder().encode('%PDF fixture').buffer
  const loopbackLookup = async () => [{ address: '::1', family: 6 }]
  try {
    const result = await extractPDFViaEndpoint(pdf, { maxPages: 1, lookup: loopbackLookup })
    assert.equal(result.markdown, '# Local parser')
    assert.deepEqual(requested, ['/parse', '/canonical'])

    requested.length = 0
    redirect = `http://localhost:${port + 1}/private`
    await assert.rejects(extractPDFViaEndpoint(pdf, { maxPages: 1, lookup: loopbackLookup }), /Blocked internal hostname/)
    assert.deepEqual(requested, ['/parse'], 'a different loopback origin must not inherit the exemption')

    requested.length = 0
    redirect = `http://redirected.test:${port}/private`
    let remoteLookups = 0
    await assert.rejects(extractPDFViaEndpoint(pdf, {
      maxPages: 1,
      lookup: async (hostname) => hostname === 'localhost' ? loopbackLookup() : [{
        address: ++remoteLookups === 1 ? '93.184.216.34' : '::1', family: remoteLookups === 1 ? 4 : 6
      }]
    }), (error: Error & { cause?: Error }) => /Blocked internal address/.test(error.cause?.message ?? error.message))
    assert.deepEqual(requested, ['/parse'], 'a public redirect must still reject connection-time rebinding')
    assert.equal(remoteLookups, 2)

    requested.length = 0
    await assert.rejects(extractPDFViaEndpoint(pdf, {
      maxPages: 1, lookup: async () => [{ address: '10.0.0.1', family: 4 }]
    }), (error: Error & { cause?: Error }) => /Blocked internal address/.test(error.cause?.message ?? error.message))
    assert.deepEqual(requested, [], 'localhost may resolve only to loopback, not arbitrary internal addresses')
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

async function endpointSelectionFixture() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  const text = 'BT /F1 12 Tf 72 720 Td (Local fallback text) Tj ET'
  objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`)
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const [i, object] of objects.entries()) {
    offsets.push(body.length)
    body += `${i + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = body.length
  body += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  body += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const pdf = new TextEncoder().encode(body).buffer
  let requests = 0
  const server = createServer((req, res) => {
    requests++
    req.resume()
    res.setHeader('Connection', 'close')
    res.writeHead(503).end('parser offline')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  process.env.PDF_ENDPOINT_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/parse`
  const configPath = join(process.env.PIG_DIR!, 'web-search.json')
  const outputDir = join(process.env.PIG_DIR!, 'output')
  await writeFile(configPath, JSON.stringify({ pdf: { provider: 'endpoint' } }))
  const { extractPDFToMarkdown } = await import('../src/main/plugins/pi-web-access/pdf-extract.ts')
  try {
    await assert.rejects(extractPDFToMarkdown(pdf, 'https://example.test/paper.pdf', { outputDir }), /HTTP 503: parser offline/)
    await writeFile(configPath, JSON.stringify({ pdf: { provider: 'auto' } }))
    const result = await extractPDFToMarkdown(pdf, 'https://example.test/paper.pdf', { outputDir })
    assert.match(result.content, /Local fallback text/)
    assert.equal(requests, 2, 'auto may fall back, but a pinned endpoint must fail')
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

async function endpointResultsFixture() {
  const { default: timers } = await import('node:timers/promises')
  const { syncBuiltinESMExports } = await import('node:module')
  const sleep = timers.setTimeout
  let polls = 0
  // These cases validate task payloads over real HTTP, not the polling interval.
  timers.setTimeout = ((delay, value, options) => {
    if (delay === 1000) { polls++; return sleep(0, value, options) }
    return sleep(delay, value, options)
  }) as typeof sleep
  syncBuiltinESMExports()
  let taskResult: unknown
  const server = createServer((req, res) => {
    req.resume()
    res.setHeader('Connection', 'close')
    res.end(JSON.stringify(req.url === '/parse' ? { job_id: 'job' } : { status: 'done', result: taskResult }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  process.env.PDF_ENDPOINT_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/parse`
  const { extractPDFViaEndpoint } = await import('../src/main/plugins/pi-web-access/endpoint-pdf-extract.ts')
  const extract = () => extractPDFViaEndpoint(new ArrayBuffer(0), { maxPages: 1, timeoutMs: 3000 })
  try {
    for (const encoded of [false, true]) {
      taskResult = { markdown: '\x00# Parsed\x00', pages: 2 }
      if (encoded) taskResult = JSON.stringify(taskResult)
      assert.deepEqual(await extract(), { markdown: '# Parsed', pages: 2 })
    }
    for (const invalid of ['', '\x00\x00', '{"markdown":', '# raw markdown']) {
      taskResult = invalid
      await assert.rejects(extract(), /PDF parser endpoint returned invalid JSON/)
    }
    for (const markdown of ['', '\x00\x00']) {
      taskResult = JSON.stringify({ markdown })
      await assert.rejects(extract(), /returned no markdown/)
    }
    assert.equal(polls, 8, 'every result still goes through the task polling request')
  } finally {
    timers.setTimeout = sleep
    syncBuiltinESMExports()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

const fixtures = {
  rebinding: { run: rebindingFixture, name: 'direct sockets reject DNS rebinding even with trusted environment proxies' },
  multipart: { run: multipartFixture, name: 'endpoint PDF uploads preserve multipart data through a proxy' },
  loopback: { run: loopbackFixture, name: 'localhost PDF endpoints allow same-origin hops without leaking loopback exemptions' },
  selection: { run: endpointSelectionFixture, name: 'pinned PDF endpoint errors propagate while auto retains its local fallback' },
  results: { run: endpointResultsFixture, name: 'PDF task results require valid JSON and nonempty Markdown in every representation' }
}

if (process.argv.includes('--web-network-fixture')) {
  const root = await mkdtemp(join(tmpdir(), 'pig-web-network-'))
  process.env.PIG_DIR = root
  for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
    'DATALAB_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'CLOUDFLARE_API_KEY']) {
    delete process.env[key]
  }
  try {
    await fixtures[process.argv.at(-1) as keyof typeof fixtures].run()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
} else {
  const { test } = await import('bun:test')
  for (const [key, fixture] of Object.entries(fixtures)) {
    test(`web access: ${fixture.name}`, async () => {
      const child = Bun.spawn(['node', '--experimental-strip-types', import.meta.path, '--web-network-fixture', key], {
        stdout: 'pipe', stderr: 'pipe'
      })
      const timeout = setTimeout(() => child.kill(), 20000)
      try {
        const [code, output, errors] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text()
        ])
        assert.equal(code, 0, errors || output)
      } finally {
        clearTimeout(timeout)
      }
    }, 22000)
  }
}
