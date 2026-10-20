/** macOS Chrome discovery and read-only cookie snapshots. Secrets stay inside each read call.
 * Safari is deliberately not advertised: its binary/partition formats are not supported here.
 */
import { execFile } from 'node:child_process'
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { BrowserCookieSource } from '../../../shared/browser'
import type { SourceCookie } from './types'
import { t } from '../../i18n'

interface ReaderOptions {
  platform?: string
  home?: string
  keychain?: () => Promise<string>
  now?: () => number
  busyTimeout?: number
}

function chromePassword(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/security', ['find-generic-password', '-w', '-s', 'Chrome Safe Storage', '-a', 'Chrome'],
      { encoding: 'utf8', timeout: 60_000, maxBuffer: 16_384 }, (error, stdout) => {
        // Never propagate child-process errors: they can contain stdout, stderr and the secret.
        if (error) reject(new Error(t('browser.cookieKeychainError')))
        else resolve(stdout.replace(/\r?\n$/, ''))
      })
  })
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep)
}

async function cookieFile(profile: string): Promise<string | undefined> {
  for (const path of [join(profile, 'Network', 'Cookies'), join(profile, 'Cookies')]) {
    try {
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink() || !within(profile, await realpath(path))) {
        throw new Error(t('browser.cookieUnsafePath'))
      }
      return path
    } catch (error) {
      if (!missing(error)) throw error
    }
  }
  return undefined
}

interface DiscoveredSource { source: BrowserCookieSource; path: string }
type Row = Record<string, unknown>

function decodeValue(data: Uint8Array, domain: string, version: number, key: Buffer): string {
  try {
    const encrypted = Buffer.from(data)
    if (!encrypted.subarray(0, 3).equals(Buffer.from('v10'))) {
      throw new Error('version')
    }
    if (encrypted.length <= 3 || (encrypted.length - 3) % 16 !== 0) throw new Error('length')
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
    let value = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()])
    if (version >= 24) {
      const hash = createHash('sha256').update(domain).digest()
      if (value.length < 32 || !value.subarray(0, 32).equals(hash)) throw new Error('host hash')
      value = value.subarray(32)
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(value)
  } catch {
    throw new Error(t('browser.cookieDecryptError'))
  }
}

