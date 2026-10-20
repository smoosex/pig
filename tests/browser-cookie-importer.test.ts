/** Cookie selection/mapping uses synthetic secrets and an in-memory Chromium store only. */
import { describe, expect, test } from 'bun:test'
import type { Cookie, CookiesSetDetails } from 'electron'
import { BrowserCookieImporter, cookieSite, matchesCookieSite, prepareCookieRecords } from '../src/main/browser/cookies/importer'
import type { SourceCookie } from '../src/main/browser/cookies/types'
import { t } from '../src/main/i18n'

const record = (patch: Partial<SourceCookie> = {}): SourceCookie => ({
  domain: '.example.com', name: 'auth', value: 'SECRET_VALUE', path: '/',
  secure: true, httpOnly: true, hostOnly: false, sameSite: 'lax', partitioned: false, ...patch
})
function fixture(rows = [record()]) {
  const writes: CookiesSetDetails[] = []
  const removes: [string, string][] = []
  const reads: boolean[] = []
  let url = 'https://app.example.com/page'
  let flushes = 0
  const source = { id: 'chrome:Default', browser: 'chrome' as const, name: 'Chrome Default' }
  const adapters = {
    list: async () => [source],
    read: async (_id: string, include: (domain: string) => boolean, decrypt: boolean) => {
      reads.push(decrypt)
      return rows.filter(row => include(row.domain)).map(row => ({ ...row, value: decrypt ? row.value : '' }))
    }
  }
  const store = {
    get: async () => rows.map(row => ({ ...row, session: row.expirationDate === undefined })) as Cookie[],
    set: async (value: CookiesSetDetails) => { writes.push(value) },
    remove: async (cookieUrl: string, name: string) => { removes.push([cookieUrl, name]) },
    flushStore: async () => { flushes++ }
  }
  const importer = new BrowserCookieImporter(store, adapters, 'darwin', () => 100)
  return { importer, store, adapters, source, writes, removes, reads, context: () => url, setUrl: (value: string) => { url = value }, flushes: () => flushes }
}

