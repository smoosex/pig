import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, mkdirSync, statSync, linkSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryFiles, MAX_MEMORY_BYTES, resolveMemoryLink } from '../src/main/features/memory/long-term/files'

function fixture(run: (files: MemoryFiles, root: string) => void): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pig-file-memory-')))
  try { run(new MemoryFiles(join(root, 'notes')), root) } finally { rmSync(root, { recursive: true, force: true }) }
}

test('Markdown memory uses create-only writes, CAS edits/deletes and bounded search/read pages', () => fixture(files => {
  assert.deepEqual(files.list(), [])
  const first = files.save('MEMORY.md', '[Build](build.md)', null)
  const note = files.save('build.md', 'Bun\nRun bun test\nVerified after fixing the fixture', null)
  assert.throws(() => files.save('build.md', 'Overwrite', null), { code: 'MEMORY_ALREADY_EXISTS' })
  assert.equal(files.view('build.md', undefined, 1, 1).file?.content, 'Run bun test')
  assert.equal(files.view('build.md', undefined, 1, 1).file?.revision, note.revision)
  assert.equal(files.view('build.md', undefined, 1, 1).nextOffset, 2)
  assert.equal(files.view(undefined, 'BUN').matches?.length, 2)
  assert.equal(files.view(undefined, undefined, 0, 1).files?.length, 1)
  const next = files.save('build.md', 'Updated', note.revision)
  assert.throws(() => files.save('build.md', 'Stale', note.revision), { code: 'MEMORY_REVISION_CONFLICT' })
  assert.throws(() => files.delete('build.md', note.revision), { code: 'MEMORY_REVISION_CONFLICT' })
  assert.throws(() => files.save('build.md', 'Cancelled', next.revision, () => { throw new Error('cancelled') }), /cancelled/)
  assert.equal(files.read('build.md').content, 'Updated')
  files.delete('build.md', next.revision)
  assert.equal(files.optional('build.md'), undefined)
  assert.equal(files.read('MEMORY.md').revision, first.revision, 'links are never silently rewritten')
  assert.equal(statSync(join(files.root, 'MEMORY.md')).mode & 0o777, 0o600)
  assert.equal(statSync(files.root).mode & 0o777, 0o700)
  assert.deepEqual(readdirSync(files.root), ['MEMORY.md'])
}))

test('Markdown memory rejects traversal, links, invalid UTF-8, secrets and oversized indexes', () => fixture((files, root) => {
  for (const path of ['../outside.md', '/outside.md', 'a/../../outside.md', 'a\\outside.md', '%2e%2e/out.md', '.hidden.md', 'note.txt', 'a//b.md']) {
    assert.throws(() => files.save(path, 'No', null), /path|Markdown/)
  }
  assert.throws(() => files.save('MEMORY.md', 'x'.repeat(4097), null), /4 KiB/)
  assert.throws(() => files.save('MEMORY.md', 'x\n'.repeat(61), null), /60 lines/)
  assert.throws(() => files.save('big.md', 'x'.repeat(MAX_MEMORY_BYTES + 1), null), /64 KiB/)
  assert.throws(() => files.save('secret.md', 'api_key=sk-1234567890abcdefghijklmnopqrstuvwxyz', null), /credentials/)
  files.save('ok.md', 'safe', null)
  writeFileSync(join(root, 'outside.md'), 'OUTSIDE')
  symlinkSync(join(root, 'outside.md'), join(files.root, 'link.md'))
  assert.throws(() => files.read('link.md'), /regular/)
  assert.throws(() => files.save('link.md', 'Changed', null), /regular/)
  mkdirSync(join(root, 'external'))
  symlinkSync(join(root, 'external'), join(files.root, 'external'))
  assert.throws(() => files.save('external/a.md', 'Changed', null), /symbolic/)
  linkSync(join(root, 'outside.md'), join(files.root, 'hard.md'))
  assert.throws(() => files.read('hard.md'), /regular/)
  assert.equal(readFileSync(join(root, 'outside.md'), 'utf8'), 'OUTSIDE')
  writeFileSync(join(files.root, 'bad.md'), Buffer.from([0xff]))
  assert.throws(() => files.read('bad.md'))
}))

