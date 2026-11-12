import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchFiles } from '../src/main/files/search'
import { readDirectory } from '../src/main/files/tree'
import { runGit } from '../src/main/git/run'

test('file filtering finds unopened paths, respects Git ignores and never traverses links', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'pig-file-filter-')))
  const root = join(base, 'workspace')
  try {
    await mkdir(join(root, 'src', 'nested'), { recursive: true })
    await mkdir(join(root, 'ignored'))
    await mkdir(join(base, 'outside'))
    await writeFile(join(root, '.gitignore'), 'ignored/\n')
    await writeFile(join(root, 'src', 'nested', 'needle.ts'), '')
    await writeFile(join(root, 'ignored', 'needle.txt'), '')
    await writeFile(join(base, 'outside', 'needle-secret.txt'), '')
    await symlink(join(base, 'outside'), join(root, 'link'))
    await runGit(root, ['init', '-q'])
    const hidden = await searchFiles(root, 'NEEDLE', true)
    assert.deepEqual(hidden.entries.map(entry => entry.path), ['src/nested/needle.ts'])
    assert.equal(hidden.truncated, false)
    const all = await searchFiles(root, 'needle', false)
    assert.deepEqual(all.entries.map(entry => entry.path).sort(), ['ignored/needle.txt', 'src/nested/needle.ts'])
    assert.equal(all.entries.find(entry => entry.path === 'ignored/needle.txt')!.ignored, true)
    const controller = new AbortController()
    const cancelled = new Error('cancelled')
    controller.abort(cancelled)
    await assert.rejects(searchFiles(root, 'needle', false, controller.signal), error => error === cancelled)
    await assert.rejects(searchFiles(join(base, 'missing'), 'needle', false))
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('file filtering caps results and reports incomplete scans outside Git too', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pig-file-filter-limit-')))
  try {
    await Promise.all(Array.from({ length: 201 }, (_, index) => writeFile(join(root, `match-${index}.ts`), '')))
    const bounded = await readDirectory(root, '', { maxEntries: 3 })
    assert.equal(bounded.scanned, 3)
    assert.equal(bounded.entries.length, 3)
    assert.equal(bounded.truncated, true)
    const result = await searchFiles(root, 'match', false)
    assert.equal(result.entries.length, 200)
    assert.equal(result.truncated, true)
    assert.deepEqual(await searchFiles(root, ' ' , false), { entries: [], truncated: false })
  } finally { await rm(root, { recursive: true, force: true }) }
})