describe('browser cookie import', () => {
  test('site scope respects public/private suffixes, subdomains, local hosts and IP addresses', () => {
    expect(cookieSite('https://www.example.co.uk/path')).toBe('example.co.uk')
    expect(cookieSite('https://alice.github.io')).toBe('alice.github.io')
    expect(cookieSite('http://localhost:3000')).toBe('localhost')
    expect(cookieSite('http://127.0.0.1:3000')).toBe('127.0.0.1')
    expect(cookieSite('http://[::1]:3000')).toBe('::1')
    expect(cookieSite('')).toBeNull()
    expect(() => cookieSite('file:///etc/passwd')).toThrow()
    expect(() => cookieSite('https://user:pass@example.com')).toThrow()
    expect(matchesCookieSite('.login.example.co.uk', 'example.co.uk')).toBe(true)
    expect(matchesCookieSite('evilexample.co.uk', 'example.co.uk')).toBe(false)
    expect(matchesCookieSite('bob.github.io', 'alice.github.io')).toBe(false)
    expect(matchesCookieSite('.github.io', 'alice.github.io')).toBe(false)
    expect(cookieSite('https://github.io')).toBe('github.io')
    expect(matchesCookieSite('alice.github.io', 'github.io')).toBe(false)
    expect(matchesCookieSite('bob.github.io', 'github.io')).toBe(false)
    expect(matchesCookieSite('github.io', 'github.io')).toBe(true)
    expect(matchesCookieSite('tenant.co.uk', 'co.uk')).toBe(false)
  })

  test('preview is metadata-only, never decrypts, and excludes unrelated sites', async () => {
    const f = fixture([record(), record({ domain: 'login.example.com', hostOnly: true }), record({ domain: '.other.com' })])
    const preview = await f.importer.preview(f.context, f.source.id, 'site')
    expect(preview).toEqual({
      site: 'example.com', count: 2,
      domains: [{ domain: 'example.com', count: 1 }, { domain: 'login.example.com', count: 1 }],
      skipped: { expired: 0, partitioned: 0, unsupported: 0 }
    })
    expect(f.reads).toEqual([false])
    expect(JSON.stringify(preview)).not.toContain('SECRET_VALUE')
    expect(JSON.stringify(preview)).not.toContain('auth')
    expect(f.writes).toHaveLength(0)
  })

  test('maps host-only and domain cookies without weakening prefix, expiry or partition rules', () => {
    const prepared = prepareCookieRecords([
      record({ name: '__Host-session', domain: 'example.com', hostOnly: true, sameSite: 'strict' }),
      record({ expirationDate: 1000, sameSite: 'no_restriction' }),
      record({ partitioned: true }), record({ expirationDate: 50 }),
      record({ name: '__Host-invalid' }), record({ name: '__Secure-invalid', secure: false }),
      record({ domain: '.co.uk' }), record({ domain: '.github.io' }), record({ domain: 'bad/path.com' })
    ], 100)
    expect(prepared.cookies).toHaveLength(2)
    expect(prepared.cookies[0]).toEqual({ url: 'https://example.com/', name: '__Host-session', value: 'SECRET_VALUE', path: '/', secure: true, httpOnly: true, sameSite: 'strict' })
    expect(prepared.cookies[1]).toMatchObject({ domain: '.example.com', expirationDate: 1000, sameSite: 'no_restriction' })
    expect(prepared.skipped).toEqual({ expired: 1, partitioned: 1, unsupported: 5 })
  })

  test('all scope imports independent sites, preserves source values and flushes the target store', async () => {
    const f = fixture([record(), record({ domain: '.other.com' })])
    f.setUrl('')
    const preview = await f.importer.preview(f.context, f.source.id, 'all')
    expect(preview.site).toBeNull()
    expect(preview.count).toBe(2)
    const result = await f.importer.import(f.context, f.source.id, 'all', null)
    expect(result).toEqual({ imported: 2, failed: 0, skipped: { expired: 0, partitioned: 0, unsupported: 0 } })
    expect(f.writes.map(cookie => cookie.value)).toEqual(['SECRET_VALUE', 'SECRET_VALUE'])
    expect(f.reads).toEqual([false, true])
    expect(f.flushes()).toBe(1)
    expect(JSON.stringify(result)).not.toContain('SECRET_VALUE')
  })

  test('unknown sources, unsupported platforms and stale site confirmations fail without writes', async () => {
    const f = fixture()
    await expect(f.importer.import(f.context, 'arbitrary/path', 'site', 'example.com')).rejects.toThrow(t('browser.cookieSourceUnavailable'))
    await expect(f.importer.import(f.context, f.source.id, 'site', 'another.com')).rejects.toThrow(t('browser.cookieSiteChanged'))
    await expect(f.importer.clear(f.context, 'another.com')).rejects.toThrow(t('browser.cookieSiteChanged'))
    f.setUrl('')
    await expect(f.importer.preview(f.context, f.source.id, 'site')).rejects.toThrow(t('browser.cookieNoSite'))
    const unsupported = new BrowserCookieImporter(f.store, f.adapters, 'win32')
    expect(await unsupported.list(f.context)).toEqual({ supported: false, site: null, sources: [] })
    await expect(unsupported.import(f.context, f.source.id, 'all', null)).rejects.toThrow(t('browser.cookieUnsupported'))
    expect(f.writes).toHaveLength(0)
    expect(f.removes).toHaveLength(0)
  })

  test('late source reads cannot write after site changes or UI ownership is revoked', async () => {
    const f = fixture()
    let finish!: (value: SourceCookie[]) => void
    f.adapters.read = () => new Promise(resolve => { finish = resolve })
    const importing = f.importer.import(f.context, f.source.id, 'site', 'example.com')
    await new Promise(resolve => setTimeout(resolve, 0))
    f.setUrl('https://other.com')
    finish([record()])
    await expect(importing).rejects.toThrow(t('browser.cookieSiteChanged'))
    expect(f.writes).toHaveLength(0)
    let available = true
    const context = () => { if (!available) throw new Error('UI owner was cleared'); return 'https://example.com' }
    const late = f.importer.import(context, f.source.id, 'all', null)
    await new Promise(resolve => setTimeout(resolve, 0))
    available = false
    finish([record()])
    await expect(late).rejects.toThrow('owner was cleared')
    expect(f.writes).toHaveLength(0)
  })

  test('explicit partial results hide secret-bearing native rejection details; flush errors still reject', async () => {
    const f = fixture([record(), record({ domain: '.other.com' })])
    let calls = 0
    f.store.set = async () => { if (++calls === 1) throw new Error('native SECRET_VALUE') }
    const result = await f.importer.import(f.context, f.source.id, 'all', null)
    expect(result.imported).toBe(1)
    expect(result.failed).toBe(1)
    expect(JSON.stringify(result)).not.toContain('SECRET_VALUE')
    const failure = new Error('disk flush failed')
    f.store.flushStore = async () => { throw failure }
    await expect(f.importer.import(f.context, f.source.id, 'all', null)).rejects.toBe(failure)
  })

  test('public-suffix pages cannot import or clear independent tenant cookies as this site', async () => {
    const f = fixture([
      record({ domain: 'github.io', hostOnly: true }),
      record({ domain: 'alice.github.io', hostOnly: true }),
      record({ domain: 'bob.github.io', hostOnly: true })
    ])
    f.setUrl('https://github.io')
    const preview = await f.importer.preview(f.context, f.source.id, 'site')
    expect(preview.count).toBe(1)
    expect(preview.domains).toEqual([{ domain: 'github.io', count: 1 }])
    expect((await f.importer.import(f.context, f.source.id, 'site', 'github.io')).imported).toBe(1)
    expect(f.writes.map(cookie => cookie.url)).toEqual(['https://github.io/'])
    expect((await f.importer.clear(f.context, 'github.io')).removed).toBe(1)
    expect(f.removes).toEqual([['https://github.io/', 'auth']])
  })

  test('clear only removes this site and subdomains and returns non-secret counts', async () => {
    const f = fixture([record(), record({ domain: 'login.example.com', path: '/account' }), record({ domain: '.other.com' })])
    expect(await f.importer.clear(f.context, 'example.com')).toEqual({ removed: 2, failed: 0 })
    expect(f.removes).toEqual([['https://example.com/', 'auth'], ['https://login.example.com/account', 'auth']])
    expect(f.flushes()).toBe(1)
    f.store.remove = async () => { throw new Error('native SECRET_VALUE') }
    expect(await f.importer.clear(f.context, 'example.com')).toEqual({ removed: 0, failed: 2 })
  })

  test('shared cookie store queues mutations across browser tabs without hiding errors', async () => {
    const f = fixture()
    let finish!: () => void
    f.store.set = () => new Promise<void>(resolve => { finish = resolve })
    const first = f.importer.import(f.context, f.source.id, 'site', 'example.com')
    await new Promise(resolve => setTimeout(resolve, 0))
    const queued = f.importer.clear(f.context, 'example.com')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.removes).toHaveLength(0)
    finish()
    expect((await first).imported).toBe(1)
    expect((await queued).removed).toBe(1)
    const failing = f.importer.clear(f.context, 'another.com')
    const after = f.importer.clear(f.context, 'example.com')
    await expect(failing).rejects.toThrow(t('browser.cookieSiteChanged'))
    expect((await after).removed).toBe(1)
  })

  test('navigation during writes cannot leave unflushed, uncounted cookies', async () => {
    const f = fixture([record(), record({ domain: 'login.example.com', hostOnly: true })])
    f.store.set = async (cookie) => { f.writes.push(cookie); f.setUrl('https://other.com') }
    expect(await f.importer.import(f.context, f.source.id, 'site', 'example.com')).toMatchObject({ imported: 2, failed: 0 })
    expect(f.flushes()).toBe(1)
    f.setUrl('https://example.com')
    f.store.remove = async () => { f.setUrl('https://other.com') }
    expect(await f.importer.clear(f.context, 'example.com')).toEqual({ removed: 2, failed: 0 })
    expect(f.flushes()).toBe(2)
  })
})
