import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, appendFile, chmod, mkdir, open, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  countLines,
  parseNumstat,
  parseStatus,
  readUntrackedFile,
  readWorktreeDiff,
  readWorktreePatch,
  untrackedReadFailure
} from '../src/main/git/diff'
import { runGit } from '../src/main/git/run'
import { isMissingError } from '../src/main/files/read'

const NUL = '\0'
const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function emptyFixture(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pig-diff-unborn-')))
  temps.push(root)
  await runGit(root, ['init', '-b', 'main'])
  return root
}

async function fixture(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pig-diff-test-')))
  temps.push(root)
  await runGit(root, ['init', '-b', 'main'])
  await writeFile(join(root, 'modify.txt'), 'a\nb\nc\n')
  await writeFile(join(root, 'stage.txt'), 'x\n')
  await writeFile(join(root, 'rename-me.txt'), 'rename\n')
  await writeFile(join(root, 'delete.txt'), 'gone\n')
  await writeFile(join(root, 'both.txt'), 'old\n')
  await writeFile(join(root, 'binary.dat'), Buffer.from([0, 1, 2, 3, 0, 4]))
  await mkdir(join(root, 'dir'))
  await writeFile(join(root, 'dir', 'nested.txt'), 'nested\n')
  await runGit(root, ['add', '-A'])
  await runGit(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base'])
  return root
}

describe('parseStatus', () => {
  test('splits a file dirty on both sides into its index and worktree entries', () => {
    const entries = parseStatus(`MM both.txt${NUL} M modify.txt${NUL}M  stage.txt${NUL}`)
    expect(entries).toEqual([
      { path: 'both.txt', origPath: undefined, status: 'modified', staged: true },
      { path: 'both.txt', origPath: undefined, status: 'modified', staged: false },
      { path: 'modify.txt', origPath: undefined, status: 'modified', staged: false },
      { path: 'stage.txt', origPath: undefined, status: 'modified', staged: true }
    ])
  })

  test('reads the second field of a rename record as the original path', () => {
    expect(parseStatus(`R  renamed.txt${NUL}rename-me.txt${NUL}`)).toEqual([
      { path: 'renamed.txt', origPath: 'rename-me.txt', status: 'renamed', staged: true }
    ])
  })

  test('consumes the original path of a worktree copy before the next record', () => {
    expect(parseStatus(` C copied.txt${NUL}source.txt${NUL} M next.txt${NUL}`)).toEqual([
      { path: 'copied.txt', origPath: 'source.txt', status: 'added', staged: false },
      { path: 'next.txt', origPath: undefined, status: 'modified', staged: false }
    ])
  })

  test('keeps untracked files on the worktree side and conflicts unresolved', () => {
    expect(parseStatus(`?? untracked.txt${NUL}UU conflicted.txt${NUL}D  gone.txt${NUL}`)).toEqual([
      { path: 'untracked.txt', origPath: undefined, status: 'untracked', staged: false },
      { path: 'conflicted.txt', origPath: undefined, status: 'conflicted', staged: false },
      { path: 'gone.txt', origPath: undefined, status: 'deleted', staged: true }
    ])
  })

  test('skips empty records between entries', () => {
    expect(parseStatus(`M  a.txt${NUL}${NUL}`)).toEqual([
      { path: 'a.txt', origPath: undefined, status: 'modified', staged: true }
    ])
  })
})

describe('parseNumstat', () => {
  test('reads counts and marks binary files unknown', () => {
    expect(parseNumstat(`1\t2\ta.txt${NUL}-\t-\tbin.dat${NUL}`)).toEqual([
      { path: 'a.txt', origPath: undefined, additions: 1, deletions: 2 },
      { path: 'bin.dat', origPath: undefined, additions: null, deletions: null }
    ])
  })

  test('reads the old and new path of a rename record', () => {
    expect(parseNumstat(`3\t4\t\0old.txt${NUL}new.txt${NUL}`)).toEqual([
      { path: 'new.txt', origPath: 'old.txt', additions: 3, deletions: 4 }
    ])
  })
})

describe('countLines', () => {
  test('counts the last line without a trailing newline', () => {
    expect(countLines('')).toBe(0)
    expect(countLines('a\n')).toBe(1)
    expect(countLines('a\nb')).toBe(2)
    expect(countLines('a\n\n')).toBe(2)
  })
})

describe('readWorktreeDiff', () => {
  test('reports no git for a plain directory', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pig-diff-plain-')))
    temps.push(root)
    expect(await readWorktreeDiff(root)).toEqual({ git: false, staged: [], unstaged: [], all: [] })
  })

  test('does not disguise an inaccessible worktree as a plain directory', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pig-diff-missing-')))
    temps.push(root)
    await expect(readWorktreeDiff(join(root, 'gone'))).rejects.toThrow(/cannot change to|No such file/i)
    await expect(readWorktreePatch(join(root, 'gone'), 'all')).rejects.toThrow(/cannot change to|No such file/i)
  })

  // A repository that has never been committed to — a fresh `git init`, a worktree added with
  // `--orphan` — has an unborn HEAD, and `git diff HEAD` refuses to guess what that means. Everything
  // in it is new by definition, so the empty tree is what it is compared against.
  test('reads a repository whose first commit has not been made', async () => {
    const root = await emptyFixture()
    await writeFile(join(root, 'staged.ts'), 'export const staged = 1\n')
    await writeFile(join(root, 'loose.ts'), 'export const loose = 2\n')
    await runGit(root, ['add', 'staged.ts'])
    // Staged and then written to again: with nothing committed, index and worktree are both all new.
    await writeFile(join(root, 'staged.ts'), 'export const staged = 1\nexport const more = 3\n')

    const diff = await readWorktreeDiff(root)
    expect(diff.git).toBe(true)
    expect(diff.staged.map((file) => [file.path, file.status])).toEqual([['staged.ts', 'added']])
    // git lists tracked changes before untracked ones, and this list keeps that order.
    expect(diff.unstaged.map((file) => [file.path, file.status])).toEqual([
      ['staged.ts', 'modified'],
      ['loose.ts', 'untracked']
    ])
    expect(diff.all.map((file) => file.path)).toEqual(['loose.ts', 'staged.ts'])
    // The path-wide counts come from the empty tree, so they hold both lines the file now has.
    expect(diff.all.find((file) => file.path === 'staged.ts')?.additions).toBe(2)

    expect((await readWorktreePatch(root, 'all')).patch).toContain('diff --git a/staged.ts b/staged.ts')
    expect((await readWorktreePatch(root, 'staged')).patch).toContain('diff --git a/staged.ts b/staged.ts')
  })

  test('separates the staged and worktree sides and counts one row per path', async () => {
    const root = await fixture()
    await writeFile(join(root, 'modify.txt'), 'a\nB\nc\n')
    await writeFile(join(root, 'stage.txt'), 'x\nmore\n')
    await runGit(root, ['add', 'stage.txt'])
    await runGit(root, ['mv', 'rename-me.txt', 'renamed.txt'])
    await runGit(root, ['rm', '-q', 'delete.txt'])
    await writeFile(join(root, 'both.txt'), 'old\nnew\n')
    await runGit(root, ['add', 'both.txt'])
    await writeFile(join(root, 'both.txt'), 'old\nnew\nmore\n')
    await writeFile(join(root, 'untracked.txt'), 'brand\nnew\n')
    // An untracked row's counts come from reading its card, never from the refresh itself.
    await readUntrackedFile(root, 'untracked.txt')

    const diff = await readWorktreeDiff(root)
    expect(diff.git).toBe(true)
    expect(diff.staged.map((file) => [file.path, file.status, file.additions, file.deletions])).toEqual([
      ['both.txt', 'modified', 1, 0],
      ['delete.txt', 'deleted', 0, 1],
      ['renamed.txt', 'renamed', 0, 0],
      ['stage.txt', 'modified', 1, 0]
    ])
    expect(diff.staged.find((file) => file.path === 'renamed.txt')?.origPath).toBe('rename-me.txt')
    expect(diff.unstaged.map((file) => [file.path, file.status, file.additions, file.deletions])).toEqual([
      ['both.txt', 'modified', 1, 0],
      ['modify.txt', 'modified', 1, 1],
      ['untracked.txt', 'untracked', 2, 0]
    ])
    expect(diff.all.map((file) => [file.path, file.additions, file.deletions])).toEqual([
      ['both.txt', 2, 0],
      ['delete.txt', 0, 1],
      ['modify.txt', 1, 1],
      ['renamed.txt', 0, 0],
      ['stage.txt', 1, 0],
      ['untracked.txt', 2, 0]
    ])
  })

  test('leaves counts unknown for a binary file and counts nothing for an ignored one', async () => {
    const root = await fixture()
    await writeFile(join(root, 'binary.dat'), Buffer.from([0, 9, 9, 0, 7]))
    await writeFile(join(root, '.gitignore'), 'ignored.txt\n')
    await writeFile(join(root, 'ignored.txt'), 'nope\n')

    const diff = await readWorktreeDiff(root)
    const binary = diff.all.find((file) => file.path === 'binary.dat')
    expect(binary?.additions).toBeNull()
    expect(diff.all.some((file) => file.path === 'ignored.txt')).toBe(false)
    expect(diff.unstaged.some((file) => file.path === '.gitignore')).toBe(true)
  })
})

