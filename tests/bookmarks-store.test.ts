import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReplyBookmark } from '../src/shared/bookmarks'
import { runSelf } from './helpers/subprocess'

async function fixture(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pig-bookmarks-'))
  mock.module('../src/main/pig-dir', () => ({ pigPath: () => join(root, 'bookmarks.json') }))
  const { BookmarkStore } = await import('../src/main/bookmarks')
  const file = join(root, 'bookmarks.json')
  const item = (id: string): ReplyBookmark => ({
    id: `session/${id}`, entryId: id, turnId: `turn-${id}`, kind: 'project', preview: `Reply ${id}`, createdAt: 1,
    session: { id: 'session', path: '/sessions/example.jsonl', cwd: '/project', created: '', modified: '', size: 0, firstMessage: 'Question' }
  })
  try {
    const store = new BookmarkStore(() => file)
    assert.deepEqual(await store.list(), { revision: 0, items: [] })
    await Promise.all([store.add(item('a')), store.add(item('b'))])
    assert.deepEqual((await store.list()).items.map(item => item.id), ['session/b', 'session/a'])
    const revision = (await store.list()).revision
    assert.equal((await store.add(item('a'))).revision, revision, 'duplicate adds are idempotent')
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    assert.deepEqual(await new BookmarkStore(() => file).list(), await store.list(), 'restart preserves every reference')
    await Promise.all([store.remove('session/a'), store.add(item('c'))])
    assert.deepEqual((await store.list()).items.map(item => item.entryId), ['c', 'b'])
    assert.equal((await store.remove('missing')).revision, (await store.list()).revision)
    for (const invalid of ['{SECRET-broken', JSON.stringify({ revision: 1, items: [{}] })]) {
      await writeFile(file, invalid)
      await assert.rejects(store.list(), /Invalid bookmark/)
      await assert.rejects(store.add(item('d')), /Invalid bookmark/)
      assert.equal(await readFile(file, 'utf8'), invalid, 'bad data must never be overwritten')
    }
    await writeFile(file, JSON.stringify({ revision: 0, items: [] }))
    await store.add(item('recovered'))
    assert.equal((await store.list()).items[0].entryId, 'recovered', 'a failed write does not poison the queue')
  } finally { await rm(root, { recursive: true, force: true }) }
}

if (process.argv.includes('--fixture')) await fixture()
else test('reply bookmarks persist atomically, serialize mutations and reject corrupt data', async () => {
  const result = await runSelf(import.meta.path, ['--fixture'], { timeoutMs: 15_000 })
  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
})
