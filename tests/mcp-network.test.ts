import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createMcpNetwork } from '../src/main/mcp/network.ts'
import { isBlockedAddress } from '../src/main/network-address.ts'
import { createMcpConnections } from '../src/main/mcp/connections.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

async function addressFixture() {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '198.18.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1'
  ])
    assert.equal(isBlockedAddress(address), true, address)
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])
    assert.equal(isBlockedAddress(address), false, address)
  let hits = 0
  const server = createServer((_req, res) => {
    hits++
    res.setHeader('Connection', 'close')
    res.end('ok')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const lookup = async () => [{ address: '127.0.0.1', family: 4 }]
  const refused = createMcpNetwork(undefined, lookup)
  const approvals: string[] = []
  let answers = 0
  const allowed = createMcpNetwork(
    async (origin, addresses) => {
      approvals.push(`${origin}|${addresses.join()}`)
      return addresses.every((address) => address === '127.0.0.1')
    },
    async () => [{ address: ++answers <= 2 ? '127.0.0.1' : '10.0.0.1', family: 4 }]
  )
  try {
    await assert.rejects(refused.fetch(`http://127.0.0.1:${port}/private`), {
      code: 'ERR_MCP_NETWORK_DENIED'
    })
    await assert.rejects(refused.fetch(`http://public.test:${port}/private`), {
      code: 'ERR_MCP_NETWORK_DENIED'
    })
    assert.equal(
      hits,
      0,
      'neither literal nor DNS-resolved private destinations may receive a request'
    )
    assert.equal(await (await allowed.fetch(`http://public.test:${port}/private`)).text(), 'ok')
    assert.equal(await (await allowed.fetch(`http://public.test:${port}/private`)).text(), 'ok')
    assert.equal(approvals.length, 1, 'approved addresses are retained only within this runtime')
    await assert.rejects(allowed.fetch(`http://public.test:${port}/private`), {
      code: 'ERR_MCP_NETWORK_DENIED'
    })
    assert.equal(hits, 2, 'a changed DNS address requires a new grant')
  } finally {
    await Promise.all([refused.close(), allowed.close()])
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
}

async function redirectFixture() {
  let hits = 0
  let authorization: string | undefined
  const target = createServer((req, res) => {
    hits++
    authorization = req.headers.authorization
    res.end('target')
  })
  const source = createServer((_req, res) => {
    res.writeHead(307, {
      location: `http://127.0.0.1:${(target.address() as AddressInfo).port}/private`
    })
    res.end()
  })
  for (const server of [source, target])
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://public.test:${(source.address() as AddressInfo).port}`
  const lookup = async () => [{ address: '127.0.0.1', family: 4 }]
  const denied = createMcpNetwork(async (url) => url === origin, lookup)
  const allowed = createMcpNetwork(async () => true, lookup)
  try {
    await assert.rejects(denied.fetch(`${origin}/redirect`), { code: 'ERR_MCP_NETWORK_DENIED' })
    assert.equal(hits, 0)
    assert.equal(
      await (
        await allowed.fetch(`${origin}/redirect`, { headers: { Authorization: 'Bearer secret' } })
      ).text(),
      'target'
    )
    assert.equal(authorization, undefined)
    await assert.rejects(allowed.fetch('file:///etc/passwd'), { code: 'ERR_MCP_NETWORK_DENIED' })
  } finally {
    await Promise.all([denied.close(), allowed.close()])
    for (const server of [source, target])
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  }
}

async function sdkFixture() {
  const root = await mkdtemp(join(tmpdir(), 'pig-mcp-network-sdk-'))
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  let hits = 0
  const server = createServer((_req, res) => {
    hits++
    res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const sdk = await import('@earendil-works/pi-coding-agent')
  const sdkRoot = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')))
  const runtime = (await import(
    pathToFileURL(join(sdkRoot, 'extensions/mcp/runtime.js')).href
  )) as typeof import('../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/runtime.js')
  const entry = {
    name: 'fixture',
    source: join(root, 'mcp.json'),
    config: {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/private`,
      headers: { Authorization: 'Bearer fixture' },
      enabled: true,
      exposure: 'deferred' as const
    }
  }
  const connections = createMcpConnections(runtime)
  const connection = new runtime.McpServerConnection({
    entry,
    cwd: root,
    createTransport: connections.createTransport,
    fetch: connections.fetch,
    credentials: new runtime.McpOAuthCredentialStore(),
    onTools() {}
  })
  let session: import('@earendil-works/pi-coding-agent').AgentSession | undefined
  try {
    await assert.rejects(connection.getClient())
    assert.equal(connection.state, 'failed')
    assert.equal(hits, 0, 'management transport must not send the initialize request')
    const settingsManager = sdk.SettingsManager.create(root, process.env.PI_CODING_AGENT_DIR)
    const loader = new sdk.DefaultResourceLoader({
      cwd: root,
      agentDir: process.env.PI_CODING_AGENT_DIR,
      settingsManager,
      noExtensions: true,
      extensionFactories: [
        sdk.createToolSearchExtension(),
        sdk.createMcpExtension({
          loadConfig: () => ({ servers: [entry], errors: [], autoEnableCodemode: false }),
          createTransport: connections.createTransport,
          fetch: connections.fetch
        })
      ]
    })
    await loader.reload()
    ;({ session } = await sdk.createAgentSession({
      cwd: root,
      settingsManager,
      resourceLoader: loader,
      sessionManager: sdk.SessionManager.inMemory(root),
      modelRuntime: await sdk.ModelRuntime.create({ refreshOnCreate: false, modelsPath: null })
    }))
    await session.bindExtensions({ mode: 'rpc' })
    const signal = new AbortController().signal
    await session.extensionRunner
      .getToolDefinition('tool_search')!
      .execute(
        'discover',
        { query: 'fixture' },
        signal,
        undefined,
        session.extensionRunner.createToolContext('discover', signal)
      )
    assert.equal(hits, 0, 'session discovery must use the same protected transport')
  } finally {
    if (session) {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
      session.dispose()
    }
    await connection.close()
    await connections.close()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
    await rm(root, { recursive: true, force: true })
  }
}
if (process.argv.includes('--fixture')) {
  await addressFixture()
  await redirectFixture()
  await sdkFixture()
} else {
  const { test } = await import('bun:test')
  test('MCP real Node sockets: DNS restrictions, local authorization, rebinding and redirect isolation', async () => {
    // Bun's undici shim ignores dispatchers; exercise the production Node connector, not that shim.
    const child = Bun.spawn(['node', '--experimental-strip-types', import.meta.path, '--fixture'], {
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const timeout = setTimeout(() => child.kill(), 10000)
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
  }, 12000)
}
