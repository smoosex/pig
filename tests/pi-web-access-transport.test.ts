/** URL policy no longer resolves DNS or rejects proxy fake-IP/private address ranges. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { fetchRemoteUrl, validateRemoteUrl, WebPolicyError } from '../src/main/plugins/pi-web-access/transport'

const responseFetch = (handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) =>
  ((input: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(new URL(input instanceof Request ? input.url : input), init))) as typeof fetch

test('web transport leaves fake-IP and local address routing to the configured network stack', async () => {
  const requests: string[] = []
  const fetch = responseFetch((url, init) => {
    requests.push(url.href)
    assert.equal(init?.redirect, 'manual')
    assert.equal('dispatcher' in init!, false, 'no plugin DNS-checking dispatcher is injected')
    return new Response('page')
  })
  for (const url of ['https://198.18.3.11/page', 'http://10.0.0.1/page', 'http://localhost/page', 'https://public-domain.test/page']) {
    assert.equal(validateRemoteUrl(url).href, url)
    assert.equal(await (await fetchRemoteUrl(url, {}, { fetch })).text(), 'page')
  }
  assert.equal(requests.length, 4)
  for (const url of ['file:///etc/hosts', 'ftp://example.com/page', 'https://user:password@example.com/']) {
    assert.throws(() => validateRemoteUrl(url), WebPolicyError)
  }
  assert.throws(() => validateRemoteUrl('https://blocked.test/', { allow: [], deny: ['blocked.test'] }), /domain policy/)
})

test('web transport preserves same-origin redirects and blocks credentialed endpoint redirects', async () => {
  let hits = 0
  const fetch = responseFetch(url => {
    hits++
    return url.pathname === '/start'
      ? new Response('', { status: 302, headers: { Location: '/page' } })
      : new Response('done')
  })
  assert.equal(await (await fetchRemoteUrl('https://example.com/start', {}, { fetch })).text(), 'done')
  assert.equal(hits, 2)
  hits = 0
  await assert.rejects(fetchRemoteUrl('https://example.com/start', { headers: { Authorization: 'Bearer fixture' } }, { fetch, maxRedirects: 0 }), /Too many redirects/)
  assert.equal(hits, 1, 'provider credentials never follow a redirect')
  hits = 0
  await assert.rejects(fetchRemoteUrl('https://example.com/start', {}, { fetch: responseFetch(() => {
    hits++
    return new Response('', { status: 302, headers: { Location: 'https://other.test/' } })
  }) }), /cross-origin redirect/)
  assert.equal(hits, 1)
  hits = 0
  await assert.rejects(fetchRemoteUrl('https://example.com/loop', {}, { maxRedirects: 2, fetch: responseFetch(() => {
    hits++
    return new Response('', { status: 302, headers: { Location: '/loop' } })
  }) }), /Too many redirects/)
  assert.equal(hits, 3)
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(fetchRemoteUrl('https://example.com/page', { signal: cancelled.signal }, { fetch }))
  assert.equal(hits, 3, 'cancelled requests are never dispatched')
})
