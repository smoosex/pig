import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { parseDomainFilter, passesDomainFilters } from '../src/main/plugins/pi-web-access/domain-filter-normalization.ts'

test('shared provider domain filters normalize and deduplicate domains, with exclusions taking precedence', () => {
  const filters = parseDomainFilter([
    'https://Example.com/path', 'example.com', '- blocked.example.com', '-https://blocked.example.com/page', '', '-'
  ])
  assert.deepEqual(filters, { include: ['example.com'], exclude: ['blocked.example.com'] })
  assert.equal(passesDomainFilters(new URL('https://example.com/'), filters), true)
  assert.equal(passesDomainFilters(new URL('https://docs.example.com/'), filters), true)
  assert.equal(passesDomainFilters(new URL('https://blocked.example.com/'), filters), false)
  assert.equal(passesDomainFilters(new URL('https://sub.blocked.example.com/'), filters), false)
  assert.equal(passesDomainFilters(new URL('https://notexample.com/'), filters), false)
  const exclusionOnly = parseDomainFilter(['-example.com'])
  assert.equal(passesDomainFilters(new URL('https://elsewhere.test/'), exclusionOnly), true)
  assert.equal(passesDomainFilters(new URL('https://example.com/'), exclusionOnly), false)
  assert.equal(passesDomainFilters(new URL('https://example.com/'), parseDomainFilter(undefined)), true)
})
