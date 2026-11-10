import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { MemoryReviewError, providerFailure, reviewPhase, ReviewBackoff } from '../src/main/features/memory/long-term/review-errors'

test('review failures expose only fixed diagnostics and distinguish provider HTTP failures', async () => {
  assert.equal(providerFailure({ status: 401 }).code, 'authentication')
  assert.equal(providerFailure({ status: 403 }).code, 'authentication')
  assert.equal(providerFailure({ status: 429 }).code, 'rateLimit')
  for (const error of ['SECRET: HTTP 403', 'payload contains status code: 429', new Error('SECRET: HTTP 401'),
    { status: '401', message: 'unclassified SECRET' }, undefined]) {
    const failure = providerFailure(error)
    assert.equal(failure.code, 'request')
    assert.doesNotMatch(failure.message, /SECRET/)
  }
  await assert.rejects(reviewPhase('request', () => { throw Object.assign(new Error('SECRET'), { status: 429 }) }),
    error => error instanceof MemoryReviewError && error.code === 'rateLimit' && !error.message.includes('SECRET'))
  await assert.rejects(reviewPhase('authentication', () => { throw new Error('SECRET') }),
    error => error instanceof MemoryReviewError && error.code === 'authentication' && !error.message.includes('SECRET'))
  const validation = new MemoryReviewError('schema')
  await assert.rejects(reviewPhase('request', () => { throw validation }), error => error === validation)
})

test('provider diagnostics classify HTTP, nested transport causes and SDK strings without retaining sensitive text', () => {
  const cases: [unknown, string, number?][] = [
    ['HTTP 401 SECRET', 'authentication', 401], ['403 status code (no body) SECRET', 'authentication', 403],
    ['status code: 429 SECRET', 'rateLimit', 429], ['OpenAI API error (503): SECRET', 'httpServer', 503],
    ['400: SECRET', 'httpClient', 400], [{ status: 422 }, 'httpClient', 422],
    [{ status: 500, message: 'HTTP 429 SECRET' }, 'httpServer', 500],
    [{ statusCode: 502 }, 'httpServer', 502], [{ $metadata: { httpStatusCode: 503 } }, 'httpServer', 503],
    [{ response: { status: 504 } }, 'providerTimeout', 504], ['HTTP 408 SECRET', 'providerTimeout', 408],
    [new TypeError('fetch failed', { cause: { code: 'ENOTFOUND', message: 'SECRET-host' } }), 'dns'],
    [new AggregateError([{ code: 'ECONNREFUSED' }], 'SECRET'), 'connection'],
    [{ code: 'ECONNRESET' }, 'connectionReset'], [{ code: 'UND_ERR_SOCKET' }, 'connectionReset'],
    [{ code: 'CERT_HAS_EXPIRED' }, 'tls'], [{ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }, 'tls'],
    [{ cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } }, 'providerTimeout'],
    [{ name: 'APIConnectionTimeoutError', message: 'SECRET' }, 'providerTimeout'],
    ['getaddrinfo ENOTFOUND SECRET-host', 'dns'], ['read ECONNRESET SECRET', 'connectionReset'],
    ['CERT_HAS_EXPIRED SECRET', 'tls'], ['Connection error. SECRET', 'connection'],
    ['Request timed out. SECRET', 'providerTimeout'], ['fetch failed SECRET', 'connection'],
    ['Provider finish_reason: network_error', 'connectionReset'],
    ['SECRET unknown error', 'request'], ['{"error":"SECRET HTTP 401"}', 'request'],
    [{ status: 999, message: 'SECRET' }, 'request'],
  ]
  for (const [input, code, status] of cases) {
    const failure = providerFailure(input)
    assert.equal(failure.code, code)
    assert.equal(failure.httpStatus, status)
    assert.doesNotMatch(failure.message + JSON.stringify(failure), /SECRET/)
    assert.equal(failure.cause, undefined, 'raw causes never cross the diagnostic boundary')
  }
  const cyclic: { cause?: unknown } = {}; cyclic.cause = cyclic
  assert.equal(providerFailure(cyclic).code, 'request')
})

test('worker cooldowns are per job, exponential, capped, and reset only on success', () => {
  const backoff = new ReviewBackoff()
  assert.equal(backoff.remaining('a', 0), 0)
  assert.equal(backoff.fail('a', 0), 60_000)
  assert.equal(backoff.remaining('a', 10_000), 50_000)
  assert.equal(backoff.remaining('b', 10_000), 0)
  assert.equal(backoff.remaining('a', 60_001), 0)
  assert.equal(backoff.fail('a', 60_001), 120_000)
  for (let index = 0; index < 20; index++) backoff.fail('a', 0)
  assert.equal(backoff.fail('a', 0), 30 * 60_000)
  backoff.fail('shared', 0)
  backoff.clear('a')
  assert.equal(backoff.remaining('shared', 1), 59_999)
  assert.equal(backoff.fail('a', 0), 60_000)
})