describe('readWorktreePatch', () => {
  test('covers every changed file in one HEAD-to-worktree patch', async () => {
    const root = await fixture()
    await writeFile(join(root, 'both.txt'), 'old\nnew\n')
    await runGit(root, ['add', 'both.txt'])
    await writeFile(join(root, 'both.txt'), 'old\nnew\nmore\n')
    await writeFile(join(root, 'modify.txt'), 'a\nB\nc\n')
    await rm(join(root, 'delete.txt'))

    const result = await readWorktreePatch(root, 'all')
    expect(result.git).toBe(true)
    // Staged and unstaged edits of one file meet in a HEAD-to-worktree patch, which is the point.
    expect(result.patch).toContain('+new\n+more')
    expect(result.patch).toContain('diff --git a/modify.txt b/modify.txt')
    expect(result.patch).toContain('diff --git a/delete.txt b/delete.txt')
    expect(result.truncated).toBe(false)
  })

  test('leaves untracked files out of the patch and reads them one card at a time', async () => {
    const root = await fixture()
    await writeFile(join(root, 'untracked.txt'), 'brand\nnew\n')

    const result = await readWorktreePatch(root, 'all')
    expect(result.patch).not.toContain('untracked.txt')
    expect(await readUntrackedFile(root, 'untracked.txt')).toEqual({
      kind: 'text',
      contents: 'brand\nnew\n',
      lines: 2
    })
  })

  // The path of a card read arrives from the renderer, so it has to stay inside the worktree.
  test('refuses an untracked read that leaves the worktree', async () => {
    const root = await fixture()
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'pig-diff-outside-')))
    temps.push(outside)
    await writeFile(join(outside, 'secret.txt'), 'PRIVATE\n')
    // A link to the directory is the one O_NOFOLLOW cannot see: it holds the last segment, and the link
    // is a level above it.
    await symlink(outside, join(root, 'outdir'))

    expect(await readUntrackedFile(root, '../secret.txt')).toEqual({ kind: 'missing' })
    expect(await readUntrackedFile(root, join(outside, 'secret.txt'))).toEqual({ kind: 'missing' })
    expect(await readUntrackedFile(root, 'outdir/secret.txt')).toEqual({ kind: 'missing' })
    expect(await readUntrackedFile(root, 'modify.txt')).toEqual({
      kind: 'text',
      contents: 'a\nb\nc\n',
      lines: 3
    })
  })

  // Reading through a link would hand the panel whatever it points at, which is a file the worktree
  // does not own: the link itself is the change, exactly as git stores a tracked one.
  test('reads a symlink as its target path, not the file it points at', async () => {
    const root = await fixture()
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'pig-diff-outside-')))
    temps.push(outside)
    const key = join(outside, 'id_rsa')
    await writeFile(key, 'PRIVATE KEY BODY\n')
    await writeFile(join(root, 'sibling.txt'), 'sibling body\n')
    await symlink(key, join(root, 'key-link'))
    await symlink('sibling.txt', join(root, 'sibling-link'))

    expect(await readUntrackedFile(root, 'key-link')).toEqual({ kind: 'text', contents: key, lines: 1 })
    expect(await readUntrackedFile(root, 'sibling-link')).toEqual({
      kind: 'text',
      contents: 'sibling.txt',
      lines: 1
    })
    expect(await readUntrackedFile(root, 'sibling.txt')).toEqual({
      kind: 'text',
      contents: 'sibling body\n',
      lines: 1
    })

    // The row counts the link text, one line, rather than the length of what it points at.
    const diff = await readWorktreeDiff(root)
    expect(diff.unstaged.find((file) => file.path === 'key-link')).toMatchObject({
      status: 'untracked',
      additions: 1,
      deletions: 0
    })
    expect(diff.unstaged.find((file) => file.path === 'sibling-link')).toMatchObject({ additions: 1 })
  })

  test('reports the read that refused a link instead of dropping the row', () => {
    expect(untrackedReadFailure({ code: 'ELOOP' })).toEqual({ kind: 'blocked' })
    expect(untrackedReadFailure({ code: 'ENOENT' })).toEqual({ kind: 'missing' })
    expect(untrackedReadFailure({ code: 'ENOTDIR' })).toEqual({ kind: 'missing' })
  })

  test('tells a path that is not there from a read that failed', () => {
    // One errno list for both the read and the count validation: only these two mean "not there".
    expect(isMissingError({ code: 'ENOENT' })).toBe(true)
    expect(isMissingError({ code: 'ENOTDIR' })).toBe(true)
    expect(isMissingError({ code: 'EACCES' })).toBe(false)
    expect(isMissingError({ code: 'ELOOP' })).toBe(false)
    expect(isMissingError({ code: 'EMFILE' })).toBe(false)
    expect(isMissingError(new Error('boom'))).toBe(false)
  })

  test('answers every card that asks at once', async () => {
    const root = await fixture()
    const names = Array.from({ length: 12 }, (_, index) => `many-${index}.txt`)
    await Promise.all(names.map((name) => writeFile(join(root, name), `${name}\n`)))

    // Twelve reads is more than the lanes there are: the pool has to hand every caller its own answer.
    const results = await Promise.all(names.map((name) => readUntrackedFile(root, name)))
    expect(results.map((result) => (result.kind === 'text' ? result.contents.trim() : result.kind))).toEqual(
      names
    )
  })

  test('lets a read that failed for any other reason through to the card', async () => {
    // Only a file that is gone is `missing`; a permission or a spent descriptor table has to be reported.
    expect(() => untrackedReadFailure({ code: 'EACCES' })).toThrow()
    expect(() => untrackedReadFailure({ code: 'EMFILE' })).toThrow()
    expect(() => untrackedReadFailure(new Error('boom'))).toThrow()

    if (process.getuid?.() === 0) return
    const root = await fixture()
    await writeFile(join(root, 'locked.txt'), 'TOP SECRET\n')
    await chmod(join(root, 'locked.txt'), 0o000)
    await expect(readUntrackedFile(root, 'locked.txt')).rejects.toThrow()
    await chmod(join(root, 'locked.txt'), 0o644)
    expect(await readUntrackedFile(root, 'locked.txt')).toEqual({ kind: 'text', contents: 'TOP SECRET\n', lines: 1 })
  })

  test('reads exactly the cap and refuses one byte past it', async () => {
    const root = await fixture()
    const cap = 1024 * 1024
    await writeFile(join(root, 'at-cap.txt'), 'x'.repeat(cap - 1) + '\n')
    await writeFile(join(root, 'over-cap.txt'), 'x'.repeat(cap) + '\n')

    expect(await readUntrackedFile(root, 'at-cap.txt')).toEqual({ kind: 'text', contents: 'x'.repeat(cap - 1) + '\n', lines: 1 })
    expect(await readUntrackedFile(root, 'over-cap.txt')).toEqual({ kind: 'too-large', bytes: cap + 1 })
  })

  test('holds that cap while the file grows under the read', async () => {
    const root = await fixture()
    const target = join(root, 'growing.txt')
    const cap = 1024 * 1024
    // Under the cap when the lstat sees it, over it by the time the read gets there: the old readFile
    // followed the file and handed the renderer as much as the writer managed to write.
    await writeFile(target, 'x'.repeat(900 * 1024))

    const check = async () => {
      const result = await readUntrackedFile(root, 'growing.txt')
      if (result.kind !== 'text') {
        expect(result).toMatchObject({ kind: 'too-large' })
        return
      }
      expect(result.contents.length).toBeLessThanOrEqual(cap)
      expect(result.lines).toBe(countLines(result.contents))
    }

    // One read of the small file first, then the same read with a writer pushing the file past the cap
    // underneath it: whichever side of the cap the lstat lands on, a read never brings back more.
    await check()
    const handle = await open(target, 'a')
    const chunk = Buffer.alloc(2 * 1024 * 1024, 0x61)
    let writing = true
    const writer = (async () => {
      for (let round = 0; round < 20 && writing; round++) {
        await handle.write(chunk)
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    })()

    try {
      for (let attempt = 0; attempt < 30; attempt++) await check()
    } finally {
      writing = false
      await writer
      await handle.close()
    }
  })

  test('reports an untracked binary as unreadable rather than as contents', async () => {
    const root = await fixture()
    await writeFile(join(root, 'fresh.dat'), Buffer.from([0, 9, 9, 0, 7]))
    await writeFile(join(root, 'binary.dat'), Buffer.from([0, 9, 9, 0, 7]))

    expect(await readUntrackedFile(root, 'fresh.dat')).toEqual({ kind: 'binary' })
    // A tracked binary has no hunk either, but git still names it in the patch.
    const result = await readWorktreePatch(root, 'all')
    expect(result.patch).toContain('Binary files a/binary.dat and b/binary.dat differ')
  })

  test('refuses a patch past the size cap and stops at a file boundary', async () => {
    const root = await fixture()
    // Two files just under the cap: the cut has to land between them, not inside a hunk.
    const lines = (start: string) =>
      Array.from({ length: 90_000 }, (_, index) => `${start}${'x'.repeat(50)}-${index}`).join('\n')
    await writeFile(join(root, 'modify.txt'), `${lines('a')}\n`)
    await writeFile(join(root, 'stage.txt'), `${lines('b')}\n`)

    const result = await readWorktreePatch(root, 'all')
    expect(result.truncated).toBe(true)
    expect(result.patch.endsWith('\n')).toBe(true)
    expect(result.patch).toContain('diff --git a/modify.txt b/modify.txt')
    expect(result.patch).not.toContain('diff --git a/stage.txt b/stage.txt')
    expect(result.patch.length).toBeLessThan(8 * 1024 * 1024)
  })

  test('reads the index and the worktree as their own diffs', async () => {
    const root = await fixture()
    await writeFile(join(root, 'both.txt'), 'one\ntwo\n')
    await runGit(root, ['add', 'both.txt'])
    await writeFile(join(root, 'both.txt'), 'one\ntwo\nthree\n')

    // The index holds one line more than HEAD, the worktree one line more than the index: the three
    // scopes are three different diffs, not the same one filtered three ways.
    const staged = await readWorktreePatch(root, 'staged')
    expect(staged.patch).toContain('+two')
    expect(staged.patch).not.toContain('+three')
    const unstaged = await readWorktreePatch(root, 'unstaged')
    expect(unstaged.patch).toContain('+three')
    expect(unstaged.patch).not.toContain('+two')
    expect((await readWorktreePatch(root, 'all')).patch).toContain('+two\n+three')

    // Untracked files are in no scope's patch: they are read per card, so no scope carries them.
    await writeFile(join(root, 'fresh.txt'), 'new\n')
    for (const scope of ['staged', 'unstaged', 'all'] as const) {
      expect((await readWorktreePatch(root, scope)).patch).not.toContain('fresh.txt')
    }
    expect(await readUntrackedFile(root, 'fresh.txt')).toEqual({ kind: 'text', contents: 'new\n', lines: 1 })
  })

  test('a non-repository says so instead of returning a patch', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pig-diff-plain-')))
    temps.push(root)
    expect(await readWorktreePatch(root, 'all')).toEqual({
      git: false,
      patch: '',
      truncated: false
    })
  })
})

