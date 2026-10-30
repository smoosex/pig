import { describe, expect, test } from 'bun:test'
import { changeTreeRows } from '../src/renderer/src/components/diff/change-tree'
import type { DiffFileEntry } from '../src/shared/api'

const entry = (path: string): DiffFileEntry => ({ path, status: 'modified', additions: 1, deletions: 0 })

const shape = (rows: ReturnType<typeof changeTreeRows>) =>
  rows.map((row) => `${'  '.repeat(row.depth)}${row.kind === 'directory' ? `${row.name}/` : row.entry.path}`)

describe('changeTreeRows', () => {
  const entries = ['src/main/pi/a.ts', 'README.md', 'src/main/b.ts', 'src/z.ts', 'docs/x/y/z.md'].map(entry)

  test('folders before files, single-child chains merged', () => {
    expect(shape(changeTreeRows(entries, () => false))).toEqual([
      'docs/x/y/',
      '  docs/x/y/z.md',
      'src/',
      '  main/',
      '    pi/',
      '      src/main/pi/a.ts',
      '    src/main/b.ts',
      '  src/z.ts',
      'README.md'
    ])
  })

  test('names order like the file column: case-insensitive, numbers by value', () => {
    const rows = changeTreeRows(['README.md', 'file10.ts', 'a.ts', 'file2.ts', 'Lib/x.ts', 'app/y.ts'].map(entry), () => false)
    expect(shape(rows)).toEqual(['app/', '  app/y.ts', 'Lib/', '  Lib/x.ts', 'a.ts', 'file2.ts', 'file10.ts', 'README.md'])
  })

  test('a collapsed directory hides its rows and keeps every file for its counts', () => {
    const rows = changeTreeRows(entries, (path) => path === 'src/main')
    expect(shape(rows)).toEqual(['docs/x/y/', '  docs/x/y/z.md', 'src/', '  main/', '  src/z.ts', 'README.md'])
    const main = rows.find((row) => row.kind === 'directory' && row.path === 'src/main')
    expect(main?.kind === 'directory' && main.entries.length).toBe(2)
  })
})
