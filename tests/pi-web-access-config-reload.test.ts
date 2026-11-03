import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSelf } from './helpers/subprocess.ts'

/**
 * The host exports PIG_DIR from its own process and may point it at another directory after the plugin
 * was imported, and Pig's settings page rewrites the file in place. Both have to be visible without a
 * reload: the reader caches per path + mtime + size, so neither a frozen path nor a "read it once"
 * memo can survive. Every module that reads the file shares that one policy now.
 */
async function runFixture(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pig-web-access-reload-'))
  const first = join(root, 'first')
  const second = join(root, 'second')
  await mkdir(first)
  await mkdir(second)
  const firstBody = JSON.stringify({
    braveApiKey: 'key-from-first',
    fetchContent: { domainPolicy: { allow: ['first.example'] } },
    webSearch: { allowedProviders: ['brave'] },
    video: { enabled: true, maxSizeMB: 1 }
  })
  const secondBody = JSON.stringify({
    fetchContent: { domainPolicy: { allow: ['second.example'] } },
    webSearch: { allowedProviders: ['exa'] },
    video: { enabled: true, maxSizeMB: 9 }
  })
  // Same size and same mtime on purpose: a cache keyed on mtime:size alone cannot tell these files
  // apart, so only a key that carries the path passes.
  const width = Math.max(firstBody.length, secondBody.length) + 1
  const firstFile = join(first, 'web-search.json')
  const secondFile = join(second, 'web-search.json')
  await writeFile(firstFile, firstBody.padEnd(width, ' '))
  await writeFile(secondFile, secondBody.padEnd(width, ' '))
  const stamp = new Date('2026-01-01T00:00:00.000Z')
  await utimes(firstFile, stamp, stamp)
  await utimes(secondFile, stamp, stamp)
  delete process.env.BRAVE_API_KEY
  try {
    const brave = await import('../src/main/plugins/pi-web-access/brave.ts')
    const ssrf = await import('../src/main/plugins/pi-web-access/ssrf-protection.ts')
    const search = await import('../src/main/plugins/pi-web-access/gemini-search.ts')
    const video = await import('../src/main/plugins/pi-web-access/video-extract.ts')
    const clip = join(root, 'clip.mp4')
    await writeFile(clip, 'x')

    process.env.PIG_DIR = first
    assert.equal(brave.isBraveAvailable(), true, 'the first directory supplies the key')
    assert.deepEqual(ssrf.loadFetchContentDomainPolicy().allow, ['first.example'])
    assert.deepEqual(search.getAllowedSearchProviders(), ['brave'])
    assert.equal(video.isVideoFile(clip)?.maxSizeBytes, 1024 * 1024)

    process.env.PIG_DIR = second
    assert.equal(brave.isBraveAvailable(), false, 'a cached provider config must follow PIG_DIR')
    assert.deepEqual(ssrf.loadFetchContentDomainPolicy().allow, ['second.example'], 'the domain policy cache must too')
    assert.deepEqual(search.getAllowedSearchProviders(), ['exa'], 'the search routing cache must too')
    assert.equal(video.isVideoFile(clip)?.maxSizeBytes, 9 * 1024 * 1024, 'the video config cache must too')

    process.env.PIG_DIR = first
    assert.equal(brave.isBraveAvailable(), true, 'switching back is visible as well')
    assert.deepEqual(ssrf.loadFetchContentDomainPolicy().allow, ['first.example'])
    assert.deepEqual(search.getAllowedSearchProviders(), ['brave'])
    assert.equal(video.isVideoFile(clip)?.maxSizeBytes, 1024 * 1024)

    // A key saved while the plugin stays loaded has to reach the provider, and so does every other
    // field a provider reads: this is what one shared policy buys. The body drops the Brave key, moves
    // the allowed providers off the value `first` had, and disables video, so a stale cache cannot
    // satisfy any of the three assertions by accident.
    await writeFile(firstFile, JSON.stringify({
      fetchContent: { domainPolicy: { allow: ['first.example'] } },
      webSearch: { allowedProviders: ['exa'] },
      video: { enabled: false }
    }))
    assert.equal(brave.isBraveAvailable(), false, 'a saved key takes effect without a reload')
    assert.deepEqual(search.getAllowedSearchProviders(), ['exa'], 'the search routing follows the same edit')
    assert.equal(video.isVideoFile(clip), null, 'and so does the video config')

    // A stat failure must not be mistaken for "no config file": serving an empty document and keeping
    // the bare path as the signature would stay wrong for as long as the failure lasted.
    await chmod(root, 0o000)
    try {
      assert.throws(() => search.getAllowedSearchProviders(), /EACCES|permission denied/i,
        'an unreadable directory is an error, not an absent config')
    } finally {
      // Restored even when the assertion fails, or the cleanup below cannot empty the directory.
      await chmod(root, 0o755)
    }
    await writeFile(firstFile, JSON.stringify({ webSearch: { allowedProviders: ['brave'] } }))
    assert.deepEqual(search.getAllowedSearchProviders(), ['brave'], 'the reader recovers once it is readable')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--web-access-reload-fixture') {
  await runFixture()
} else {
  test('provider config and domain policy follow PIG_DIR instead of freezing the first path', async () => {
    const { exitCode, stdout, stderr } = await runSelf(
      import.meta.path,
      ['--web-access-reload-fixture'],
      { timeoutMs: 15_000 }
    )
    assert.equal(exitCode, 0, stderr || stdout)
  })
}