test('missing memory reads preserve ENOENT without exposing the storage path', () => fixture((files, root) => {
  const scoped = new MemoryFiles(join(files.root, 'projects', 'a'.repeat(64)), files.root)
  for (const store of [files, scoped]) {
    assert.equal(store.optional('missing.md'), undefined)
    assert.throws(() => store.read('missing.md'), (error: unknown) => {
      const failure = error as NodeJS.ErrnoException
      assert.equal(failure.code, 'ENOENT')
      assert.match(failure.message, /missing.md/)
      assert.ok(!failure.message.includes(root))
      assert.equal(failure.path, undefined)
      assert.equal(failure.cause, undefined)
      assert.ok(!JSON.stringify(failure).includes(root))
      return true
    })
  }
}))

test('memory deletion prunes only empty ancestors and preserves scope roots and nonempty directories', () => fixture((files, root) => {
  const global = new MemoryFiles(join(files.root, 'global'), files.root)
  const first = global.save('nested/branch/one.md', 'first', null)
  const sibling = global.save('nested/two.md', 'second', null)
  global.delete(first.path, first.revision)
  assert.throws(() => statSync(join(global.root, 'nested/branch')), { code: 'ENOENT' })
  assert.equal(global.read(sibling.path).content, sibling.content)
  global.delete(sibling.path, sibling.revision)
  assert.deepEqual(readdirSync(global.root), [], 'all empty note parents are reclaimed')
  assert.ok(statSync(global.root).isDirectory(), 'the scope root remains')
  assert.ok(statSync(files.root).isDirectory(), 'the catalog root remains')
  const protectedNote = global.save('protected/note.md', 'note', null)
  writeFileSync(join(global.root, 'protected/.keep'), 'keep')
  global.delete(protectedNote.path, protectedNote.revision)
  assert.equal(readFileSync(join(global.root, 'protected/.keep'), 'utf8'), 'keep')
  const linkedNote = global.save('linked/note.md', 'note', null)
  mkdirSync(join(root, 'external'))
  writeFileSync(join(root, 'external/keep.md'), 'outside')
  symlinkSync(join(root, 'external'), join(global.root, 'linked/keep'))
  global.delete(linkedNote.path, linkedNote.revision)
  assert.equal(readFileSync(join(root, 'external/keep.md'), 'utf8'), 'outside')
  assert.deepEqual(readdirSync(join(global.root, 'linked')), ['keep'], 'nonempty directories are never recursively removed')
}))

test('create/delete cycles reclaim scan capacity before a new scope writes', () => fixture(files => {
  const global = new MemoryFiles(join(files.root, 'global'), files.root)
  global.save('seed.md', 'keep', null)
  for (let index = 0; index < 1994; index++) mkdirSync(join(files.root, `reserved-${index}`))
  for (let index = 0; index < 10; index++) {
    const note = global.save(`temporary-${index}/nested/note.md`, 'temporary', null)
    global.delete(note.path, note.revision)
    assert.deepEqual(readdirSync(global.root), ['seed.md'])
  }
  const project = new MemoryFiles(join(files.root, 'projects', 'a'.repeat(64)), files.root)
  project.save('first.md', 'new scope still fits', null)
  assert.equal(files.list().length, 2)
}))

test('index line limits ignore one trailing newline but count real blank lines', () => fixture(files => {
  let revision: string | null = null
  for (const newline of ['\n', '\r\n']) {
    for (const trailing of ['', newline]) {
      const content = Array(60).fill('entry').join(newline) + trailing
      const saved = files.save('MEMORY.md', content, revision)
      revision = saved.revision
      assert.equal(files.read('MEMORY.md').content, content)
      assert.throws(() => files.save('MEMORY.md', Array(61).fill('entry').join(newline) + trailing, revision), /60 lines/)
      assert.equal(files.read('MEMORY.md').revision, revision)
    }
    const withBlankLastLine = Array(59).fill('entry').join(newline) + newline + newline
    revision = files.save('MEMORY.md', withBlankLastLine, revision).revision
    assert.throws(() => files.save('MEMORY.md', withBlankLastLine + newline, revision), /60 lines/)
  }
  const exactBytes = 'a\n'.repeat(59) + 'x'.repeat(4096 - 59 * 2 - 1) + '\n'
  revision = files.save('MEMORY.md', exactBytes, revision).revision
  assert.equal(Buffer.byteLength(files.read('MEMORY.md').content), 4096)
  assert.throws(() => files.save('MEMORY.md', exactBytes + 'x', revision), /4 KiB/)
}))

