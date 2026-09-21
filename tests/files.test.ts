/**
 * The file tree and the file tabs against a real worktree: what a directory listing holds and in which
 * order, what git's own ignore rules mark, and a draft write that either lands or reports that the file
 * has moved on. The path guard is checked from both sides, because a renderer string is never trusted.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile as readTabFile, externalPath, openablePath, writeFile as writeTabFile } from '../src/main/files/file'
import type { FileStamp } from '../src/shared/api'
import { readLanes } from '../src/main/git/limit'
import { readDirectory } from '../src/main/files/tree'
import { runGit } from '../src/main/git/run'

const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function temp(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  temps.push(root)
  return root
}

async function fixture(): Promise<string> {
  const root = await temp('pig-files-test-')
  await runGit(root, ['init', '-b', 'main'])
  await writeFile(join(root, '.gitignore'), 'dist/\n*.log\n!keep.log\n')
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'main.ts'), 'export const value = 1\n')
  await mkdir(join(root, 'dist'))
  await writeFile(join(root, 'dist', 'bundle.js'), 'built\n')
  await writeFile(join(root, 'readme.md'), '# hi\n')
  await writeFile(join(root, 'skip.log'), 'noise\n')
  await writeFile(join(root, 'keep.log'), 'kept\n')
  return root
}

/** The stamp a write is compared against, for the cases that only care about the write itself. */
async function stampOf(root: string, path: string): Promise<FileStamp> {
  const read = await readTabFile(root, path)
  if (read.kind !== 'text') throw new Error(`expected text, read ${read.kind}`)
  return read
}

describe('readDirectory', () => {
  test('lists one level with directories first, then files, each by name', async () => {
    const root = await fixture()
    const listing = await readDirectory(root, '')
    expect(listing.path).toBe('')
    expect(listing.entries.map((entry) => entry.name)).toEqual([
      'dist',
      'src',
      '.gitignore',
      'keep.log',
      'readme.md',
      'skip.log'
    ])
    expect(listing.entries.map((entry) => entry.kind)).toEqual([
      'directory',
      'directory',
      'file',
      'file',
      'file',
      'file'
    ])
  })

  test('marks what git ignores and leaves a negated pattern alone', async () => {
    const root = await fixture()
    const ignored = new Map((await readDirectory(root, '')).entries.map((e) => [e.name, e.ignored]))
    expect(ignored.get('dist')).toBe(true)
    expect(ignored.get('skip.log')).toBe(true)
    expect(ignored.get('keep.log')).toBe(false)
    expect(ignored.get('src')).toBe(false)
  })

  test('reads a nested level with worktree-relative paths', async () => {
    const root = await fixture()
    const listing = await readDirectory(root, 'src')
    expect(listing.path).toBe('src')
    expect(listing.entries).toEqual([
      { name: 'main.ts', path: 'src/main.ts', kind: 'file', ignored: false }
    ])
  })

  test('never lists the git directory', async () => {
    const root = await fixture()
    const names = (await readDirectory(root, '')).entries.map((entry) => entry.name)
    expect(names).not.toContain('.git')
  })

  test('still lists a directory that is not a repository at all', async () => {
    const root = await temp('pig-files-plain-')
    await mkdir(join(root, 'sub'))
    await writeFile(join(root, 'a.txt'), 'a\n')
    const listing = await readDirectory(root, '')
    expect(listing.entries.map((entry) => entry.name)).toEqual(['sub', 'a.txt'])
    expect(listing.entries.every((entry) => !entry.ignored)).toBe(true)
  })

  test('shows a link as a link instead of what it points at', async () => {
    const root = await fixture()
    const outside = await temp('pig-files-outside-')
    await writeFile(join(outside, 'secret.txt'), 'secret\n')
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'))
    const entry = (await readDirectory(root, '')).entries.find((item) => item.name === 'link.txt')
    expect(entry?.kind).toBe('link')
  })

  test('refuses a path outside the worktree', async () => {
    const root = await fixture()
    await expect(readDirectory(root, '../')).rejects.toThrow('目录不在工作区内')
    await expect(readDirectory(root, '/etc')).rejects.toThrow('目录不在工作区内')
  })
})

