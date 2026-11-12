import { test, mock } from 'bun:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DreamRecord } from '../src/shared/dream'
import { runSelf } from './helpers/subprocess'

if (process.argv.includes('--dream-records-fixture')) {
  const root = mkdtempSync(join(tmpdir(), 'pig-dream-records-'))
  mock.module('../src/main/pig-dir', () => ({ pigPath: (...parts: string[]) => join(root, ...parts) }))
  const { listDreamRecords, readDreamRecord } = await import('../src/main/features/memory/dream/records')
  const save = (index: number): DreamRecord => {
    const id = randomUUID()
    const record: DreamRecord = { id, topic: `Topic ${index}`, repair: index === 31, state: 'done', report: '# Read-only report',
      changes: ['global/MEMORY.md'], startedAt: index, endedAt: index + 1,
      input: 1, cacheRead: 2, cacheWrite: 3, output: 4, cost: 0, costKnown: false, requests: 1 }
    mkdirSync(join(root, 'dream', id), { recursive: true })
    const path = join(root, 'dream', id, 'result.json')
    writeFileSync(path, JSON.stringify({ ...record, privateLegacyField: 'not exposed' }))
    utimesSync(path, index + 1, index + 1)
    return record
  }
  try {
    assert.deepEqual(listDreamRecords(), { items: [] })
    const records = Array.from({ length: 32 }, (_, index) => save(index))
    mkdirSync(join(root, 'dream', randomUUID()), { recursive: true }) // A still-running run has no receipt yet.
    writeFileSync(join(root, 'dream', 'checkpoints.json'), '{}')
    const first = listDreamRecords()
    assert.equal(first.items.length, 30)
    assert.equal(first.nextOffset, 30)
    assert.equal(first.items[0].id, records[31]!.id)
    assert.equal(first.items[0].repair, true)
    assert.ok(!('report' in first.items[0]))
    assert.deepEqual(listDreamRecords(30).items.map(item => item.id), [records[1]!.id, records[0]!.id])
    assert.equal(listDreamRecords(30).nextOffset, undefined)
    const path = join(root, 'dream', records[31]!.id, 'result.json')
    const before = readFileSync(path)
    const detail = readDreamRecord(records[31]!.id)
    assert.equal(detail.report, '# Read-only report')
    assert.equal(detail.repair, true)
    assert.ok(!('privateLegacyField' in detail))
    assert.deepEqual(readFileSync(path), before, 'viewing does not modify a receipt')
    const { cacheRead: _cacheRead, cacheWrite: _cacheWrite, costKnown: _costKnown, ...legacy } = records[0]!
    const legacyPath = join(root, 'dream', legacy.id, 'result.json')
    writeFileSync(legacyPath, JSON.stringify(legacy))
    const legacyBefore = readFileSync(legacyPath)
    const legacyRecord = readDreamRecord(legacy.id)
    assert.equal(legacyRecord.usageIncomplete, true)
    assert.equal(legacyRecord.costKnown, false)
    assert.equal(legacyRecord.report, legacy.report)
    assert.equal(legacyRecord.input, legacy.input, 'old combined input is preserved, not reclassified as fresh input')
    assert.equal(listDreamRecords(30).items.length, 2, 'legacy receipts do not break the record list')
    assert.deepEqual(readFileSync(legacyPath), legacyBefore, 'compatibility is read-only, never a migration')
    assert.equal(detail.usageIncomplete, false)
    writeFileSync(legacyPath, JSON.stringify({ ...legacy, cacheRead: 'invalid' }))
    assert.throws(() => readDreamRecord(legacy.id), /DREAM_RECORD/, 'present-but-invalid fields still reject')
    writeFileSync(legacyPath, JSON.stringify(legacy))
    assert.throws(() => readDreamRecord('../other'), /DREAM_RECORD/)
    assert.throws(() => listDreamRecords(-1), /DREAM_RECORD/)
    const invalid = save(40)
    const invalidPath = join(root, 'dream', invalid.id, 'result.json')
    writeFileSync(invalidPath, '{"secret":"MUST-NOT-LEAK"')
    assert.throws(() => readDreamRecord(invalid.id), error => String(error).includes('DREAM_RECORD') && !String(error).includes('MUST-NOT-LEAK') && !String(error).includes(root))
    writeFileSync(invalidPath, JSON.stringify({ ...invalid, id: records[0]!.id }))
    assert.throws(() => readDreamRecord(invalid.id), /DREAM_RECORD/)
    rmSync(invalidPath)
    symlinkSync(path, invalidPath)
    assert.throws(() => readDreamRecord(invalid.id), /DREAM_RECORD/)
    assert.throws(() => listDreamRecords(), /DREAM_RECORD/)
  } finally { rmSync(root, { recursive: true, force: true }) }
} else test('Dream receipts are paginated, read-only, scope-safe and validate saved results without exposing private fields', async () => {
  const result = await runSelf(import.meta.path, ['--dream-records-fixture'])
  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
})