/** Injectable OS/keychain boundary for fixture tests; production uses only the fixed Chrome root. */
export function createCookieReaders(options: ReaderOptions = {}): {
  listCookieSources: () => Promise<BrowserCookieSource[]>
  readCookieSource: (sourceId: string, include: (domain: string) => boolean, decrypt: boolean) => Promise<SourceCookie[]>
} {
  const platform = options.platform ?? process.platform
  const root = join(options.home ?? homedir(), 'Library', 'Application Support', 'Google', 'Chrome')

  async function discover(): Promise<DiscoveredSource[]> {
    if (platform !== 'darwin') return []
    let directories
    try { directories = await readdir(root, { withFileTypes: true }) } catch (error) {
      if (missing(error)) return []
      throw new Error(t('browser.cookieReadProfilesError'))
    }
    let names: Record<string, { name?: unknown }> = {}
    try {
      const state: unknown = JSON.parse(await readFile(join(root, 'Local State'), 'utf8'))
      if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('shape')
      const cache = (state as { profile?: { info_cache?: unknown } }).profile?.info_cache
      if (cache !== undefined) {
        if (!cache || typeof cache !== 'object' || Array.isArray(cache)) throw new Error('shape')
        names = cache as typeof names
      }
    } catch (error) {
      if (!missing(error)) throw new Error(t('browser.cookieLocalStateError'))
    }
    const sources: DiscoveredSource[] = []
    const actualRoot = await realpath(root)
    for (const entry of directories.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || !/^(Default|Profile \d+)$/.test(entry.name)) continue
      const profile = await realpath(join(root, entry.name))
      if (!within(actualRoot, profile)) throw new Error(t('browser.cookieUnsafePath'))
      const path = await cookieFile(profile)
      if (!path) continue
      const displayName = names[entry.name]?.name
      sources.push({ path, source: {
        id: `chrome:${createHash('sha256').update(profile).digest('hex')}`,
        browser: 'chrome',
        name: `Chrome · ${typeof displayName === 'string' && displayName ? displayName : entry.name}`
      } })
    }
    return sources
  }

  return {
    async listCookieSources() { return (await discover()).map(({ source }) => source) },
    async readCookieSource(sourceId, include, decrypt) {
      const source = (await discover()).find(({ source }) => source.id === sourceId)
      if (!source) throw new Error(t('browser.cookieSourceUnavailable'))
      let rows: Row[]
      let version: number
      // A read transaction pins one SQLite snapshot across schema/meta/cookies, including WAL.
      // No backup is needed: no files are copied, no writes/checkpoints touch the source DB.
      // macOS Chrome keeps only SQLite's shared/advisory locks on Cookies (exclusive access is Windows-only),
      // so a running Chrome blocks a read only while it commits; wait briefly instead of failing at once.
      let db: DatabaseSync | undefined
      try {
        db = new DatabaseSync(source.path, { readOnly: true, timeout: options.busyTimeout ?? 5_000 })
        db.exec('BEGIN')
        const columns = db.prepare('PRAGMA table_info(cookies)').all().map((row) => String(row.name))
        const partitionColumns = columns.filter((column) =>
          /partition/i.test(column) || column === 'top_frame_site_key')
        const meta = db.prepare("SELECT value FROM meta WHERE key = 'version'").get()
        version = Number(meta?.value)
        if (!Number.isSafeInteger(version) || version < 1) throw new Error(t('browser.cookieDatabaseVersion'))
        const selected = ['name', 'value', 'encrypted_value', 'host_key', 'path', 'is_secure', 'is_httponly', 'expires_utc', 'samesite', ...partitionColumns]
        if (selected.some((column) => !columns.includes(column))) throw new Error(t('browser.cookieDatabaseSchema'))
        const query = db.prepare(`SELECT ${selected.map((column) => `"${column.replaceAll('"', '""')}"`).join(',')} FROM cookies`)
        // Chromium's microseconds since 1601 exceed JS's safe integer range.
        query.setReadBigInts(true)
        rows = query.all()
        db.exec('COMMIT')
      } catch (error) {
        throw databaseError(error)
      } finally { db?.close() }

      const now = (options.now ?? (() => Date.now() / 1000))()
      const matched = rows.filter((row) => include(String(row.host_key)))
      const records = matched.map((row): SourceCookie => {
        const expires = Number(row.expires_utc)
        const sameSites: Record<string, SourceCookie['sameSite']> = {
          '-1': 'unspecified', '0': 'no_restriction', '1': 'lax', '2': 'strict'
        }
        const sameSite = sameSites[String(row.samesite)]
        if (!sameSite || !Number.isFinite(expires) || expires < 0) throw new Error(t('browser.cookieDataError'))
        return {
          name: String(row.name), value: '', domain: String(row.host_key), path: String(row.path),
          secure: !!row.is_secure, httpOnly: !!row.is_httponly, hostOnly: !String(row.host_key).startsWith('.'),
          ...(expires === 0 ? {} : { expirationDate: expires / 1_000_000 - 11_644_473_600 }),
          sameSite,
          partitioned: Object.keys(row).some((key) => (/partition/i.test(key) || key === 'top_frame_site_key') &&
            row[key] !== null && row[key] !== undefined && row[key] !== '' && row[key] !== 0 && row[key] !== 0n)
        }
      })
      if (!decrypt) return records
      let key: Buffer | undefined
      try {
        for (let i = 0; i < records.length; i++) {
          const record = records[i]!
          if (record.partitioned || (record.expirationDate !== undefined && record.expirationDate <= now)) continue
          const row = matched[i]!
          const encrypted = row.encrypted_value
          if (!(encrypted instanceof Uint8Array)) throw new Error(t('browser.cookieDataError'))
          if (encrypted.length) {
            if (!key) {
              let password: string
              try { password = await (options.keychain ?? chromePassword)() } catch {
                throw new Error(t('browser.cookieKeychainError'))
              }
              if (!password) throw new Error(t('browser.cookieEmptyKeyError'))
              key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
            }
            record.value = decodeValue(encrypted, record.domain, version, key)
          } else record.value = String(row.value)
        }
        return records
      } finally { key?.fill(0) }
    }
  }
}

/** Classifies by SQLite result code; our own version/schema errors pass through unchanged.
 * SQLite messages never contain row data, so the original error is kept as `cause`. */
function databaseError(error: unknown): unknown {
  const code = (error as { errcode?: unknown } | null)?.errcode
  if (typeof code !== 'number') return error
  const primary = code & 0xff
  return new Error(t(primary === 5 || primary === 6 ? 'browser.cookieDatabaseBusy' : 'browser.cookieDatabaseError'), { cause: error })
}

const readers = createCookieReaders()
export const listCookieSources = readers.listCookieSources
export const readCookieSource = readers.readCookieSource
