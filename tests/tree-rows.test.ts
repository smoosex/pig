/**
 * Where a name being typed stands among the rows.
 *
 * A new entry leads the directory it is being made in, and a rename stands exactly where the row already
 * was — those are the two placements this pass exists to decide, and both are easy to get subtly wrong:
 * a field one level too shallow is a name that would land in the wrong directory, and a rename that
 * gains a row instead of replacing one leaves the reader looking at the same file twice.
 */
import { describe, expect, test } from 'bun:test'
import { treeRows } from '../src/renderer/src/components/files/tree-rows'
import type { DirectoryState } from '../src/renderer/src/stores/files'
import type { FileTreeEntry } from '../src/shared/api'

const file = (path: string): FileTreeEntry => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  kind: 'file',
  ignored: false
})

const folder = (path: string): FileTreeEntry => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  kind: 'directory',
  ignored: false
})

const trees: Record<string, DirectoryState> = {
  '': { status: 'ready', entries: [folder('src'), file('readme.md')] },
  src: { status: 'ready', entries: [file('src/main.ts'), folder('src/deep')] },
  'src/deep': { status: 'ready', entries: [file('src/deep/leaf.ts')] }
}

const expanded = { src: true, 'src/deep': true }

const paths = (rows: ReturnType<typeof treeRows>) => rows.map((row) => row.entry.path)
const drafts = (rows: ReturnType<typeof treeRows>) => rows.map((row) => row.draft ?? null)

describe('treeRows', () => {
  test('walks an open level in the order it was given', () => {
    expect(paths(treeRows(trees, expanded, false, null))).toEqual([
      'src',
      'src/main.ts',
      'src/deep',
      'src/deep/leaf.ts',
      'readme.md'
    ])
  })

  test('hides what git ignores when asked to', () => {
    const state: Record<string, DirectoryState> = {
      '': { status: 'ready', entries: [{ ...file('skip.log'), ignored: true }, file('readme.md')] }
    }
    expect(paths(treeRows(state, {}, true, null))).toEqual(['readme.md'])
    expect(paths(treeRows(state, {}, false, null))).toEqual(['skip.log', 'readme.md'])
  })

  test('a new folder leads the directory it is being made in', () => {
    const rows = treeRows(trees, expanded, false, { cwd: '/p', kind: 'folder', directory: 'src' })
    expect(paths(rows)).toEqual([
      'src',
      '',
      'src/main.ts',
      'src/deep',
      'src/deep/leaf.ts',
      'readme.md'
    ])
    expect(drafts(rows)[1]).toBe('folder')
    expect(rows[1]!.entry.kind).toBe('directory')
    expect(rows[1]!.depth).toBe(1)
  })

  test('a new file follows the folders, where the listing will put it', () => {
    // src holds a file then a folder: the file already leads that level, so the field goes above it and
    // the folders still follow — the order the level itself is in.
    const rows = treeRows(trees, expanded, false, { cwd: '/p', kind: 'file', directory: 'src' })
    expect(paths(rows)).toEqual([
      'src',
      '',
      'src/main.ts',
      'src/deep',
      'src/deep/leaf.ts',
      'readme.md'
    ])
    expect(drafts(rows)[1]).toBe('file')
    expect(rows[1]!.depth).toBe(1)
  })

  test('a new file in a level that leads with folders goes after them', () => {
    const leading: Record<string, DirectoryState> = {
      '': { status: 'ready', entries: [folder('src'), folder('test'), file('readme.md')] }
    }
    const rows = treeRows(leading, {}, false, { cwd: '/p', kind: 'file', directory: '' })
    expect(paths(rows)).toEqual(['src', 'test', '', 'readme.md'])
    expect(drafts(rows)[2]).toBe('file')
  })

  test('a new file in a level of folders only goes last', () => {
    const only: Record<string, DirectoryState> = {
      '': { status: 'ready', entries: [folder('src'), folder('test')] }
    }
    const rows = treeRows(only, {}, false, { cwd: '/p', kind: 'file', directory: '' })
    expect(paths(rows)).toEqual(['src', 'test', ''])
    expect(drafts(rows)[2]).toBe('file')
  })

  test('a new file in an empty level is the only row', () => {
    const empty: Record<string, DirectoryState> = { '': { status: 'ready', entries: [] } }
    const rows = treeRows(empty, {}, false, { cwd: '/p', kind: 'folder', directory: '' })
    expect(paths(rows)).toEqual([''])
    expect(drafts(rows)[0]).toBe('folder')
  })

  test('a new file follows the folders the reader can see, not the ones being hidden', () => {
    const state: Record<string, DirectoryState> = {
      '': {
        status: 'ready',
        entries: [
          { ...folder('dist'), ignored: true },
          { ...file('skip.log'), ignored: true },
          file('readme.md')
        ]
      }
    }
    const rows = treeRows(state, {}, true, { cwd: '/p', kind: 'file', directory: '' })
    expect(paths(rows)).toEqual(['', 'readme.md'])
    expect(drafts(rows)[0]).toBe('file')
  })

  test('a new entry inside a closed directory is not drawn, because nothing there is', () => {
    const rows = treeRows(trees, { src: false }, false, { cwd: '/p', kind: 'file', directory: 'src' })
    expect(drafts(rows).every((draft) => draft === null)).toBe(true)
  })

  test('a rename replaces the row it is naming, at that row', () => {
    const rows = treeRows(trees, expanded, false, { cwd: '/p', kind: 'rename', path: 'src/main.ts' })
    expect(paths(rows)).toEqual([
      'src',
      'src/main.ts',
      'src/deep',
      'src/deep/leaf.ts',
      'readme.md'
    ])
    expect(drafts(rows)[1]).toBe('rename')
    expect(rows[1]!.depth).toBe(1)
  })

  test('a rename adds no row of its own', () => {
    const withRename = treeRows(trees, expanded, false, { cwd: '/p', kind: 'rename', path: 'src' })
    const without = treeRows(trees, expanded, false, null)
    expect(withRename.length).toBe(without.length)
    expect(withRename[0]!.draft).toBe('rename')
  })
})
