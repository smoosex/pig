import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { registryMcpServer, searchMcpMarket } from '../src/main/mcp/market'
import { featuredMcpServers } from '../src/main/mcp/featured'
import { fillMarketConfig, literalMcpValue } from '../src/shared/mcp-market'

test('catalog defaults and password values cannot become Pi shell/env expressions', async () => {
  const { resolveConfigValue } = await import(
    new URL('core/resolve-config-value.js', import.meta.resolve('@earendil-works/pi-coding-agent'))
      .href
  )
  for (const value of ['!must-not-execute', '$HOME', '${API_KEY}', 'normal token'])
    assert.equal(resolveConfigValue(literalMcpValue(value)), value)
  const server = registryMcpServer({
    name: 'test/literal',
    remotes: [
      {
        type: 'streamable-http',
        url: 'https://example.com/mcp',
        headers: [{ name: 'X-Static', value: '!must-not-execute' }]
      }
    ]
  })!
  assert.equal('url' in server.config && server.config.headers?.['X-Static'], '$!must-not-execute')
})

test('Registry conversion supports HTTP headers and required stdio inputs, but not legacy SSE', () => {
  const remote = registryMcpServer({
    name: 'dev.example/docs',
    icons: [
      { src: 'http://example.invalid/insecure.png' },
      { src: 'https://example.invalid/icon.png' }
    ],
    repository: { url: 'https://github.com/example/docs' },
    remotes: [
      {
        type: 'streamable-http',
        url: 'https://example.invalid/mcp',
        headers: [
          {
            name: 'Authorization',
            value: 'Bearer {token}',
            variables: { token: { isRequired: true, isSecret: true } }
          }
        ]
      }
    ]
  })!
  assert.equal(remote.icon, 'https://example.invalid/icon.png', 'only an HTTPS icon is offered')
  assert.equal(remote.config.enabled, false)
  assert.equal(remote.config.exposure, 'deferred')
  assert.throws(() => fillMarketConfig(remote, {}), /required/)
  assert.deepEqual(fillMarketConfig(remote, { Authorization: 'token' }), {
    ...remote.config,
    headers: { Authorization: 'Bearer token' }
  })
  assert.equal(
    registryMcpServer({
      name: 'dev.example/old',
      remotes: [{ type: 'sse', url: 'https://example.invalid/sse' }]
    }),
    null
  )
  const local = registryMcpServer({
    name: 'dev.example/local',
    packages: [
      {
        registryType: 'npm',
        identifier: 'example-mcp',
        transport: { type: 'stdio' },
        environmentVariables: [{ name: 'TOKEN', isRequired: true, isSecret: true }],
        packageArguments: [{ type: 'positional', isRequired: true, valueHint: 'folder' }]
      }
    ]
  })!
  const config = fillMarketConfig(local, { TOKEN: 'private', arg0: '/test folder' })
  assert.ok('command' in config)
  assert.equal(config.command, 'npx')
  assert.deepEqual(config.args, ['-y', 'example-mcp@latest', '/test folder'])
  assert.deepEqual(config.env, { TOKEN: 'private' })
  assert.ok(featuredMcpServers.every((server) => server.config.enabled === false))
  // Every listing the market shows carries an icon source, and the renderer only sees the scheme URL.
  for (const server of featuredMcpServers)
    assert.ok(server.icon?.startsWith('https://'), `${server.name} needs an icon source`)
  assert.equal(
    featuredMcpServers.some((server) => /magpie/i.test(server.name)),
    false
  )
  // Without a declared icon a GitHub listing falls back to its owner's avatar; others have none.
  const transport = [{ type: 'streamable-http', url: 'https://example.invalid/mcp' }]
  assert.equal(
    registryMcpServer({
      name: 'io.github.acme/tool',
      repository: { url: 'https://github.com/acme/tool' },
      remotes: transport
    })?.icon,
    'https://github.com/acme.png?size=96'
  )
  assert.equal(
    registryMcpServer({ name: 'io.github.other/tool', remotes: transport })?.icon,
    'https://github.com/other.png?size=96'
  )
  assert.equal(
    registryMcpServer({ name: 'dev.example/plain', remotes: transport })?.icon,
    undefined
  )
  assert.ok(
    featuredMcpServers.every(
      (server) =>
        !('command' in server.config) ||
        server.config.command !== 'npx' ||
        server.config.args?.[1].endsWith('@latest')
    )
  )
  assert.ok(
    featuredMcpServers.every(
      (server) =>
        !('command' in server.config) ||
        server.config.command !== 'uvx' ||
        server.config.args?.[0].endsWith('@latest')
    )
  )
  assert.ok(featuredMcpServers.every((server) => !/magpie.*image/i.test(server.id)))
})

test('market keeps featured offline, filters inactive Registry entries, deduplicates and reports fetch failure', async () => {
  let calls = 0
  const fetcher: NonNullable<Parameters<typeof searchMcpMarket>[1]> = async (request) => {
    calls++
    const url = new URL(String(request))
    assert.equal(url.hostname, 'registry.modelcontextprotocol.io')
    assert.equal(url.searchParams.get('version'), 'latest')
    return Response.json({
      servers: [
        {
          server: {
            name: 'dev.example/search',
            remotes: [{ type: 'streamable-http', url: 'https://mcp.exa.ai/mcp' }]
          }
        },
        {
          server: {
            name: 'dev.example/new-search',
            remotes: [{ type: 'streamable-http', url: 'https://example.invalid/search' }]
          }
        },
        {
          server: {
            name: 'dev.example/inactive',
            remotes: [{ type: 'streamable-http', url: 'https://example.invalid/inactive' }]
          },
          _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deleted' } }
        }
      ]
    })
  }
  assert.equal((await searchMcpMarket('', fetcher)).servers.length, featuredMcpServers.length)
  assert.equal(calls, 0)
  const result = await searchMcpMarket('search', fetcher)
  assert.equal(
    result.servers.filter(
      (server) => 'url' in server.config && server.config.url === 'https://mcp.exa.ai/mcp'
    ).length,
    1
  )
  assert.equal(
    result.servers.some((server) => server.id.includes('inactive')),
    false
  )
  assert.equal(
    result.servers.some((server) => server.id === 'dev.example/new-search'),
    true
  )
  await searchMcpMarket('search', fetcher)
  assert.equal(calls, 1)
  const failed = await searchMcpMarket('playwright', async () => {
    throw new Error('offline')
  })
  assert.equal(failed.error, 'offline')
  assert.ok(failed.servers.some((server) => server.name === 'playwright'))
})
