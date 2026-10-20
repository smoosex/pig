import { afterEach, describe, expect, test } from 'bun:test'
import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createCookieReaders } from '../src/main/browser/cookies/readers'
import { t } from '../src/main/i18n'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

function encrypt(domain: string, value = 'synthetic-value', version = 24): Buffer {
  const cipher = createCipheriv('aes-128-cbc', pbkdf2Sync('fixture-password', 'saltysalt', 1003, 16, 'sha1'), Buffer.alloc(16, 32))
  const plain = Buffer.concat([version >= 24 ? createHash('sha256').update(domain).digest() : Buffer.alloc(0), Buffer.from(value)])
  return Buffer.concat([Buffer.from('v10'), cipher.update(plain), cipher.final()])
}

async function fixture({ modern = true, wal = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'pig-cookie-test-'))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const root = join(home, 'Library/Application Support/Google/Chrome')
  const profile = join(root, 'Default')
  const folder = modern ? join(profile, 'Network') : profile
  await mkdir(folder, { recursive: true })
  await writeFile(join(root, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Fixture' } } } }))
  const path = join(folder, 'Cookies')
  const db = new DatabaseSync(path)
  cleanup.push(async () => db.close())
  if (wal) db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0')
  db.exec(`CREATE TABLE meta (key TEXT, value TEXT);
    INSERT INTO meta VALUES ('version', '24');
    CREATE TABLE cookies (name TEXT, value TEXT, encrypted_value BLOB, host_key TEXT, path TEXT,
      is_secure INTEGER, is_httponly INTEGER, expires_utc INTEGER, samesite INTEGER,
      top_frame_site_key TEXT, has_cross_site_ancestor INTEGER, is_partitioned INTEGER);`)
  function insert(domain = '.example.test', overrides: Partial<{
    name: string; value: string; encrypted: Buffer; expires: number; sameSite: number; partition: string; flag: number
  }> = {}) {
    db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      overrides.name ?? 'fixture-name', overrides.value ?? '', overrides.encrypted ?? encrypt(domain), domain, '/', 1, 1,
      overrides.expires ?? 0, overrides.sameSite ?? 1, overrides.partition ?? '', 0, overrides.flag ?? 0)
  }
  let calls = 0
  const readers = createCookieReaders({ home, platform: 'darwin', now: () => 1_700_000_000,
    keychain: async () => { calls++; return 'fixture-password' } })
  async function read(decrypt = true, include = (_: string) => true) {
    const sources = await readers.listCookieSources()
    return readers.readCookieSource(sources[0]!.id, include, decrypt)
  }
  return { home, root, profile, path, db, insert, readers, read, calls: () => calls }
}

