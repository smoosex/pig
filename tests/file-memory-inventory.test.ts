import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DreamStage } from '../src/main/features/memory/dream/staging'
import { MemoryFiles } from '../src/main/features/memory/long-term/files'
import { inspectMemoryDirectory } from '../src/main/features/memory/long-term/inventory'

test('memory diagnostics isolate misplaced, unreadable, oversized and linked entries without hiding normal files', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pig-memory-inventory-')))
  try {
    mkdirSync(join(root, 'global', 'topics'), { recursive: true })
    mkdirSync(join(root, 'projects', 'wrong'), { recursive: true })
    writeFileSync(join(root, 'global', 'topics', 'good.md'), 'Useful')
    writeFileSync(join(root, 'stray.md'), 'Misplaced')
    writeFileSync(join(root, 'projects', 'wrong', 'note.md'), 'Wrong scope')
    writeFileSync(join(root, 'global', 'bad.md'), Buffer.from([0xff]))
    writeFileSync(join(root, 'global', 'large.md'), 'x'.repeat(65537))
    symlinkSync('/etc/passwd', join(root, 'global', 'linked.md'))
    const result = inspectMemoryDirectory(root)
    assert.equal(result.truncated, false)
    assert.deepEqual(result.files.find(file => file.path === 'global/topics/good.md'), { path: 'global/topics/good.md', bytes: 6 })
    assert.equal(result.files.find(file => file.path === 'stray.md')?.repairable, true)
    assert.equal(result.files.find(file => file.path === 'projects/wrong/note.md')?.issue, 'MEMORY_MISPLACED')
    assert.equal(result.files.find(file => file.path === 'global/bad.md')?.issue, 'MEMORY_UNREADABLE')
    assert.equal(result.files.find(file => file.path === 'global/large.md')?.issue, 'MEMORY_OVERSIZED')
    assert.equal(result.files.find(file => file.path === 'global/linked.md')?.issue, 'MEMORY_SYMLINK')
    assert.ok(result.files.filter(file => file.issue !== 'MEMORY_MISPLACED').every(file => !file.repairable))
    assert.deepEqual(inspectMemoryDirectory(join(root, 'missing')).files, [])
    symlinkSync(join(root, 'global'), join(root, 'alias'))
    assert.throws(() => inspectMemoryDirectory(join(root, 'alias')), /MEMORY_ROOT/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('repair publication never overwrites anomalous files omitted from staging', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pig-memory-repair-preserve-')))
  try {
    const live = new MemoryFiles(join(root, 'memory'))
    live.save('stray.md', 'Keep this', null)
    mkdirSync(join(live.root, 'global'))
    const bad = join(live.root, 'global', 'bad.md')
    writeFileSync(bad, Buffer.from([0xff]))
    const stage = new DreamStage(join(root, 'run'), live, new Set(['stray.md']))
    stage.store.save('global/bad.md', 'Would overwrite an excluded file', null)
    assert.throws(() => stage.publish(new Set(['global']), () => {}), /DREAM_REPAIR/)
    assert.deepEqual(readFileSync(bad), Buffer.from([0xff]))
    assert.equal(live.read('stray.md').content, 'Keep this')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('memory diagnostics explicitly mark bounded scans incomplete', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pig-memory-inventory-limit-')))
  try {
    for (let i = 0; i < 1001; i++) writeFileSync(join(root, `note-${i}.md`), '')
    const result = inspectMemoryDirectory(root)
    assert.equal(result.truncated, true)
    assert.equal(result.files.filter(file => file.repairable).length, 1000)
    assert.ok(result.files.some(file => file.issue === 'MEMORY_FILE_LIMIT'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
