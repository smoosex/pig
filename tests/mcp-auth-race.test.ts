import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pig-mcp-auth-race-'))
  process.env.PIG_DIR = root
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  mock.module('electron', () => ({ app: { isPackaged: false } }))
  const settings = await import('../src/main/mcp/settings')
  const { logoutMcpServer } = await import('../src/main/mcp/manager')
  const { mcpSdk, mcpCredentials, sdkFile } = await import('../src/main/mcp/sdk')
  const { createMcpConnections, mcpAuthGeneration } = await import('../src/main/mcp/connections')
  const oauth = (await import(
    pathToFileURL(sdkFile('extensions/mcp/oauth.js')).href
  )) as typeof import('../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/oauth.js')
  const { runtime } = await mcpSdk()
  const credentials = await mcpCredentials()
  try {
    for (const action of ['logout', 'remove', 'replace'] as const) {
      const name = `race_${action}`
      const url = `https://example.invalid/${action}`
      await settings.saveMcpServer(name, { url }, false)
      const store = credentials.forServer(name, url)
      await store.save({
        serverUrl: url,
        tokens: { access_token: 'old', refresh_token: 'old-refresh', token_type: 'Bearer' },
        tokensExpireAt: 0,
        clientInformation: { client_id: 'fixture' },
        discovery: {
          authorizationServerUrl: 'https://auth.invalid',
          authorizationServerMetadata: {
            issuer: 'https://auth.invalid',
            authorization_endpoint: 'https://auth.invalid/authorize',
            token_endpoint: 'https://auth.invalid/token',
            response_types_supported: ['code'],
            token_endpoint_auth_methods_supported: ['none']
          }
        }
      })
      let started!: () => void
      const starting = new Promise<void>((resolve) => {
        started = resolve
      })
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const provider = oauth.createMcpAuthProvider({
        serverUrl: url,
        store,
        settings: () => ({}),
        onChallenge() {},
        fetch: async () => {
          started()
          await gate
          return new Response(
            JSON.stringify({
              access_token: 'new',
              refresh_token: 'new-refresh',
              token_type: 'Bearer'
            }),
            { headers: { 'Content-Type': 'application/json' } }
          )
        }
      })
      let guarded!: Parameters<typeof runtime.createDefaultTransport>[2]
      let closes = 0
      const connections = createMcpConnections({
        ...runtime,
        createDefaultTransport: (_entry, _cwd, auth) => {
          guarded = auth
          return {
            close: async () => {
              closes++
            }
          } as ReturnType<typeof runtime.createDefaultTransport>
        }
      })
      const entry = (await settings.configuredServers()).find((entry) => entry.name === name)!
      connections.createTransport(entry, root, provider)
      const refresh = guarded!.token().then(
        () => null,
        (error: unknown) => error
      )
      await starting
      const generation = mcpAuthGeneration(name)
      let finished = false
      const deleting = (
        action === 'logout'
          ? logoutMcpServer(name)
          : action === 'remove'
            ? settings.removeMcpServer(name)
            : settings.saveMcpServer(name, { url: `${url}/new` }, true)
      ).then(() => {
        finished = true
      })
      while (mcpAuthGeneration(name) === generation)
        await new Promise((resolve) => setTimeout(resolve, 1))
      assert.equal(finished, false, 'deletion must wait for the SDK refresh to settle')
      assert.equal(credentials.tokens(name, url)?.access_token, 'old')
      await assert.rejects(guarded!.token(), { code: 'ERR_MCP_AUTH_REVOKED' })
      release()
      await deleting
      assert.ok(await refresh)
      assert.equal(closes, 1)
      assert.equal(credentials.tokens(name, url), undefined)
      assert.throws(
        () =>
          store.save({ serverUrl: url, tokens: { access_token: 'late', token_type: 'Bearer' } }),
        { code: 'ERR_MCP_AUTH_REVOKED' }
      )
      await connections.close()
    }
    const browserUrl = 'https://example.invalid/browser'
    const browserStore = credentials.forServer('browser', browserUrl)
    await browserStore.save({
      serverUrl: browserUrl,
      discovery: {
        authorizationServerUrl: 'https://auth.invalid',
        authorizationServerMetadata: {
          issuer: 'https://auth.invalid',
          authorization_endpoint: 'https://auth.invalid/authorize',
          token_endpoint: 'https://auth.invalid/token',
          response_types_supported: ['code'],
          token_endpoint_auth_methods_supported: ['none']
        }
      }
    })
    let prompted = false
    await assert.rejects(
      runtime.signInMcpServer({
        serverUrl: browserUrl,
        store: browserStore,
        settings: { clientId: 'fixture' },
        fetch: async () => {
          throw new Error('Cached discovery must not access the network')
        },
        prompt: {
          showAuthorizationUrl: async () => {
            throw Object.assign(new Error('Browser rejected'), { code: 'E_BROWSER_LAUNCH' })
          },
          promptForRedirectUrl: async () => {
            prompted = true
            return undefined
          }
        }
      }),
      { code: 'E_BROWSER_LAUNCH' }
    )
    assert.equal(
      prompted,
      false,
      'failed browser launch must not leave OAuth waiting for a callback'
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
if (process.argv.includes('--fixture')) await fixture()
else
  test('OAuth refresh cannot resurrect credentials after logout, server removal or URL replacement', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--fixture'], {
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const timeout = setTimeout(() => child.kill(), 10000)
    try {
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
      ])
      assert.equal(code, 0, err || out)
    } finally {
      clearTimeout(timeout)
    }
  }, 12000)