describe('macOS Chrome cookie readers (synthetic fixtures only)', () => {
  test('discovers only approved profile directories with opaque ids, rejects arbitrary paths', async () => {
    const f = await fixture()
    await mkdir(join(f.root, 'Guest Profile'))
    await symlink(f.profile, join(f.root, 'Profile 2'))
    const sources = await f.readers.listCookieSources()
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({ browser: 'chrome', name: 'Chrome · Fixture' })
    expect(sources[0]!.id).toMatch(/^chrome:[a-f0-9]{64}$/)
    await expect(f.readers.readCookieSource(f.path, () => true, true)).rejects.toThrow(t('browser.cookieSourceUnavailable'))
    expect(f.calls()).toBe(0)
  })

  test('v24 validates domain hash and translates attributes/timestamps', async () => {
    const f = await fixture()
    f.insert('.example.test', { expires: (1_800_000_000 + 11_644_473_600) * 1_000_000, sameSite: 2 })
    f.insert('host.test', { encrypted: encrypt('host.test', ''), sameSite: -1 })
    const records = await f.read()
    expect(records[0]).toEqual({ name: 'fixture-name', value: 'synthetic-value', domain: '.example.test', path: '/',
      secure: true, httpOnly: true, hostOnly: false, expirationDate: 1_800_000_000, sameSite: 'strict', partitioned: false })
    expect(records[1]).toMatchObject({ value: '', hostOnly: true, sameSite: 'unspecified' })
    expect(records[1]).not.toHaveProperty('expirationDate')
    expect(f.calls()).toBe(1)
  })

  test('preview never reads keychain; include, expiry and partition filters precede decryption', async () => {
    const f = await fixture()
    const broken = Buffer.from('v20invalid')
    f.insert('excluded.test', { encrypted: broken })
    f.insert('expired.test', { encrypted: broken, expires: (1_600_000_000 + 11_644_473_600) * 1_000_000 })
    f.insert('partition.test', { encrypted: broken, partition: 'https://top.test' })
    f.insert('flag.test', { encrypted: broken, flag: 1 })
    expect((await f.read(false)).every((row) => row.value === '')).toBe(true)
    const rows = await f.read(true, (domain) => domain !== 'excluded.test')
    expect(rows).toHaveLength(3)
    expect(rows.filter((row) => row.partitioned)).toHaveLength(2)
    expect(f.calls()).toBe(0)
  })

  test.each([
    ['wrong host hash', encrypt('other.test')],
    ['unsupported v20', Buffer.from('v20invalid')],
    ['non-ASCII version bytes', Buffer.concat([Buffer.from([0xf6, 0x31, 0x30]), encrypt('.example.test').subarray(3)])],
    ['v24 missing domain hash', encrypt('.example.test', 'short', 23)],
    ['truncated ciphertext', encrypt('.example.test').subarray(0, -1)],
    ['bad padding', Buffer.concat([Buffer.from('v10'), Buffer.alloc(16)])]
  ])('rejects %s without cookie content in error', async (_label, encrypted) => {
    const f = await fixture()
    f.insert('.example.test', { encrypted, name: 'sensitive-name' })
    let error: unknown
    try { await f.read() } catch (e) { error = e }
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain(t('browser.cookieDecryptError'))
    expect(String(error)).not.toContain('sensitive-name')
    expect(String(error)).not.toContain('synthetic-value')
  })

  test('pre-v24 does not remove cookie prefix; plaintext does not require keychain', async () => {
    const f = await fixture({ modern: false })
    f.db.exec("UPDATE meta SET value='23'")
    f.insert('legacy.test', { encrypted: encrypt('legacy.test', 'short', 23), sameSite: 0 })
    f.insert('plain.test', { encrypted: Buffer.alloc(0), value: 'plain' })
    expect((await f.read()).map((row) => row.value)).toEqual(['short', 'plain'])
    expect((await f.read())[0]!.sameSite).toBe('no_restriction')
    expect(f.calls()).toBe(2) // No key/password cache survives a read.
  })

  test('WAL snapshot sees committed rows, not an in-flight write, and preserves source files', async () => {
    const f = await fixture({ wal: true })
    f.insert('committed.test')
    f.db.exec('BEGIN IMMEDIATE')
    f.insert('uncommitted.test')
    const before = await Promise.all([readFile(f.path), readFile(`${f.path}-wal`)])
    expect((await f.read(false)).map((row) => row.domain)).toEqual(['committed.test'])
    expect(await readFile(f.path)).toEqual(before[0]!)
    expect(await readFile(`${f.path}-wal`)).toEqual(before[1]!)
    f.db.exec('COMMIT')
    expect((await f.read(false)).map((row) => row.domain)).toEqual(['committed.test', 'uncommitted.test'])
    const readonly = new DatabaseSync(f.path, { readOnly: true })
    try {
      expect(readonly.prepare('SELECT count(*) AS n FROM cookies').get()!.n).toBe(2)
    } finally { readonly.close() }
  })

  test('missing database does not get created, missing Local State is allowed but malformed is not', async () => {
    const f = await fixture()
    await rm(join(f.root, 'Local State'))
    expect((await f.readers.listCookieSources())[0]!.name).toBe('Chrome · Default')
    await writeFile(join(f.root, 'Local State'), '{broken')
    await expect(f.readers.listCookieSources()).rejects.toThrow('Local State')
    await rm(join(f.root, 'Local State'))
    const id = (await f.readers.listCookieSources())[0]!.id
    // Unlinking this fixture's open DB is intentional; production only ever opens read-only.
    await rm(f.path)
    expect(await f.readers.listCookieSources()).toEqual([])
    await expect(f.readers.readCookieSource(id, () => true, false)).rejects.toThrow(t('browser.cookieSourceUnavailable'))
    expect(await Bun.file(f.path).exists()).toBe(false)
  })

  test('a write-locked database reports Chrome busy by SQLite code; other SQLite failures keep their cause', async () => {
    const f = await fixture()
    f.insert()
    const readers = createCookieReaders({ home: f.home, platform: 'darwin', busyTimeout: 50 })
    const id = (await readers.listCookieSources())[0]!.id
    f.db.exec('BEGIN EXCLUSIVE')
    let busy: unknown
    try { await readers.readCookieSource(id, () => true, false) } catch (e) { busy = e }
    f.db.exec('COMMIT')
    expect((busy as Error).message).toBe(t('browser.cookieDatabaseBusy'))
    expect(((busy as Error).cause as { errcode: number }).errcode).toBe(5)
    expect(await readers.readCookieSource(id, () => true, false)).toHaveLength(1)
    const failure = async (sql: string) => {
      const g = await fixture()
      g.db.exec(sql)
      try { await g.read(false) } catch (e) { return e as Error }
      throw new Error('expected the read to fail')
    }
    expect((await failure('DROP TABLE cookies; CREATE TABLE cookies (name TEXT)')).message).toBe(t('browser.cookieDatabaseSchema'))
    expect((await failure("UPDATE meta SET value='bogus'")).message).toBe(t('browser.cookieDatabaseVersion'))
    const broken = await failure('DROP TABLE meta')
    expect(broken.message).toBe(t('browser.cookieDatabaseError'))
    expect((broken.cause as { errcode: number }).errcode).toBe(1)
  })

  test('rejects Network directory symlink escape', async () => {
    const f = await fixture({ modern: false })
    const external = join(f.home, 'outside')
    await mkdir(external)
    await writeFile(join(external, 'Cookies'), 'not a database')
    await symlink(external, join(f.profile, 'Network'))
    await expect(f.readers.listCookieSources()).rejects.toThrow(t('browser.cookieUnsafePath'))
  })

  test('keychain failures never leak child-process stdout/stderr/secret', async () => {
    const f = await fixture()
    f.insert()
    const readers = createCookieReaders({ home: f.home, platform: 'darwin', keychain: async () => {
      throw Object.assign(new Error('stdout=SECRET stderr=SECRET'), { stdout: 'SECRET', stderr: 'SECRET' })
    } })
    const id = (await readers.listCookieSources())[0]!.id
    let error: unknown
    try { await readers.readCookieSource(id, () => true, true) } catch (e) { error = e }
    expect(String(error)).toContain(t('browser.cookieKeychainError'))
    expect(String(error)).not.toContain('SECRET')
    expect((error as Error).cause).toBeUndefined()
  })

  test('non-macOS returns no sources without touching disk or keychain', async () => {
    expect(await createCookieReaders({ platform: 'linux', home: '/nonexistent-fixture' }).listCookieSources()).toEqual([])
  })
})
