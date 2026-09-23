import { describe, expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rankCandidates, suggestFiles } from '../src/main/files/suggest'

const FILES = [
  'src/main/index.ts',
  'src/main/files/suggest.ts',
  'src/renderer/src/components/composer/mentions.ts',
  'src/renderer/src/components/Composer.tsx',
  'package.json',
  'README.md'
]

describe('file suggest ranking', () => {
  test('matches a gappy query against the basename', () => {
    expect(rankCandidates(FILES, 'idx').map((entry) => entry.path)).toEqual(['src/main/index.ts'])
  })

  test('prefers prefix hits over substring hits', () => {
    const [first] = rankCandidates(FILES, 'men')
    expect(first?.path).toBe('src/renderer/src/components/composer/mentions.ts')
  })

  test('scopes a query with a slash to the entries below its base', () => {
    const paths = rankCandidates(FILES, 'src/ma').map((entry) => entry.path)
    expect(paths).toContain('src/main/index.ts')
    expect(paths.every((path) => path.startsWith('src/'))).toBe(true)
  })

  test('lists the shallowest entries first for an empty query', () => {
    const [first, second] = rankCandidates(FILES, '')
    expect(first?.path).toBe('src/')
    expect(first?.isDirectory).toBe(true)
    expect(second?.isDirectory).toBe(false)
  })

  test('returns nothing when the base does not exist', () => {
    expect(rankCandidates(FILES, 'nope/nada')).toEqual([])
  })

  test('outside a repo a directory keeps descending one level at a time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pig-suggest-'))
    try {
      await mkdir(join(root, 'sub'))
      await writeFile(join(root, 'sub', 'file.txt'), 'x')
      await writeFile(join(root, 'top.txt'), 'x')
      const top = await suggestFiles(root, '')
      assert.deepEqual(top.map((entry) => entry.path).sort(), ['sub/', 'top.txt'])
      const below = await suggestFiles(root, 'sub/')
      assert.deepEqual(below, [{ path: 'sub/file.txt', isDirectory: false }])
      assert.deepEqual(await suggestFiles(root, 'nope/'), [])
      assert.deepEqual(await suggestFiles(root, 'top.txt/'), [])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