describe('readFile', () => {
  test('reads a file with the stamp a later write is compared against', async () => {
    const root = await fixture()
    const result = await readTabFile(root, 'src/main.ts')
    expect(result).toEqual({
      kind: 'text',
      contents: 'export const value = 1\n',
      mtimeMs: expect.any(Number),
      size: 23
    })
  })

  test('reports a missing file, a link and a directory as what they are', async () => {
    const root = await fixture()
    await symlink('/etc/hosts', join(root, 'hosts-link'))
    expect(await readTabFile(root, 'nope.txt')).toEqual({ kind: 'missing' })
    expect(await readTabFile(root, 'src')).toEqual({ kind: 'missing' })
    expect(await readTabFile(root, '../outside.txt')).toEqual({ kind: 'missing' })
    expect(await readTabFile(root, 'hosts-link')).toEqual({ kind: 'link' })
  })

  test('refuses binary bytes and anything past the cap', async () => {
    const root = await fixture()
    await writeFile(join(root, 'blob.bin'), Buffer.from([1, 0, 2, 3]))
    expect(await readTabFile(root, 'blob.bin')).toEqual({ kind: 'binary', size: 4 })
    await writeFile(join(root, 'big.txt'), 'x'.repeat(2 * 1024 * 1024 + 10))
    expect(await readTabFile(root, 'big.txt')).toEqual({ kind: 'too-large', size: 2 * 1024 * 1024 + 10 })
  })

  // Reads go through the pool the untracked cards use, so a change event that re-reads every open tab
  // asks for more than the pool has lanes. Every one of them still has to answer: a lane that is never
  // handed back would leave the rest waiting for good.
  test('answers a burst of reads, refusals among them', async () => {
    const root = await fixture()
    const names = Array.from({ length: 20 }, (_, index) => `many/${index}.txt`)
    await mkdir(join(root, 'many'))
    await Promise.all(names.map((name) => writeFile(join(root, name), `${name}\n`)))
    await writeFile(join(root, 'blob.bin'), Buffer.from([1, 0, 2, 3]))

    const results = await Promise.all(names.map((name) => readTabFile(root, name)))
    expect(results.map((result) => (result.kind === 'text' ? result.contents : result.kind))).toEqual(
      names.map((name) => `${name}\n`)
    )

    // The refusals take their own lanes and still leave one for the reads around them.
    const mixed = await Promise.all([
      readTabFile(root, 'blob.bin'),
      readTabFile(root, 'many/1.txt'),
      readTabFile(root, 'nope.txt'),
      readTabFile(root, 'many/2.txt')
    ])
    expect(mixed.map((result) => result.kind)).toEqual(['binary', 'text', 'missing', 'text'])
  })

  // The pool is only a budget if the reads are actually in it: a read that takes a lane has to wait for
  // one like an untracked card does, rather than allocating its buffer off the books.
  test('waits for a lane before it reads', async () => {
    const root = await fixture()
    const release: (() => void)[] = []
    const held = Array.from({ length: 4 }, () =>
      readLanes.run(() => new Promise<void>((resolve) => release.push(resolve)))
    )

    let settled = false
    const read = readTabFile(root, 'readme.md').then((result) => {
      settled = true
      return result
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(settled).toBe(false)

    for (const done of release) done()
    await Promise.all(held)
    const result = await Promise.race([
      read,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the read never got its lane back')), 2000))
    ])
    expect(result.kind).toBe('text')
  })
})

describe('links inside the worktree', () => {
  async function linked(): Promise<{ root: string; outside: string }> {
    const root = await fixture()
    const outside = await temp('pig-files-outside-')
    await writeFile(join(outside, 'secret.txt'), 'outside secret\n')
    await mkdir(join(root, 'notes'))
    await writeFile(join(root, 'notes', 'note.txt'), 'inside note\n')
    await writeFile(join(root, 'notes', 'skip.log'), 'ignored here\n')
    // The linked level carries ignore rules of its own, so a listing that has to skip asking about
    // `linkin/…` (a pathspec git refuses) would show `skip.log` undimmed and prove itself wrong.
    await writeFile(join(root, 'notes', '.gitignore'), '*.log\n')
    await symlink(outside, join(root, 'linkdir'))
    await symlink(join(root, 'notes'), join(root, 'linkin'))
    return { root, outside }
  }

  // The last segment is the easy one: lstat sees the link and O_NOFOLLOW refuses it at the open. A link
  // in the middle of the path is the one that used to be followed all the way out of the worktree.
  test('a directory link out of the worktree is no way out for reads, listings or writes', async () => {
    const { root, outside } = await linked()
    expect(await readTabFile(root, 'linkdir/secret.txt')).toEqual({ kind: 'missing' })
    await expect(readDirectory(root, 'linkdir')).rejects.toThrow('目录不在工作区内')
    await expect(writeTabFile(root, 'linkdir/secret.txt', 'stolen\n', {})).rejects.toThrow(
      '文件不在工作区内'
    )
    await expect(externalPath(root, 'linkdir/secret.txt')).rejects.toThrow('文件不在工作区内')
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('outside secret\n')
  })

  test('a directory link that stays inside the worktree is still a way in', async () => {
    const { root } = await linked()
    const read = await readTabFile(root, 'linkin/note.txt')
    expect(read).toEqual({
      kind: 'text',
      contents: 'inside note\n',
      mtimeMs: expect.any(Number),
      size: 12
    })
    // The rules inside the linked directory still answer. Git is asked about names in the directory
    // being listed rather than about paths that walk through the link, which it refuses to look at.
    const entries = (await readDirectory(root, 'linkin')).entries
    expect(entries.map((entry) => entry.name)).toEqual(['.gitignore', 'note.txt', 'skip.log'])
    expect(entries.find((entry) => entry.name === 'skip.log')?.ignored).toBe(true)
    expect(entries.find((entry) => entry.name === 'note.txt')?.ignored).toBe(false)
  })

  // Opening a file hands its path to another app, and that app follows a link at the last segment. The
  // reveal path may: showing a file manager a link is not putting the file behind it in front of anyone.
  test('the desktop is not handed a link to open', async () => {
    const { root, outside } = await linked()
    const link = join(root, 'secret-link.txt')
    await symlink(join(outside, 'secret.txt'), link)

    expect(await externalPath(root, 'secret-link.txt')).toBe(link)
    await expect(openablePath(root, 'secret-link.txt')).rejects.toThrow('这是符号链接，不跟随')
    expect(await openablePath(root, 'notes/note.txt')).toBe(join(root, 'notes', 'note.txt'))
    // Nothing there is not a link: the desktop gets the path and says for itself that it cannot open it.
    expect(await openablePath(root, 'gone.txt')).toBe(join(root, 'gone.txt'))
    await expect(openablePath(root, 'linkdir/secret.txt')).rejects.toThrow('文件不在工作区内')
  })

  // A worktree is routinely reached through a link itself (`/tmp` on macOS, a symlinked checkout): the
  // guard resolves the root before it compares, so the worktree does not become an escape from itself.
  test('walks into a worktree whose own path is a link', async () => {
    const { root } = await linked()
    const alias = join(await temp('pig-files-alias-'), 'worktree')
    await symlink(root, alias)
    expect((await readTabFile(alias, 'notes/note.txt')).kind).toBe('text')
    expect((await readDirectory(alias, '')).entries.map((entry) => entry.name)).toContain('notes')
  })
})

describe('writeFile', () => {
  test('replaces the file and answers with its new stamp', async () => {
    const root = await fixture()
    const read = await stampOf(root, 'src/main.ts')
    const written = await writeTabFile(root, 'src/main.ts', 'export const value = 2\n', { expected: read })
    expect(written.kind).toBe('written')
    expect(await readFile(join(root, 'src/main.ts'), 'utf8')).toBe('export const value = 2\n')
    expect(await readTabFile(root, 'src/main.ts')).toEqual({
      kind: 'text',
      contents: 'export const value = 2\n',
      mtimeMs: written.kind === 'written' ? written.mtimeMs : -1,
      size: 'export const value = 2\n'.length
    })
  })

  test('keeps the file own mode, so a script stays executable', async () => {
    const root = await fixture()
    const script = join(root, 'run.sh')
    await writeFile(script, '#!/bin/sh\necho one\n', { mode: 0o755 })
    const read = await stampOf(root, 'run.sh')
    await writeTabFile(root, 'run.sh', '#!/bin/sh\necho two\n', { expected: read })
    expect((await stat(script)).mode & 0o777).toBe(0o755)
  })

  test('leaves no temporary file behind', async () => {
    const root = await fixture()
    const read = await stampOf(root, 'readme.md')
    await writeTabFile(root, 'readme.md', '# bye\n', { expected: read })
    const names = (await readDirectory(root, '')).entries.map((entry) => entry.name)
    expect(names.filter((name) => name.startsWith('.pig-'))).toEqual([])
  })

  test('answers conflict when the file moved on since the draft was read', async () => {
    const root = await fixture()
    const read = await stampOf(root, 'readme.md')
    await writeFile(join(root, 'readme.md'), '# changed elsewhere\n')
    await utimes(join(root, 'readme.md'), new Date(), new Date(Date.now() + 1000))
    expect(await writeTabFile(root, 'readme.md', '# mine\n', { expected: read })).toEqual({
      kind: 'conflict'
    })
    expect(await readFile(join(root, 'readme.md'), 'utf8')).toBe('# changed elsewhere\n')
  })

  test('answers conflict when the file is gone, and writes anyway when asked to', async () => {
    const root = await fixture()
    const read = await stampOf(root, 'readme.md')
    await rm(join(root, 'readme.md'))
    expect(await writeTabFile(root, 'readme.md', '# back\n', { expected: read })).toEqual({
      kind: 'conflict'
    })
    expect(await writeTabFile(root, 'readme.md', '# back\n', { expected: read, overwrite: true })).toEqual(
      { kind: 'written', mtimeMs: expect.any(Number), size: 7 }
    )
    expect(await readFile(join(root, 'readme.md'), 'utf8')).toBe('# back\n')
  })

  test('never writes through a link, or outside the worktree', async () => {
    const root = await fixture()
    const outside = await temp('pig-files-outside-')
    const secret = join(outside, 'secret.txt')
    await writeFile(secret, 'secret\n')
    await symlink(secret, join(root, 'link.txt'))
    await expect(writeTabFile(root, 'link.txt', 'stolen\n', {})).rejects.toThrow('符号链接不写入')
    await expect(writeTabFile(root, '../escape.txt', 'nope\n', {})).rejects.toThrow('文件不在工作区内')
    expect(await readFile(secret, 'utf8')).toBe('secret\n')
  })
})
