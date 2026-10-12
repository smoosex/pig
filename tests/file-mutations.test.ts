/**
 * The file tree's own writes, against a real worktree: what a new file or folder lands as, what a rename
 * may and may not be asked to do, and where a name is refused before anything touches the disk.
 *
 * The refusals are the interesting half. A new file must not quietly empty an existing one, a rename must
 * not be a way to move something out of the worktree, and a name that holds a separator is a path rather
 * than a name — each of them is a way a careless implementation would let the tree reach past its own
 * column, so each of them is pinned here.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { absolutePath, createEntry, renameEntry } from '../src/main/files/mutations'
import { applyLocaleSetting } from '../src/main/i18n'

// Pig's own errors come from the dictionary: pin the wording these tests spell out.
applyLocaleSetting('zh-CN')

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
  const root = await temp('pig-mutations-test-')
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'main.ts'), 'export const value = 1\n')
  await writeFile(join(root, 'readme.md'), '# hi\n')
  return root
}

describe('createEntry', () => {
  test('creates an empty file at the worktree root', async () => {
    const root = await fixture()
    const created = await createEntry(root, 'notes.md', 'file')
    expect(created).toEqual({ path: 'notes.md' })
    expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe('')
  })

  test('creates a file inside a directory', async () => {
    const root = await fixture()
    const created = await createEntry(root, 'src/thing.ts', 'file')
    expect(created).toEqual({ path: 'src/thing.ts' })
    expect((await lstat(join(root, 'src', 'thing.ts'))).isFile()).toBe(true)
  })

  test('creates a folder, and the ones it needs on the way', async () => {
    const root = await fixture()
    const created = await createEntry(root, 'a/b/c', 'directory')
    expect(created).toEqual({ path: 'a/b/c' })
    expect((await lstat(join(root, 'a', 'b', 'c'))).isDirectory()).toBe(true)
  })

  test('refuses to empty a file that is already there', async () => {
    const root = await fixture()
    await expect(createEntry(root, 'readme.md', 'file')).rejects.toThrow()
    expect(await readFile(join(root, 'readme.md'), 'utf8')).toBe('# hi\n')
  })

  test('never creates a folder through a link that leads out of the worktree', async () => {
    // A recursive mkdir walks a link on the way without a word, which is how a create could land outside
    // the worktree even though the path it was given was inside it.
    const root = await fixture()
    const outside = await temp('pig-mutations-escape-')
    await mkdir(join(root, 'real'))
    await symlink(outside, join(root, 'real', 'link'))
    await expect(createEntry(root, 'real/link/new/inner', 'directory')).rejects.toThrow('不在工作区内')
    expect(await readdir(outside)).toEqual([])
  })

  test('refuses a chain whose middle level is a link out', async () => {
    const root = await fixture()
    const outside = await temp('pig-mutations-escape2-')
    await mkdir(join(root, 'real'))
    await symlink(outside, join(root, 'real', 'link'))
    await expect(createEntry(root, 'real/link/deep', 'directory')).rejects.toThrow('不在工作区内')
    expect(await readdir(outside)).toEqual([])
  })

  test('never creates a file through a link that leads out of the worktree', async () => {
    const root = await fixture()
    const outside = await temp('pig-mutations-escape3-')
    await mkdir(join(root, 'real'))
    await symlink(outside, join(root, 'real', 'link'))
    await expect(createEntry(root, 'real/link/thing.ts', 'file')).rejects.toThrow('不在工作区内')
    expect(await readdir(outside)).toEqual([])
  })

  test('refuses a folder that is already there', async () => {
    const root = await fixture()
    await expect(createEntry(root, 'src', 'directory')).rejects.toThrow('这个名字已经被占用了')
  })

  test('a file and a folder cannot share a name, and both say why in the same words', async () => {
    const root = await fixture()
    await createEntry(root, 'thing', 'file')
    await expect(createEntry(root, 'thing', 'directory')).rejects.toThrow('这个名字已经被占用了')
    // The other way round: the name is taken by the folder, and the file has to say the same thing
    // rather than letting the filesystem's own errno reach the reader.
    const other = await temp('pig-mutations-two-')
    await createEntry(other, 'thing', 'directory')
    await expect(createEntry(other, 'thing', 'file')).rejects.toThrow('这个名字已经被占用了')
  })

  test('an existing file is reported in words rather than in errno', async () => {
    const root = await fixture()
    await expect(createEntry(root, 'readme.md', 'file')).rejects.toThrow('这个名字已经被占用了')
  })
})

describe('renameEntry', () => {
  test('renames a file in place and answers its new path', async () => {
    const root = await fixture()
    const renamed = await renameEntry(root, 'src/main.ts', 'entry.ts')
    expect(renamed).toEqual({ path: 'src/entry.ts' })
    expect(await readFile(join(root, 'src', 'entry.ts'), 'utf8')).toBe('export const value = 1\n')
  })

  test('renames a directory', async () => {
    const root = await fixture()
    const renamed = await renameEntry(root, 'src', 'source')
    expect(renamed).toEqual({ path: 'source' })
    expect(await readFile(join(root, 'source', 'main.ts'), 'utf8')).toBe('export const value = 1\n')
  })

  test('refuses a name that is a path rather than a name', async () => {
    const root = await fixture()
    await expect(renameEntry(root, 'readme.md', '../escaped.md')).rejects.toThrow('名称里不能有斜杠')
    await expect(renameEntry(root, 'readme.md', 'a/b.md')).rejects.toThrow('名称里不能有斜杠')
    await expect(renameEntry(root, 'readme.md', '..')).rejects.toThrow('名称里不能有斜杠')
    await expect(renameEntry(root, 'readme.md', '.')).rejects.toThrow('名称里不能有斜杠')
    await expect(renameEntry(root, 'readme.md', '')).rejects.toThrow('名称里不能有斜杠')
    expect(await readFile(join(root, 'readme.md'), 'utf8')).toBe('# hi\n')
  })

  test('refuses a row that is no longer there', async () => {
    const root = await fixture()
    await expect(renameEntry(root, 'gone.md', 'other.md')).rejects.toThrow('已不存在')
  })

  test('refuses to move a link, which is how one would leave the worktree', async () => {
    const root = await fixture()
    const outside = await temp('pig-mutations-outside-')
    await writeFile(join(outside, 'secret.txt'), 'secret\n')
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'))
    await expect(renameEntry(root, 'link.txt', 'moved.txt')).rejects.toThrow('符号链接')
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('secret\n')
  })

  test('refuses a path outside the worktree', async () => {
    const root = await fixture()
    await expect(renameEntry(root, '../outside.md', 'x.md')).rejects.toThrow('不在工作区内')
    await expect(renameEntry(root, '/etc/hosts', 'x.md')).rejects.toThrow('不在工作区内')
  })

  test('refuses a name that is taken rather than replacing what is there', async () => {
    // POSIX rename overwrites the destination, and the destination is a file's uncommitted work.
    const root = await fixture()
    await writeFile(join(root, 'kept.md'), '# kept\n')
    await expect(renameEntry(root, 'readme.md', 'kept.md')).rejects.toThrow('这个名字已经被占用了')
    expect(await readFile(join(root, 'kept.md'), 'utf8')).toBe('# kept\n')
    expect(await readFile(join(root, 'readme.md'), 'utf8')).toBe('# hi\n')
  })

  test('refuses a folder name that is taken too', async () => {
    const root = await fixture()
    await expect(renameEntry(root, 'readme.md', 'src')).rejects.toThrow('这个名字已经被占用了')
    expect((await lstat(join(root, 'src'))).isDirectory()).toBe(true)
  })

  test('renaming a row to the name it already has is nothing to do', async () => {
    const root = await fixture()
    expect(await renameEntry(root, 'readme.md', 'readme.md')).toEqual({ path: 'readme.md' })
    expect(await readFile(join(root, 'readme.md'), 'utf8')).toBe('# hi\n')
  })
})

describe('absolutePath', () => {
  test('answers the path behind a worktree-relative one, for the clipboard', async () => {
    const root = await fixture()
    expect(await absolutePath(root, 'src/main.ts')).toBe(join(root, 'src', 'main.ts'))
  })

  test('answers a directory too, for the trash and for copying', async () => {
    const root = await fixture()
    expect(await absolutePath(root, 'src')).toBe(join(root, 'src'))
  })

  test('refuses a path outside the worktree', async () => {
    const root = await fixture()
    await expect(absolutePath(root, '../outside.md')).rejects.toThrow('不在工作区内')
    await expect(absolutePath(root, '/etc/hosts')).rejects.toThrow('不在工作区内')
  })
})