test('Markdown links resolve against their source note and return canonical file paths', () => fixture(files => {
  const note = files.save('testing.md', 'command\nverification', null)
  files.save('guides/start.md', '[Tests](../testing.md)', null)
  for (const [path, from, expected] of [
    ['testing.md', undefined, 'testing.md'],
    ['./testing.md', 'MEMORY.md', 'testing.md'],
    ['../testing.md', 'guides/start.md', 'testing.md'],
    ['./next.md', 'guides/start.md', 'guides/next.md'],
    ['../next.md', 'guides/nested/start.md', 'guides/next.md'],
    ['../../testing.md', 'guides/nested/start.md', 'testing.md']
  ]) assert.equal(resolveMemoryLink(path!, from), expected)
  const page = files.view(resolveMemoryLink('../testing.md', 'guides/start.md'), undefined, 1, 1)
  assert.deepEqual(page.file, { ...note, content: 'verification' })
  const changed = files.save(page.file!.path, 'updated', page.file!.revision)
  files.delete(changed.path, changed.revision)
  assert.equal(files.optional('testing.md'), undefined)
}))

test('relative link resolution cannot escape its scope or bypass existing path/link protection', () => fixture((files, root) => {
  files.save('safe.md', 'safe', null)
  for (const [path, from] of [
    ['../safe.md', undefined],
    ['../../safe.md', 'guides/start.md'],
    ['../notes/safe.md', 'MEMORY.md']
  ]) assert.throws(() => resolveMemoryLink(path!, from), { code: 'MEMORY_LINK_OUTSIDE_SCOPE' })
  for (const path of ['/outside.md', 'https://example.com/note.md', 'file:///outside.md', 'C:\\outside.md', '%2e%2e/outside.md', '.hidden/note.md', 'a//note.md']) {
    assert.throws(() => resolveMemoryLink(path, 'guides/start.md'))
  }
  for (const from of ['../outside.md', '/outside.md', 'guides/../start.md']) {
    assert.throws(() => resolveMemoryLink('safe.md', from))
  }
  mkdirSync(join(root, 'external'))
  writeFileSync(join(root, 'external', 'outside.md'), 'OUTSIDE')
  symlinkSync(join(root, 'external'), join(files.root, 'escape'))
  assert.throws(() => files.read(resolveMemoryLink('./outside.md', 'escape/start.md')))
  assert.equal(files.read('safe.md').content, 'safe')
}))

test('accepted memory writes remain listable at depth and scoped catalog boundaries', () => fixture(files => {
  const deep = Array.from({ length: 9 }, (_, i) => `d${i}`).join('/') + '/note.md'
  assert.throws(() => files.save(deep, 'No', null), { code: 'MEMORY_DEPTH_LIMIT' })
  assert.deepEqual(files.list(), [])
  assert.deepEqual(readdirSync(files.root), [], 'rejected paths must not leave unreadable directories')
  const project = new MemoryFiles(join(files.root, 'projects', 'a'.repeat(64)), files.root)
  const accepted = Array.from({ length: 6 }, (_, i) => `d${i}`).join('/') + '/note.md'
  project.save(accepted, 'depth boundary', null)
  assert.equal(files.list().length, 1)
  assert.equal(project.view(undefined, 'boundary').matches?.length, 1)
  assert.throws(() => project.save('extra/' + accepted, 'No', null), { code: 'MEMORY_DEPTH_LIMIT' })
  assert.equal(files.list().length, 1)
  assert.deepEqual(readdirSync(project.root), ['d0'])
}))

test('memory creation respects the catalog file cap while edits at capacity still work', () => fixture(files => {
  const first = files.save('seed.md', 'original', null)
  for (let i = 1; i < 1000; i++) writeFileSync(join(files.root, `note-${i}.md`), 'note')
  const scoped = new MemoryFiles(join(files.root, 'global'), files.root)
  assert.throws(() => scoped.save('new.md', 'No', null), { code: 'MEMORY_FILE_LIMIT' })
  assert.equal(readdirSync(files.root).length, 1000, 'rejected scoped writes do not create scope directories')
  files.save('seed.md', 'changed', first.revision)
  assert.equal(files.list().length, 1000)
  assert.equal(files.view(undefined, 'changed').matches?.length, 1)
}))

