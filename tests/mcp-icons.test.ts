import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mcpIconUrl, parseMcpIconUrl } from '../src/shared/mcp-icons'

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

test('MCP icons: URL shape, address policy, redirects and disk cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pig-mcp-icons-'))
  // The icon cache resolves its directory through pig-dir, which reaches for Electron.
  mock.module('electron', () => ({ app: { isPackaged: false } }))
  const { createMcpIconCache } = await import('../src/main/mcp/icons')
  const ranges: string[] = []
  const answers = new Map([['public.test', ['93.184.216.34']]])
  const requests: string[] = []
  const responses = new Map<string, () => Response>()
  const cache = createMcpIconCache({
    directory: join(root, 'icons'),
    // No negative memory here: the test changes the policy mid-run and expects it to apply.
    negativeTtlMs: 0,
    allowedRanges: () => ranges,
    resolve: async (host) => answers.get(host) ?? [],
    request: async (input) => {
      const url = new URL(String(input))
      requests.push(url.href)
      const respond = responses.get(url.href)
      if (!respond) return new Response(null, { status: 404 })
      return respond()
    }
  })
  const image = () => new Response(png, { headers: { 'content-type': 'image/png' } })
  const redirect = (location: string) => new Response(null, { status: 302, headers: { location } })
  try {
    assert.equal(
      parseMcpIconUrl(mcpIconUrl('https://public.test/a.png')),
      'https://public.test/a.png'
    )
    assert.equal(parseMcpIconUrl('https://public.test/a.png'), null)
    assert.equal(parseMcpIconUrl('pig-mcp-icon://other/?u=https://public.test/a.png'), null)
    assert.equal(parseMcpIconUrl('pig-mcp-icon://icon/'), null)
    // Malformed, non-HTTPS, credential-bearing and internal sources never reach the network.
    for (const source of [
      'not a url',
      'http://public.test/a.png',
      'file:///etc/passwd',
      'https://user:pw@public.test/a.png',
      'https://127.0.0.1/a.png',
      'https://10.0.0.5/a.png',
      'https://198.18.0.9/a.png',
      'https://internal.test/a.png'
    ])
      assert.equal(await cache.icon(source), null, source)
    answers.set('internal.test', ['192.168.1.10'])
    assert.equal(await cache.icon('https://internal.test/a.png'), null)
    assert.deepEqual(requests, [], 'a blocked source must not be requested')
    // A TUN proxy hands out fake IPs for every name, so a resolved answer there is proxy-owned
    // space; naming that range outright stays blocked.
    answers.set('proxied.test', ['198.18.1.81'])
    responses.set('https://proxied.test/a.png', image)
    assert.deepEqual((await cache.icon('https://proxied.test/a.png'))?.body, png)
    assert.equal(await cache.icon('https://198.18.1.81/a.png'), null)
    // A range the user declares is their explicit decision, so it covers literal addresses too.
    ranges.push('10.0.0.0/8')
    responses.set('https://10.0.0.5/a.png', image)
    assert.deepEqual((await cache.icon('https://10.0.0.5/a.png'))?.body, png)
    assert.equal(await cache.icon('https://10.1.0.5/a.png'), null)
    // Fetch, cache and deduplicate: the same source is requested once and served from memory after.
    responses.set('https://public.test/a.png', image)
    assert.deepEqual((await cache.icon('https://public.test/a.png'))?.body, png)
    assert.deepEqual((await cache.icon('https://public.test/a.png'))?.body, png)
    assert.deepEqual(
      requests.filter((url) => url === 'https://public.test/a.png'),
      ['https://public.test/a.png']
    )
    // Every redirect hop is resolved and checked against the same policy.
    responses.set('https://public.test/redirect.png', () => redirect('https://proxied.test/a.png'))
    assert.deepEqual((await cache.icon('https://public.test/redirect.png'))?.body, png)
    responses.set('https://public.test/bad.png', () =>
      redirect('https://internal.test/private.png')
    )
    assert.equal(await cache.icon('https://public.test/bad.png'), null)
    responses.set('https://public.test/loop.png', () => redirect('https://public.test/loop.png'))
    assert.equal(await cache.icon('https://public.test/loop.png'), null)
    // A non-image or oversized body is not an icon.
    responses.set(
      'https://public.test/html.png',
      () => new Response('<html>', { headers: { 'content-type': 'text/html' } })
    )
    assert.equal(await cache.icon('https://public.test/html.png'), null)
    responses.set(
      'https://public.test/big.png',
      () =>
        new Response(png, {
          headers: { 'content-type': 'image/png', 'content-length': String(2 << 20) }
        })
    )
    assert.equal(await cache.icon('https://public.test/big.png'), null)
    responses.set('https://public.test/error.png', () => {
      throw new Error('network down')
    })
    assert.equal(
      await cache.icon('https://public.test/error.png'),
      null,
      'a fetch failure is a missing icon'
    )
    // Only successfully fetched icons are stored on disk, and a new cache instance reads them
    // without a request.
    assert.deepEqual(
      (await readdir(join(root, 'icons'))).filter((file) => !file.endsWith('.type')).length,
      4
    )
    const reread = createMcpIconCache({
      directory: join(root, 'icons'),
      resolve: async () => [],
      allowedRanges: () => [],
      request: async () => {
        throw new Error('must not fetch')
      }
    })
    assert.deepEqual((await reread.icon('https://public.test/a.png'))?.body, png)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
