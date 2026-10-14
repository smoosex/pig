import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { Agent } from 'undici'
import { createValidatingLookup, fetchRemoteUrl, validateRemoteUrl } from '../src/main/plugins/pi-web-access/ssrf-protection.ts'

// validateRemoteUrl resolves the hostname before the request, but the connection resolves it again:
// a rebinding domain can answer with a public address for the check and an internal one for the
// connection. The validating lookup runs inside the connection path, so it must reject the second
// answer. Bun aliases undici's fetch to its own, which ignores dispatchers, so this exercises the
// lookup directly instead of a real socket.
test('the connection lookup rejects an address the preflight accepted', async () => {
  let resolutions = 0
  const lookup = async () => {
    resolutions++
    return resolutions === 1
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '127.0.0.1', family: 4 }]
  }
  await validateRemoteUrl('http://rebind.test/', { lookup })
  const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
    createValidatingLookup({ lookup, allowRanges: [] })('rebind.test', { all: true }, (err) => resolve(err))
  })
  assert.match(error?.message ?? '', /Blocked internal address for rebind\.test: 127\.0\.0\.1/)
  assert.equal(resolutions, 2, 'the preflight and the connection each resolved the hostname')
})

test('the connection lookup still allows explicitly allowed ranges', async () => {
  const context = {
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    allowRanges: [{ bytes: new Uint8Array([127, 0, 0, 0]), prefix: 8 }]
  }
  const addresses = await new Promise<unknown>((resolve, reject) => {
    createValidatingLookup(context)('allowed.test', { all: true }, (err, value) => (err ? reject(err) : resolve(value)))
  })
  assert.deepEqual(addresses, [{ address: '127.0.0.1', family: 4 }])
})

test('fetchRemoteUrl hands the connection to the validating dispatcher', async () => {
  const seen: Array<RequestInit & { dispatcher?: unknown }> = []
  const fakeFetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
    seen.push(init ?? {})
    return new Response('ok')
  }
  const response = await fetchRemoteUrl('http://example.test/', {}, {
    fetch: fakeFetch as unknown as typeof fetch,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }]
  })
  assert.equal(await response.text(), 'ok')
  assert.equal(seen.length, 1)
  assert.ok(seen[0]?.dispatcher instanceof Agent, 'the fetch gets the pinned-address agent')
})
