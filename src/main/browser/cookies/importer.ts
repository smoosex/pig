/** Copies user-selected cookies into the shared preview partition. Secrets never enter IPC results. */
import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'
import { getDomain, getPublicSuffix } from 'tldts'
import type { Cookies, CookiesSetDetails } from 'electron'
import type {
  BrowserCookieScope, BrowserCookieSkips, BrowserCookiePreview, BrowserCookieImportResult,
  BrowserCookieClearResult, BrowserCookieSources
} from '../../../shared/browser'
import type { SourceCookie } from './types'
import { listCookieSources, readCookieSource } from './readers'
import { t } from '../../i18n'

type CookieStore = Pick<Cookies, 'get' | 'set' | 'remove' | 'flushStore'>
type Context = () => string
interface Readers {
  list: typeof listCookieSources
  read: typeof readCookieSource
}
const readers: Readers = { list: listCookieSources, read: readCookieSource }

function cookieHost(domain: string): string | null {
  const bare = domain.replace(/^\./, '').replace(/^\[([^\]]+)\]$/, '$1').toLowerCase()
  if (isIP(bare)) return bare
  if (/[\\/?#@:%\s\x00-\x1f\x7f]/.test(bare)) return null
  const ascii = domainToASCII(bare)
  if (!ascii || ascii.endsWith('.') || ascii.length > 253 || !ascii.split('.').every(label => /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/.test(label))) return null
  return ascii
}

export function cookieSite(url: string): string | null {
  if (!url) return null
  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(t('browser.cookieHttpOnly'))
  const host = cookieHost(parsed.hostname)
  if (!host) throw new Error(t('browser.cookieHttpOnly'))
  return getDomain(host, { allowPrivateDomains: true }) ?? host
}

export function matchesCookieSite(domain: string, site: string): boolean {
  const host = cookieHost(domain)
  // Public/private suffix hosts have no registrable site: never widen github.io to its tenants.
  return host !== null && (getDomain(host, { allowPrivateDomains: true }) ?? host) === site
}

function cookieUrl(host: string, secure: boolean, path: string): string {
  return `${secure ? 'https' : 'http'}://${isIP(host) === 6 ? `[${host}]` : host}${path}`
}

export function prepareCookieRecords(records: SourceCookie[], now: number) {
  const skipped: BrowserCookieSkips = { expired: 0, partitioned: 0, unsupported: 0 }
  const cookies: CookiesSetDetails[] = []
  const domains = new Map<string, number>()
  for (const record of records) {
    if (record.partitioned) { skipped.partitioned++; continue }
    if (record.expirationDate !== undefined && record.expirationDate <= now) { skipped.expired++; continue }
    const host = cookieHost(record.domain)
    if (!host || (!record.hostOnly && !isIP(host) && getPublicSuffix(host, { allowPrivateDomains: true }) === host) ||
      (!record.hostOnly && (!!isIP(host) || host === 'localhost')) || !record.path.startsWith('/') ||
      (record.expirationDate !== undefined && !Number.isFinite(record.expirationDate)) ||
      /[\x00-\x20\x7f()<>@,;:\\"/\[\]?={}]/.test(record.name) || /[\x00\r\n]/.test(record.value) ||
      (record.name.startsWith('__Secure-') && !record.secure) ||
      (record.name.startsWith('__Host-') && (!record.secure || !record.hostOnly || record.path !== '/'))) {
      skipped.unsupported++
      continue
    }
    cookies.push({
      url: cookieUrl(host, record.secure, record.path), name: record.name, value: record.value,
      ...(record.hostOnly ? {} : { domain: `.${host}` }), path: record.path,
      secure: record.secure, httpOnly: record.httpOnly, sameSite: record.sameSite,
      ...(record.expirationDate === undefined ? {} : { expirationDate: record.expirationDate })
    })
    domains.set(host, (domains.get(host) ?? 0) + 1)
  }
  return { cookies, skipped, domains: [...domains].sort(([a], [b]) => a.localeCompare(b)).map(([domain, count]) => ({ domain, count })) }
}

function assertScope(scope: unknown): asserts scope is BrowserCookieScope {
  if (scope !== 'site' && scope !== 'all') throw new Error('Invalid cookie import scope')
}

export class BrowserCookieImporter {
  // Every browser tab shares one cookie partition, so imports and clears queue behind each other.
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    private readonly store: CookieStore,
    private readonly sources: Readers = readers,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly now: () => number = () => Date.now() / 1000
  ) {}

  async list(context: Context): Promise<BrowserCookieSources> {
    context()
    const sources = this.platform === 'darwin' ? await this.sources.list() : []
    return { supported: this.platform === 'darwin', site: cookieSite(context()), sources }
  }

  private async read(context: Context, sourceId: string, scope: BrowserCookieScope, decrypt: boolean, expectedSite?: string | null) {
    assertScope(scope)
    if (this.platform !== 'darwin') throw new Error(t('browser.cookieUnsupported'))
    if (typeof sourceId !== 'string' || sourceId.length > 256) throw new Error('Invalid cookie source')
    const site = cookieSite(context())
    if (scope === 'site' && !site) throw new Error(t('browser.cookieNoSite'))
    const guard = () => {
      const current = cookieSite(context())
      if (scope === 'site' && (current !== site || (expectedSite !== undefined && current !== expectedSite))) {
        throw new Error(t('browser.cookieSiteChanged'))
      }
    }
    guard()
    if (!(await this.sources.list()).some(source => source.id === sourceId)) throw new Error(t('browser.cookieSourceUnavailable'))
    guard()
    const include = scope === 'site' ? (domain: string) => matchesCookieSite(domain, site!) : () => true
    const records = await this.sources.read(sourceId, include, decrypt)
    guard()
    // Recheck the scope even if a source adapter accidentally returns unrelated cookies.
    return { ...prepareCookieRecords(records.filter(record => include(record.domain)), this.now()), site, guard }
  }

  async preview(context: Context, sourceId: string, scope: BrowserCookieScope): Promise<BrowserCookiePreview> {
    const prepared = await this.read(context, sourceId, scope, false)
    return { site: prepared.site, count: prepared.cookies.length, domains: prepared.domains, skipped: prepared.skipped }
  }

  async import(context: Context, sourceId: string, scope: BrowserCookieScope, expectedSite: string | null): Promise<BrowserCookieImportResult> {
    return this.mutate(async () => {
      if (expectedSite !== null && typeof expectedSite !== 'string') throw new Error('Invalid expected cookie site')
      const prepared = await this.read(context, sourceId, scope, true, expectedSite)
      let imported = 0
      let failed = 0
      // The site was confirmed after the read; from here the write runs to completion so a navigation
      // cannot leave unflushed, uncounted cookies behind. The preview already scoped these records.
      for (const cookie of prepared.cookies) {
        // Individual Chromium policy rejections are a partial-result boundary. Never expose the
        // native error: it may contain a cookie value. IO flush failures still reject the operation.
        try { await this.store.set(cookie); imported++ }
        catch { failed++ }
      }
      await this.store.flushStore()
      return { imported, failed, skipped: prepared.skipped }
    })
  }

  async clear(context: Context, expectedSite: string): Promise<BrowserCookieClearResult> {
    return this.mutate(async () => {
      const site = cookieSite(context())
      if (!site || site !== expectedSite) throw new Error(t('browser.cookieSiteChanged'))
      const cookies = await this.store.get({})
      if (cookieSite(context()) !== site) throw new Error(t('browser.cookieSiteChanged'))
      // Same as import: once removal starts it runs to the flush and reports its counts.
      let removed = 0
      let failed = 0
      for (const cookie of cookies) {
        if (!cookie.domain || !matchesCookieSite(cookie.domain, site)) continue
        const host = cookieHost(cookie.domain)!
        try {
          await this.store.remove(cookieUrl(host, cookie.secure === true, cookie.path || '/'), cookie.name)
          removed++
        } catch { failed++ } // Same explicit per-cookie result boundary as import; no secret-bearing native errors in IPC.
      }
      await this.store.flushStore()
      return { removed, failed }
    })
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation)
    this.queue = run.catch(() => {}) // Keeps the chain alive; the caller still receives `run`'s rejection.
    return run
  }
}
