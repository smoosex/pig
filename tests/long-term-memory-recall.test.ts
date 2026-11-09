import { test, spyOn } from 'bun:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSelf } from './helpers/subprocess'

async function fixture(scenario: string): Promise<void> {
  const root = fs.mkdtempSync(join(tmpdir(), 'pig-memory-recall-'))
  try {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent')
    const { sourceHash } = await import('../src/main/features/memory/long-term/sources')
    const { recallLongTermSources } = await import('../src/main/features/memory/long-term/recall')
    const manager = SessionManager.create(root, root)
    const user = manager.appendMessage({ role: 'user', content: 'Use bun', timestamp: Date.now() })
    manager.appendCustomEntry('test.flush', {})
    const path = manager.getSessionFile()!
    const original = fs.readFileSync(path)
    const source = { sessionId: manager.getSessionId(), sessionFile: path, cwd: root, anchorId: manager.getLeafId()!,
      entryId: user, digest: sourceHash(manager.getEntry(user)), role: 'user' as const, timestamp: new Date().toISOString() }
    const evidence = { episodeId: 'a'.repeat(64), sources: [source] }
    const recall = () => recallLongTermSources(evidence)
    if (scenario === 'read-only') {
      const entries = original.toString('utf8').trim().split('\n').map(line => JSON.parse(line))
      const legacy = (version: number) => entries.map((entry, index) => {
        if (!index) return { ...entry, version }
        if (version === 2) return entry
        const { id: _id, parentId: _parentId, ...linear } = entry
        return linear
      }).map(entry => JSON.stringify(entry)).join('\n') + '\n'
      for (const [label, body, status] of [
        ['current', original, 'available'],
        ['empty', Buffer.alloc(0), 'unavailable'],
        ['blank', Buffer.from('\n  \n'), 'unavailable'],
        ['missing newline', Buffer.from(original.toString('utf8').trimEnd()), 'available'],
        ['version 2', Buffer.from(legacy(2)), 'available'],
        ['version 1', Buffer.from(legacy(1)), 'changed'],
      ] as const) {
        fs.writeFileSync(path, body)
        // A read must work even when repairing or migrating the source is not permitted.
        fs.chmodSync(path, 0o400)
        try {
          const before = fs.statSync(path, { bigint: true })
          const result = recall()
          assert.equal(result.status, status, label)
          if (status === 'available') assert.equal(result.sources[0]!.text, 'Use bun')
          assert.deepEqual(fs.readFileSync(path), body, `${label}: source bytes must not change`)
          assert.equal(fs.statSync(path, { bigint: true }).mtimeNs, before.mtimeNs, `${label}: source must not be rewritten`)
        } finally { fs.chmodSync(path, 0o600) }
      }
      fs.unlinkSync(path)
      assert.equal(recall().status, 'unavailable')
      assert.equal(fs.existsSync(path), false, 'recall must not initialize missing history')
      fs.writeFileSync(path, 'parent is a regular file')
      assert.equal(recallLongTermSources({ ...evidence, sources: [{ ...source, sessionFile: join(path, 'child') }] }).status, 'unavailable')
    } else if (scenario === 'malformed') {
      for (const body of ['not JSON\n', 'null\n', '[]\n', '{}\n', original.toString('utf8') + '{"note":"private source text",']) {
        fs.writeFileSync(path, body)
        assert.throws(recall, error => error instanceof SyntaxError && !error.message.includes('private source text'))
        assert.equal(fs.readFileSync(path, 'utf8'), body)
      }
      const rows = original.toString('utf8').trim().split('\n').map(line => JSON.parse(line))
      for (const [label, mutate] of [
        ['duplicate', (entries: any[]) => { entries.push(entries[1]) }],
        ['cycle', (entries: any[]) => { entries[1].parentId = entries[1].id }],
        ['missing parent', (entries: any[]) => { entries[1].parentId = 'missing' }],
      ] as const) {
        const entries = structuredClone(rows); mutate(entries)
        const body = entries.map(entry => JSON.stringify(entry)).join('\n')
        fs.writeFileSync(path, body)
        assert.throws(recall, SyntaxError, label)
        assert.equal(fs.readFileSync(path, 'utf8'), body)
      }
      rows[0].version = 99
      fs.writeFileSync(path, rows.map(entry => JSON.stringify(entry)).join('\n'))
      assert.throws(recall, RangeError)
      fs.writeFileSync(path, Buffer.concat([original, Buffer.from([0xff])]))
      assert.throws(recall, error => (error as NodeJS.ErrnoException).code === 'ERR_ENCODING_INVALID_ENCODED_DATA')
      assert.throws(() => recallLongTermSources({ ...evidence, sources: [{ ...source, sessionFile: root }] }),
        error => (error as NodeJS.ErrnoException).code === 'EISDIR')
    } else {
      const failure = Object.assign(new Error('Source read failed'), { code: '' })
      const read = spyOn(fs, 'readFileSync').mockImplementation(() => { throw failure })
      try {
        for (const code of ['EACCES', 'EPERM', 'EIO']) {
          failure.code = code
          assert.throws(recall, error => error === failure, `${code} must propagate unchanged`)
        }
        for (const code of ['ENOENT', 'ENOTDIR']) {
          failure.code = code
          assert.equal(recall().status, 'unavailable', `${code} is expected missing history`)
        }
      } finally { read.mockRestore() }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}
if (process.argv.includes('--fixture')) await fixture(process.argv[3]!)
else for (const scenario of ['read-only', 'malformed', 'io-errors']) test(`long-term source recall: ${scenario}`, async () => {
  const result = await runSelf(import.meta.path, ['--fixture', scenario], { timeoutMs: 10_000 })
  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
}, 15_000)
