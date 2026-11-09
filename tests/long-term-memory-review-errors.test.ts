import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { MemoryReviewError, providerFailure, reviewPhase, ReviewBackoff } from '../src/main/features/memory/long-term/review-errors'

test('review failures expose only fixed diagnostics and distinguish provider HTTP failures', async () => {
  assert.equal(providerFailure({ status: 401 }).code, 'authentication')
  assert.equal(providerFailure({ status: 403 }).code, 'authentication')
  assert.equal(providerFailure({ status: 429 }).code, 'rateLimit')
  for (const error of ['HTTP 403: SECRET', 'status code: 429 SECRET', new Error('HTTP 401 SECRET'),
    { status: '401', message: 'HTTP 401 SECRET' }, { status: 500, message: 'HTTP 429 SECRET' }, undefined]) {
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
