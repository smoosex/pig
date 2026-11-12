/** Discover huge histories without loading their message bodies or calling SDK full-text listing. */
import { mock, spyOn, test } from 'bun:test'
import assert from 'node:assert/strict'
import { runSelf } from './helpers/subprocess'

if (process.argv.includes('--discovery-fixture')) {
  const fs = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'pig-dream-discovery-')))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  mock.module('../src/main/features/memory/long-term/access', () => ({
    isChatMemoryCwd: () => false,
    memoryAccess: async () => { throw new Error('Discovery must not resolve project identity') }
  }))
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const { loadDreamSources } = await import('../src/main/features/memory/dream/history')
  const { UnsupportedSessionFile } = await import('../src/main/pi/session-jsonl')
  const listing = spyOn(SessionManager, 'listAll').mockImplementation(async () => { throw new Error('Unbounded SDK discovery was called') })
  try {
    assert.deepEqual(await loadDreamSources(), [])
    const directory = join(process.env.PI_CODING_AGENT_DIR, 'sessions', '--project--')
    fs.mkdirSync(directory, { recursive: true })
    const huge = join(directory, 'huge.jsonl')
    const header = JSON.stringify({ type: 'session', id: 'huge', version: 3, cwd: '/project' }) + '\n'
    const fd = fs.openSync(huge, 'wx')
    const size = 600 * 1024 * 1024
    try {
      fs.writeSync(fd, header + '{"type":"message","message":{"role":"toolResult","content":"', 0)
      fs.writeSync(fd, '"}}\n', size)
    } finally { fs.closeSync(fd) }
    fs.writeFileSync(join(directory, 'small.jsonl'), JSON.stringify({ type: 'session', id: 'small', version: 3, cwd: '/project' }) + '\n')
    const reads = spyOn(fs, 'readSync')
    try {
      const sources = await loadDreamSources()
      assert.deepEqual(sources.map(source => source.id).sort(), ['huge', 'small'])
      assert.ok(sources.every(source => source.cwd === '/project'))
      assert.equal(listing.mock.calls.length, 0)
      const calls = reads.mock.calls as unknown as unknown[][]
      assert.ok(calls.length > 0)
      const bytes = calls.reduce((total, call) => total + Number(call[3]), 0)
      assert.ok(bytes <= 2 * 1024 * 1024, 'discovery reads only bounded header prefixes, not the 600 MiB body')
    } finally { reads.mockRestore() }
    assert.equal(fs.statSync(huge).size, size + 4)
    const cancelled = new AbortController()
    const reason = new Error('DREAM_CANCELLED')
    cancelled.abort(reason)
    await assert.rejects(loadDreamSources(cancelled.signal), error => error === reason)
    fs.writeFileSync(join(directory, 'invalid.jsonl'), 'Invalid header\n')
    await assert.rejects(loadDreamSources(), error => error instanceof UnsupportedSessionFile, 'invalid metadata must not silently disappear')
  } finally {
    listing.mockRestore()
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
} else test('Dream history discovery reads bounded metadata even when a tool record exceeds the string limit', async () => {
  const result = await runSelf(import.meta.path, ['--discovery-fixture'], { timeoutMs: 10000 })
  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
})
