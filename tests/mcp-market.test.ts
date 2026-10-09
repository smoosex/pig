import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { registryMcpServer, searchMcpMarket } from '../src/main/mcp/market'
import { featuredMcpServers, featuredRecipe } from '../src/main/mcp/featured'
import {
  fillMarketConfig,
  literalMcpValue,
  marketInvocation,
  mcpConfigIdentity
} from '../src/shared/mcp-market'
import { messages, translate, type MessageKey } from '../src/shared/i18n'

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

test('identity names the package a local server starts, not an option value', () => {
  const identity = (command: string, args: string[]) =>
    mcpConfigIdentity({ command, args, enabled: false })
  // The version is not part of the identity, so an update is still the same server.
  assert.equal(identity('npx', ['-y', '@playwright/mcp@latest']), 'npx:@playwright/mcp')
  assert.equal(identity('uvx', ['git-mcp@0.9']), 'uvx:git-mcp')
  // Pig writes this shape for Registry OCI entries; the env var name comes before the image.
  assert.equal(identity('docker', ['run', '-i', '--rm', '-e', 'API_KEY', 'docs']), 'docker:docs')
  assert.equal(identity('docker', ['run', '--env=API_KEY', 'docs']), 'docker:docs')
  for (const args of [
    ['run', '-i', '--rm', '-v', '/host:/data', 'docs'],
    ['run', '-i', '--rm', '-p', '8080:8080', 'docs'],
    ['run', '-i', '--rm', '--name', 'docs-container', 'docs'],
    ['run', '-i', '--rm', '-e', 'API_KEY', '--entrypoint', 'serve', 'docs']
  ])
    assert.equal(identity('docker', args), 'docker:docs', args.join(' '))
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
  // A recipe's form only asks for declared inputs, so every one needs a label, a place the value
  // goes and a homepage to check the source; a password field shows a sample instead of a value.
  for (const server of featuredMcpServers) {
    assert.ok(server.homepage?.startsWith('https://'), `${server.name} needs a homepage`)
    for (const input of server.inputs) {
      assert.ok(input.label, `${server.name} input ${input.key} needs a label`)
      if (input.secret)
        assert.ok(input.placeholder, `${server.name} input ${input.key} needs a sample`)
    }
  }
  // The sheet shows what the listing writes before it is added, placeholders included.
  const filesystem = featuredMcpServers.find((server) => server.name === 'filesystem')!
  assert.equal(
    marketInvocation(filesystem),
    'npx -y @modelcontextprotocol/server-filesystem@latest {dir}'
  )
  assert.equal(
    marketInvocation(featuredMcpServers.find((server) => server.name === 'context7')!),
    'https://mcp.context7.com/mcp'
  )
  const context7 = featuredMcpServers.find((server) => server.name === 'context7')!
  const github = featuredMcpServers.find((server) => server.name === 'github')!
  assert.equal(context7.inputs[0].format, '{}')
  assert.equal(github.inputs[0].format, 'Bearer {}')
  assert.equal(github.inputs[0].placeholder, 'github_pat_…')
  // A featured listing names its copy in the dictionary, so both languages show it; the keys are
  // only meaningful if every one resolves instead of falling back to the key itself.
  for (const server of featuredMcpServers) {
    assert.ok(server.descriptionKey, `${server.name} needs a description key`)
    for (const locale of ['zh-CN', 'en'] as const) {
      const key = server.descriptionKey as MessageKey
      assert.notEqual(
        translate(locale, key),
        key,
        `${server.name} description is missing in ${locale}`
      )
      for (const input of server.inputs) {
        for (const field of ['labelKey', 'descriptionKey'] as const) {
          const inputKey = input[field]
          assert.ok(inputKey, `${server.name} input ${input.key} needs a ${field}`)
          assert.notEqual(
            translate(locale, inputKey),
            inputKey,
            `${server.name} input ${input.key} ${field} is missing in ${locale}`
          )
        }
      }
    }
  }
  assert.equal(
    translate('zh-CN', featuredMcpServers.find((s) => s.name === 'playwright')!.descriptionKey!),
    messages['zh-CN'].mcp.featured.playwright.description
  )
  assert.equal(
    translate('zh-CN', context7.inputs[0].labelKey!),
    messages['zh-CN'].mcp.featured.context7.input.CONTEXT7_API_KEY.label
  )
  // A Registry listing carries no key, so it keeps the text its own author wrote.
  assert.equal(
    registryMcpServer({
      name: 'dev.example/plain',
      remotes: [{ type: 'streamable-http', url: 'https://example.invalid/mcp' }]
    })?.descriptionKey,
    undefined
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
  // The haystack is the words a listing shows, not its serialized fields: key paths, icon sources
  // and homepages must not decide a match. Registry entries are filtered by the API, not here.
  const offline = async (query: string) =>
    (await searchMcpMarket(query, fetcher)).servers
      .filter((server) => server.featured)
      .map((server) => server.name)
      .sort()
  assert.deepEqual(await offline('homepage'), [])
  assert.deepEqual(await offline('api key'), ['brave-search', 'context7', 'firecrawl', 'tavily'])
  const failed = await searchMcpMarket('playwright', async () => {
    throw new Error('offline')
  })
  assert.equal(failed.error, 'offline')
  assert.ok(failed.servers.some((server) => server.name === 'playwright'))
})

test('an installed server keeps the recipe copy until the user rewrites its description', () => {
  const context7 = featuredMcpServers.find((server) => server.name === 'context7')!
  // Same address and the recipe's own description: the renderer shows the dictionary text.
  assert.equal(featuredRecipe({ ...context7.config })?.name, 'context7')
  // The address is normalized, so a trailing slash still names the same recipe.
  const context7Url = 'url' in context7.config ? context7.config.url : ''
  assert.equal(featuredRecipe({ ...context7.config, url: `${context7Url}/` })?.name, 'context7')
  // A server without a description has nothing of its own to show, so the recipe's copy is used.
  assert.equal(featuredRecipe({ ...context7.config, description: undefined })?.name, 'context7')
  // An edited description is the user's own text and must not be replaced by the dictionary's.
  assert.equal(featuredRecipe({ ...context7.config, description: 'my notes' }), undefined)
  // A local recipe matches on the package without its version, which is what the catalog pins.
  const playwright = featuredMcpServers.find((server) => server.name === 'playwright')!
  assert.equal(featuredRecipe({ ...playwright.config })?.name, 'playwright')
  assert.equal(
    featuredRecipe({ command: 'npx', args: ['-y', '@playwright/mcp@0.0.1'] })?.name,
    'playwright'
  )
  // A server from the Registry has no recipe, so it keeps its own description.
  assert.equal(featuredRecipe({ url: 'https://example.invalid/mcp' }), undefined)
})
