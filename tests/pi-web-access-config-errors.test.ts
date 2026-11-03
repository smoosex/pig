import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runChild } from './helpers/subprocess.ts'

/**
 * `web-search.json` is the credential store, and V8's `JSON.parse` quotes about twenty characters of
 * the file around the failure. A key pasted without surrounding quotes therefore produced an error
 * whose message contained the key itself, and those messages reach tool results: `isConfigParseError`
 * matches the `Failed to parse ` prefix precisely so the extract paths can report the config problem
 * instead of a fetch failure.
 *
 * Every loader must therefore keep the prefix, drop the parser text, and name no credential. The
 * Google ADC file is checked in the same pass: it is a second credential store whose loader used to
 * quote `JSON.parse` the same way.
 *
 * The fixture runs under Node because that is the engine with the leak: Bun's parser reports the
 * problem without quoting the source, so a passing run there would prove nothing.
 */
const SENTINEL = 'sk-live-CREDENTIALSENTINEL'

function assertRedacted(label: string, message: string): boolean {
  assert.ok(!message.includes(SENTINEL), `${label} must not echo the credential: ${message}`)
  assert.ok(!message.includes('Unexpected token'), `${label} must not echo the parser text: ${message}`)
  assert.ok(!message.includes('is not valid JSON'), `${label} must not echo the parser text: ${message}`)
  assert.ok(message.startsWith('Failed to '), `${label} keeps the prefix the extract paths match: ${message}`)
  return true
}

async function expectThrow(label: string, probe: () => unknown, message: string): Promise<void> {
  try {
    await probe()
  } catch (error) {
    assertRedacted(label, (error as Error).message)
    return
  }
  assert.fail(`${label} must reject a malformed ${message}`)
}

async function runFixture(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pig-web-access-parse-'))
  process.env.PIG_DIR = root
  process.env.GOOGLE_APPLICATION_CREDENTIALS = join(root, 'adc.json')
  const config = join(root, 'web-search.json')
  try {
    const webAccess = await import('../src/main/plugins/pi-web-access/utils.ts')
    const ssrf = await import('../src/main/plugins/pi-web-access/ssrf-protection.ts')
    const adc = await import('../src/main/plugins/pi-web-access/gemini-adc.ts')
    const zai = await import('../src/main/plugins/pi-web-access/zai.ts')
    const baizhi = await import('../src/main/plugins/pi-web-access/baizhi.ts')
    const brave = await import('../src/main/plugins/pi-web-access/brave.ts')
    const authFetch = await import('../src/main/plugins/pi-web-access/auth-fetch.ts')
    const loaders: [string, () => unknown][] = [
      ['shared reader (zai)', () => zai.isZaiAvailable()],
      ['shared reader (baizhi)', () => baizhi.isBaizhiAvailable()],
      ['shared reader (brave)', () => brave.isBraveAvailable()],
      ['shared reader (auth-fetch)', () => authFetch.resolveAuthFetchProfile(true)],
      ['ssrf-protection.ts', () => ssrf.loadFetchContentDomainPolicy()],
      ['utils.ts proxy config', () => webAccess.loadConfiguredProxy()]
    ]

    // An unquoted key is the mistake that leaks: V8 quotes the text around the offending token.
    await writeFile(config, `{"braveApiKey": ${SENTINEL}}`)
    for (const [label, probe] of loaders) await expectThrow(label, probe, 'JSON')

    // Valid JSON that is not an object is the other config failure users hit by hand-editing. Only the
    // readers reject it; the proxy and SSRF loaders keep their deliberate tolerance for a root they
    // cannot read a section from, and a fail-open-safe null is the safer answer for the policy.
    await writeFile(config, `["${SENTINEL}"]`)
    for (const [label, probe] of loaders.slice(0, 4)) await expectThrow(label, probe, 'non-object config')
    await writeFile(join(root, 'adc.json'), `{"client_secret": ${SENTINEL}}`)
    await expectThrow('gemini-adc.ts', () => adc.getAdcAccessToken(), 'ADC JSON')
    // Their own behaviour, pinned here so a future edit has to be deliberate: a root that parses but
    // is not an object is treated as "no such section" — the proxy yields null and the SSRF policy
    // falls back to empty allow/deny lists instead of throwing.
    assert.deepEqual(ssrf.loadFetchContentDomainPolicy(), { allow: [], deny: [] })
    assert.equal(webAccess.loadConfiguredProxy(), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--web-access-parse-fixture') {
  await runFixture()
} else {
  // Imported here, not at the top: Node loads this same file to run the fixture and cannot resolve
  // the bun:test scheme.
  const { test } = await import('bun:test')
  test('a malformed credential file reports the position without echoing the credential', async () => {
    const { exitCode, stdout, stderr } = await runChild(
      ['node', '--experimental-strip-types', import.meta.path, '--web-access-parse-fixture'],
      { timeoutMs: 20_000 }
    )
    assert.equal(exitCode, 0, stderr || stdout)
  }, 25_000)
}