test('memory writes count new directories against the scan-entry cap before creating them', () => fixture(files => {
  const first = files.save('seed.md', 'original', null)
  for (let i = 0; i < 1998; i++) mkdirSync(join(files.root, `d-${i}`))
  assert.throws(() => files.save('new/note.md', 'No', null), { code: 'MEMORY_SCAN_LIMIT' })
  assert.equal(readdirSync(files.root).length, 1999)
  files.save('d-0/note.md', 'boundary', null)
  files.save('seed.md', 'changed', first.revision)
  assert.throws(() => files.save('overflow.md', 'No', null), { code: 'MEMORY_SCAN_LIMIT' })
  assert.equal(files.list().length, 2)
  assert.equal(files.view(undefined, 'boundary').matches?.length, 1)
}))

test('high-match searches retain only a page and stop reading after its lookahead match', () => fixture(files => {
  const content = 'x\n'.repeat(MAX_MEMORY_BYTES / 2)
  for (const path of ['a.md', 'b.md', 'c.md']) files.save(path, content, null)
  const read = files.read.bind(files)
  const reads: string[] = []
  files.read = path => { reads.push(path); return read(path) }
  const page = files.view(undefined, 'X', 0, 1)
  assert.deepEqual(page, { matches: [{ path: 'a.md', line: 1, text: 'x' }], nextOffset: 1 })
  assert.deepEqual(reads, ['a.md'], 'later files are not read merely to build all search results')
  reads.length = 0
  const boundary = files.view(undefined, 'x', MAX_MEMORY_BYTES / 2 - 1, 1)
  assert.deepEqual(boundary.matches, [{ path: 'a.md', line: MAX_MEMORY_BYTES / 2, text: 'x' }])
  assert.equal(boundary.nextOffset, MAX_MEMORY_BYTES / 2)
  assert.deepEqual(reads, ['a.md', 'b.md'])
  const last = files.view(undefined, 'x', MAX_MEMORY_BYTES / 2 * 3 - 1, 1)
  assert.deepEqual(last.matches, [{ path: 'c.md', line: MAX_MEMORY_BYTES / 2, text: 'x' }])
  assert.equal(last.nextOffset, null)
  assert.deepEqual(files.view(undefined, 'absent').matches, [])
}))

test('search byte-limited pages resume without dropping matches', () => fixture(files => {
  files.save('long.md', ('x'.repeat(300) + '\n').repeat(200), null)
  const page = files.view(undefined, 'x', 0, 200)
  assert.ok(page.matches!.length < 200)
  assert.ok(page.matches!.reduce((bytes, match) => bytes + Buffer.byteLength(JSON.stringify(match)), 0) <= 16000)
  const lines = page.matches!.map(match => match.line)
  let next = page.nextOffset
  while (next !== null && next !== undefined) {
    const following = files.view(undefined, 'x', next, 200)
    assert.ok(following.matches!.length > 0)
    lines.push(...following.matches!.map(match => match.line))
    next = following.nextOffset
  }
  assert.deepEqual(lines, Array.from({ length: 200 }, (_, i) => i + 1))
}))

test('Markdown stale recovery is serialized and never steals an active recovery lease', () => fixture(files => {
  files.save('note.md', 'first', null)
  mkdirSync(join(files.root, '.writer'))
  writeFileSync(join(files.root, '.writer', 'pid'), '2147483647')
  mkdirSync(join(files.root, '.writer-recovery'))
  assert.throws(() => files.save('another.md', 'new', null), /recovery is busy/)
  assert.equal(readFileSync(join(files.root, '.writer', 'pid'), 'utf8'), '2147483647')
  rmSync(join(files.root, '.writer-recovery'), { recursive: true })
  files.save('another.md', 'new', null)
  assert.equal(files.read('another.md').content, 'new')
  assert.deepEqual(readdirSync(files.root).sort(), ['another.md', 'note.md'])
}))

test('Markdown directory leases fail closed and do not erase a live writer lease', () => fixture(files => {
  files.save('note.md', 'first', null)
  mkdirSync(join(files.root, '.writer'))
  writeFileSync(join(files.root, '.writer', 'pid'), String(process.pid))
  assert.throws(() => files.save('another.md', 'new', null), /busy/)
  assert.equal(readFileSync(join(files.root, '.writer', 'pid'), 'utf8'), String(process.pid))
}))