describe('untracked line counts', () => {
  const MIB = 1024 * 1024

  /** Files of exactly one line, so 1 is the only correct count for each of them. */
  const writeBulk = async (root: string, count: number) => {
    const body = 'x'.repeat(MIB - 1) + '\n'
    await Promise.all(
      Array.from({ length: count }, (_, index) =>
        writeFile(join(root, `gen-${String(index).padStart(3, '0')}.txt`), body)
      )
    )
  }

  // Counting lines means reading the file, so a refresh never reads one the reader has not opened:
  // an untracked row carries a number only once its card has been read, and that read is where it comes
  // from. A worktree of generated files costs a refresh nothing until somebody looks at one of them.
  test('leaves the counts unknown until the file has been read', async () => {
    const root = await fixture()
    await writeBulk(root, 12)

    const first = await readWorktreeDiff(root)
    expect(first.unstaged.length).toBe(12)
    expect(first.unstaged.every((file) => file.additions === null && file.deletions === null)).toBe(true)

    expect(await readUntrackedFile(root, 'gen-000.txt')).toEqual({
      kind: 'text',
      contents: `${'x'.repeat(MIB - 1)}\n`,
      lines: 1
    })
    const next = await readWorktreeDiff(root)
    expect(next.unstaged.filter((file) => file.additions === 1).map((file) => file.path)).toEqual(['gen-000.txt'])
  })

  test('drops a count whose file changed rather than showing a stale number', async () => {
    const root = await fixture()
    await writeFile(join(root, 'gen-moved.txt'), 'one\ntwo\nthree\n')
    await readUntrackedFile(root, 'gen-moved.txt')
    expect((await readWorktreeDiff(root)).unstaged[0]).toMatchObject({ additions: 3, deletions: 0 })

    await writeFile(join(root, 'gen-moved.txt'), 'one\ntwo\nthree\nfour\n')
    expect((await readWorktreeDiff(root)).unstaged[0]).toMatchObject({ additions: null, deletions: null })
  })

  // Same size, same mtime, other contents: the count stands, because that pair is what a count is
  // keyed by — the same blind spot git's own index has.
  test('keeps a count when the write leaves the size and mtime alone', async () => {
    const root = await fixture()
    const path = join(root, 'gen-same.txt')
    await writeFile(path, 'one\ntwo\nthree\n')
    await readUntrackedFile(root, 'gen-same.txt')

    const { atimeMs, mtimeMs } = await stat(path)
    await writeFile(path, 'four\nfive\nsix\n')
    // Seconds as floats, because the pair the count is keyed by is the millisecond one lstat reports.
    await utimes(path, atimeMs / 1000, mtimeMs / 1000)
    expect((await readWorktreeDiff(root)).unstaged[0]).toMatchObject({ additions: 3 })
  })

  // Reading one file says nothing about its neighbours, however many there are.
  test('counts exactly the files that were read', async () => {
    const root = await fixture()
    await writeBulk(root, 12)
    await readUntrackedFile(root, 'gen-005.txt')

    const diff = await readWorktreeDiff(root)
    expect(diff.unstaged.filter((file) => file.additions !== null).map((file) => file.path)).toEqual(['gen-005.txt'])
  })

  // The validation runs a lane at a time over a cache every refresh shares, so several refreshes can be
  // inside it at once and the first to reach an entry deletes it. The others must notice that instead of
  // reading `undefined`, and must not delete an entry written after they looked at it.
  test('survives refreshes that invalidate the same cache at once', async () => {
    const root = await fixture()
    const names = Array.from({ length: 200 }, (_, index) => `gen-race-${String(index).padStart(3, '0')}.txt`)
    await Promise.all(names.map((name) => writeFile(join(root, name), `${name}\n`)))
    for (const name of names) await readUntrackedFile(root, name)

    // Every cached count is stale now, so each refresh deletes as it validates.
    await Promise.all(names.map((name) => appendFile(join(root, name), '// moved\n')))

    const settled = await Promise.allSettled(Array.from({ length: 8 }, () => readWorktreeDiff(root)))
    expect(settled.filter((result) => result.status === 'rejected').map((result) => String(result.reason))).toEqual(
      []
    )

    const counts = new Map((await readWorktreeDiff(root)).unstaged.map((file) => [file.path, file.additions]))
    expect(counts.get('gen-race-000.txt')).toBeNull()
    expect(counts.get('gen-race-199.txt')).toBeNull()
  })
})
