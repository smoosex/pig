import { test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync,
  realpathSync, rmSync, symlinkSync, writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runChild, runSelf } from './helpers/subprocess'

if (process.argv.includes('--telemetry-store-fixture')) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pig-telemetry-store-')))
  const telemetryRoot = join(root, 'memory-telemetry')
  const {
    appendTelemetryRow, appendTelemetryRowSync, commitAuditKeeps,
    MAX_TELEMETRY_OPS_PER_ROW, MAX_TELEMETRY_ROW_BYTES, readAuditState, readTelemetryWindow
  } = await import('../src/main/features/memory/telemetry/store')
  const { sanitizeTelemetryPath, sanitizeTelemetryQuery, telemetryErrorCode } = await import('../src/main/features/memory/telemetry/sanitize')
  const { MemoryFileError, MemoryFiles } = await import('../src/main/features/memory/long-term/files')

  const revA = 'a'.repeat(64)
  const revB = 'b'.repeat(64)
  const projectA = '1'.repeat(64)
  const now = Date.UTC(2026, 10, 19, 10, 0, 0) // 2026-11-19 UTC

  try {
    // 1. Sanitize queries, paths, and error codes.
    assert.equal(sanitizeTelemetryQuery('  refresh   token rotation  '), 'refresh token rotation')
    assert.equal(sanitizeTelemetryQuery('x'.repeat(121)), undefined, 'over 120 UTF-8 bytes is omitted')
    assert.equal(sanitizeTelemetryQuery('line1\nline2'), undefined)
    assert.equal(sanitizeTelemetryQuery('sk-proj-1234567890abcdef12345678'), undefined)
    assert.equal(sanitizeTelemetryQuery('Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0'), undefined)
    assert.equal(sanitizeTelemetryQuery('user@example.com auth'), undefined)
    assert.equal(sanitizeTelemetryQuery('password=supersecret'), undefined)
    assert.equal(sanitizeTelemetryQuery('https://example.test/?token=abc123456'), undefined)
    assert.equal(sanitizeTelemetryQuery('/Users/alice/secret/note.md'), undefined)
    assert.equal(sanitizeTelemetryQuery('call 13800138000'), undefined)
    assert.equal(sanitizeTelemetryPath('auth/jwt.md'), 'auth/jwt.md')
    assert.equal(sanitizeTelemetryPath('../secret.md'), undefined)
    assert.equal(sanitizeTelemetryPath('user@example.com.md'), undefined)
    assert.equal(telemetryErrorCode(new MemoryFileError('ENOENT', `missing ${root}/secret`)), 'ENOENT')
    assert.equal(telemetryErrorCode(new MemoryFileError('MEMORY_CLEANUP_FAILED', `bad ${root}`, true)), 'MEMORY_CLEANUP_FAILED')
    assert.equal(telemetryErrorCode(new Error(`raw internal error ${root}`)), 'UNKNOWN_ERROR')

    // 2. Append across UTC month boundaries, enforce 6-month retention, and check permissions.
    const oldMonthAt = Date.UTC(2026, 4, 15, 0, 0, 0) // 2026-05 (7 months ago -> pruned)
    const keptOldAt = Date.UTC(2026, 5, 1, 0, 0, 0) // 2026-06 (6th month including 2026-11 -> retained)
    const octAt = Date.UTC(2026, 9, 25, 12, 0, 0) // 2026-10
    const baseRow = (at: number, turnId: string) => ({
      v: 1 as const,
      at,
      sessionId: 'sess-1',
      turnId,
      anchorEntryId: `anc-${turnId}`,
      projectId: projectA,
      outcome: 'completed' as const,
      ops: [{ op: 'read' as const, scope: 'project' as const, ok: true, path: 'MEMORY.md', rev: revA, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }],
      tail: { calls: 0, errs: 0 }
    })

    assert.equal(appendTelemetryRowSync(baseRow(oldMonthAt, 't-old'), { root: telemetryRoot, now: oldMonthAt }), true)
    assert.equal(existsSync(join(telemetryRoot, '2026-05.jsonl')), true)
    assert.equal(await appendTelemetryRow(baseRow(keptOldAt, 't-june'), { root: telemetryRoot, now }), true)
    assert.equal(existsSync(join(telemetryRoot, '2026-05.jsonl')), false, 'shards older than 6 UTC months are pruned on append')
    assert.equal(existsSync(join(telemetryRoot, '2026-06.jsonl')), true, 'the 6th recent UTC month is retained')
    assert.equal(lstatSync(telemetryRoot).mode & 0o777, 0o700)
    assert.equal(lstatSync(join(telemetryRoot, '2026-06.jsonl')).mode & 0o777, 0o600)

    // 3. Enforce per-row caps: max 32 ops and max 8192 UTF-8 bytes including newline.
    const manyOps = Array.from({ length: 40 }, (_, i) => ({
      op: 'read' as const,
      scope: 'project' as const,
      ok: true,
      path: `notes/long-topic-segment-${i}-${'a'.repeat(180)}.md`,
      from: 'MEMORY.md',
      rev: revA,
      offset: 0,
      hasMore: false,
      gap: { calls: 1, errs: 0 }
    }))
    await appendTelemetryRow({ ...baseRow(octAt, 't-many'), ops: manyOps }, { root: telemetryRoot, now })
    const octContent = readFileSync(join(telemetryRoot, '2026-10.jsonl'), 'utf8')
    const octLines = octContent.trim().split('\n')
    assert.equal(octLines.length, 1)
    assert.ok(Buffer.byteLength(octContent, 'utf8') <= MAX_TELEMETRY_ROW_BYTES)
    const octParsed = JSON.parse(octLines[0]!)
    assert.equal(octParsed.opsTruncated, true)
    assert.ok(octParsed.ops.length <= MAX_TELEMETRY_OPS_PER_ROW)
    const octWinNoNov = readTelemetryWindow({ now, root: telemetryRoot })
    assert.equal(octWinNoNov.coverage.complete, false, 'opsTruncated and missing current month mark telemetry coverage incomplete')
    assert.ok(octWinNoNov.coverage.incompleteReasons.includes('truncated_rows'))
    assert.ok(octWinNoNov.coverage.incompleteReasons.includes('missing_shards'))
    assert.equal(octWinNoNov.coverage.truncatedRows, 1)
    assert.equal(octWinNoNov.coverage.reliableStartAt, undefined, 'missing current month 2026-11 yields no reliable coverage up to now')
    const octWinAtOct = readTelemetryWindow({ now: octAt + 10_000, root: telemetryRoot })
    assert.equal(octWinAtOct.coverage.reliableStartAt, octAt + 1, 'reliableStartAt advances past truncated row within present current month')

    // 3b. Redacted path (pathOmitted: true) on successful read/edit coexists with normal ops in the same row.
    const redactedRoot = join(root, 'redacted-telemetry')
    mkdirSync(redactedRoot, { recursive: true })
    assert.equal(await appendTelemetryRow({
      v: 1,
      at: now - 5000,
      sessionId: 'sess-redacted',
      turnId: 't-redacted',
      anchorEntryId: 'anc-redacted',
      projectId: projectA,
      outcome: 'completed',
      ops: [
        { op: 'read', scope: 'global', ok: true, path: 'MEMORY.md', rev: revA, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } },
        { op: 'read', scope: 'global', ok: true, pathOmitted: true, from: 'MEMORY.md', rev: revB, offset: 0, hasMore: false, gap: { calls: 1, errs: 0 } },
        { op: 'edit', scope: 'global', ok: true, pathOmitted: true, beforeRev: revA, afterRev: revB, gap: { calls: 0, errs: 0 } },
        { op: 'search', scope: 'global', ok: true, query: 'deploy steps', hits: 0, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }
      ],
      tail: { calls: 1, errs: 0 }
    }, { root: redactedRoot, now }), true)
    const redactedWin = readTelemetryWindow({ now, root: redactedRoot })
    assert.equal(redactedWin.coverage.skippedLines, 0, 'redacted pathOmitted ops must not drop the row')
    assert.equal(redactedWin.rows.length, 1)
    assert.deepEqual(redactedWin.rows[0]!.ops.map(op => op.op), ['read', 'read', 'edit', 'search'])
    assert.equal(redactedWin.rows[0]!.ops[1]!.path, undefined)
    assert.equal(redactedWin.rows[0]!.ops[1]!.pathOmitted, true)
    assert.equal(redactedWin.rows[0]!.ops[2]!.path, undefined)
    assert.equal(redactedWin.rows[0]!.ops[2]!.pathOmitted, true)
    assert.equal(redactedWin.rows[0]!.ops[3]!.query, 'deploy steps')

    // Missing path WITHOUT pathOmitted: true on successful read is still rejected as corrupt.
    writeFileSync(join(redactedRoot, '2026-11.jsonl'), JSON.stringify({
      v: 1, at: now - 4000, sessionId: 'sess-bad', turnId: 't-bad', outcome: 'completed',
      ops: [{ op: 'read', scope: 'global', ok: true, rev: revA, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }],
      tail: { calls: 0, errs: 0 }
    }) + '\n', { flag: 'a' })
    const redactedAfterBad = readTelemetryWindow({ now, root: redactedRoot })
    assert.equal(redactedAfterBad.coverage.skippedLines, 1)
    assert.equal(redactedAfterBad.rows.length, 1)

    // 4. An unterminated valid row survives appending; a malformed one remains a coverage gap.
    const novPath = join(telemetryRoot, '2026-11.jsonl')
    assert.equal(appendTelemetryRowSync(baseRow(now - 30_000, 't-nov-1'), { root: telemetryRoot, now }), true)
    writeFileSync(novPath, JSON.stringify(baseRow(now - 25_000, 't-no-newline')), { flag: 'a' })
    assert.equal(await appendTelemetryRow(baseRow(now - 20_000, 't-nov-2'), { root: telemetryRoot, now }), true)
    const tailOptions = { now, root: telemetryRoot, windowDays: 1 }
    const validTailWin = readTelemetryWindow(tailOptions)
    assert.equal(validTailWin.coverage.complete, true)
    assert.deepEqual(validTailWin.rows.map(row => row.turnId), ['t-nov-1', 't-no-newline', 't-nov-2'])

    const brokenTail = '{"v":1,"at":123,"broken":'
    writeFileSync(novPath, brokenTail, { flag: 'a' })
    assert.equal(await appendTelemetryRow(baseRow(now - 10_000, 't-nov-3'), { root: telemetryRoot, now }), true)
    const corruptTailWin = readTelemetryWindow(tailOptions)
    assert.ok(readFileSync(novPath, 'utf8').includes(`\n${brokenTail}\n`))
    assert.deepEqual(corruptTailWin.rows.map(row => row.turnId), ['t-nov-1', 't-no-newline', 't-nov-2', 't-nov-3'])
    assert.equal(corruptTailWin.coverage.complete, false)
    assert.equal(corruptTailWin.coverage.skippedLines, 1)
    assert.ok(corruptTailWin.coverage.incompleteReasons.includes('corrupt_lines'))
    assert.equal(corruptTailWin.coverage.reliableStartAt, undefined)

    // Large non-newlined chunk is not wiped to zero; append places a separating newline before writing.
    const hugeNoNewline = join(root, 'huge-no-nl')
    mkdirSync(hugeNoNewline, { recursive: true })
    writeFileSync(join(hugeNoNewline, '2026-11.jsonl'), 'x'.repeat(20_000))
    assert.equal(await appendTelemetryRow(baseRow(now - 5_000, 't-after-huge'), { root: hugeNoNewline, now }), true)
    const hugeContent = readFileSync(join(hugeNoNewline, '2026-11.jsonl'), 'utf8')
    assert.ok(hugeContent.startsWith('x'.repeat(20_000) + '\n{'), 'oversized non-newlined data is never wiped')
    const hugeWin = readTelemetryWindow({ now, root: hugeNoNewline, windowDays: 1 })
    assert.deepEqual(hugeWin.rows.map(row => row.turnId), ['t-after-huge'])
    assert.ok(hugeWin.coverage.incompleteReasons.includes('corrupt_lines'))

    // 5. Bounded reading: skip unknown version, corrupt lines, and apply per-shard byte budget.
    writeFileSync(novPath,
      JSON.stringify(baseRow(now - 30_000, 't-keep-1')) + '\n' +
      JSON.stringify({ ...baseRow(now - 25_000, 't-v2'), v: 2 }) + '\n' +
      '{not-json\n' +
      JSON.stringify(baseRow(now - 15_000, 't-keep-2')) + '\n' +
      '{"v":1,"partial_tail":true'
    )
    const winCorrupt = readTelemetryWindow({ now, root: telemetryRoot })
    assert.equal(winCorrupt.coverage.complete, false)
    assert.ok(winCorrupt.coverage.incompleteReasons.includes('corrupt_lines'))
    assert.ok(winCorrupt.coverage.corruptShards.includes('2026-11'))
    assert.equal(winCorrupt.coverage.skippedLines, 3)
    assert.deepEqual(winCorrupt.rows.filter(r => r.sessionId === 'sess-1' && r.at >= now - 35_000).map(r => r.turnId), ['t-keep-1', 't-keep-2'])

    // Budget-truncated shard keeps only complete trailing lines within the budget.
    const budgetRoot = join(root, 'budget-telemetry')
    mkdirSync(budgetRoot, { recursive: true })
    const line1 = JSON.stringify(baseRow(now - 40_000, 't-drop-1')) + '\n'
    const line2 = JSON.stringify(baseRow(now - 30_000, 't-drop-2')) + '\n'
    const line3 = JSON.stringify(baseRow(now - 20_000, 't-tail-1')) + '\n'
    const line4 = JSON.stringify(baseRow(now - 10_000, 't-tail-2')) + '\n'
    writeFileSync(join(budgetRoot, '2026-11.jsonl'), line1 + line2 + line3 + line4)
    const budgetWin = readTelemetryWindow({ now, root: budgetRoot, shardBudgetBytes: Buffer.byteLength(line3 + line4) + 10 })
    assert.deepEqual(budgetWin.rows.map(r => r.turnId), ['t-tail-1', 't-tail-2'])
    assert.deepEqual(budgetWin.coverage.truncatedShards, ['2026-11'])
    assert.equal(budgetWin.coverage.reliableStartAt, now - 20_000)

    // 6. Audit cooldown state rejects corrupt files without overwriting them, and verifies live revisions.
    assert.deepEqual(readAuditState(telemetryRoot), { v: 1, kept: [] })
    const liveRevs = new Map<string, string>([['global/a.md', revA], ['global/b.md', revB]])
    await commitAuditKeeps(
      [
        { scope: 'global', path: 'a.md', rev: revA, kind: 'stale', checkedAt: now - 1000, signalThrough: 0 },
        { scope: 'global', path: 'b.md', rev: revA, kind: 'stale', checkedAt: now - 1000, signalThrough: 0 } // mismatch rev
      ],
      entry => liveRevs.get(`${entry.scope}/${entry.path}`) === entry.rev,
      { root: telemetryRoot, now }
    )
    const state = readAuditState(telemetryRoot)
    assert.equal(state.kept.length, 1)
    assert.equal(state.kept[0]!.path, 'a.md')
    assert.equal(lstatSync(join(telemetryRoot, 'audit-state.json')).mode & 0o777, 0o600)

    const corruptPayload = '{"v":1,"kept":[{"bad":true}]}'
    writeFileSync(join(telemetryRoot, 'audit-state.json'), corruptPayload)
    assert.throws(() => readAuditState(telemetryRoot), /DREAM_AUDIT_STATE/)
    await assert.rejects(
      commitAuditKeeps(
        [{ scope: 'global', path: 'a.md', rev: revA, kind: 'stale', checkedAt: now, signalThrough: 0 }],
        () => true,
        { root: telemetryRoot, now }
      ),
      /DREAM_AUDIT_STATE/
    )
    assert.equal(readFileSync(join(telemetryRoot, 'audit-state.json'), 'utf8'), corruptPayload, 'corrupt audit-state.json is never overwritten')

    // 6b. commitAuditKeeps aborts cleanly while waiting on a busy writer lease and never writes audit-state.json.
    const leaseRoot = join(root, 'lease-wait-telemetry')
    mkdirSync(join(leaseRoot, '.writer'), { recursive: true })
    writeFileSync(join(leaseRoot, '.writer', 'pid'), String(process.pid))
    const cancelCtrl = new AbortController()
    const pendingCommit = commitAuditKeeps(
      [{ scope: 'global', path: 'a.md', rev: revA, kind: 'stale', checkedAt: now, signalThrough: 0 }],
      () => true,
      { root: leaseRoot, now, signal: cancelCtrl.signal }
    )
    setTimeout(() => cancelCtrl.abort(new Error('DREAM_CANCELLED')), 10)
    await assert.rejects(pendingCommit, /DREAM_CANCELLED/)
    rmSync(join(leaseRoot, '.writer'), { recursive: true, force: true })
    assert.equal(existsSync(join(leaseRoot, 'audit-state.json')), false, 'cancelled wait never commits audit-state')

    // 6c. Structure keeps preserve subkind & defectKey distinctly, and legacy broad structure keeps stay readable.
    const structRoot = join(root, 'struct-state-telemetry')
    mkdirSync(structRoot, { recursive: true })
    writeFileSync(join(structRoot, 'audit-state.json'), JSON.stringify({
      v: 1,
      kept: [{ scope: 'global', path: 'legacy.md', rev: revA, kind: 'structure', checkedAt: now - 1000, signalThrough: 0 }]
    }))
    assert.equal(readAuditState(structRoot).kept.length, 1, 'legacy broad structure entry remains readable')
    await commitAuditKeeps([
      { scope: 'global', path: 'a.md', rev: revA, kind: 'structure', subkind: 'orphan', defectKey: revA, checkedAt: now, signalThrough: 0 },
      { scope: 'global', path: 'a.md', rev: revA, kind: 'structure', subkind: 'broken_link', defectKey: revB, checkedAt: now, signalThrough: 0 }
    ], () => true, { root: structRoot, now })
    const structState = readAuditState(structRoot)
    assert.equal(structState.kept.length, 3, 'orphan and broken_link keeps for the same file do not overwrite each other')

    // 6d. Regression: verifyLiveRevision runs AFTER beforeWrite under the synchronous memory catalog writer lease;
    // a note modified during beforeWrite is skipped while an unchanged note still commits.
    const raceMemRoot = join(root, 'race-mem')
    const raceTelRoot = join(root, 'race-tel')
    const raceCatalog = new MemoryFiles(raceMemRoot)
    const raceGlobal = new MemoryFiles(join(raceMemRoot, 'global'), raceMemRoot)
    const noteChanged = raceGlobal.save('changed.md', 'v1', null)
    const noteStable = raceGlobal.save('stable.md', 'v1', null)
    let sawCatalogLeaseDuringVerify = false
    await commitAuditKeeps(
      [
        { scope: 'global', path: 'changed.md', rev: noteChanged.revision, kind: 'stale', checkedAt: now, signalThrough: 0 },
        { scope: 'global', path: 'stable.md', rev: noteStable.revision, kind: 'stale', checkedAt: now, signalThrough: 0 }
      ],
      entry => {
        if (existsSync(join(raceMemRoot, '.writer'))) sawCatalogLeaseDuringVerify = true
        return raceGlobal.optional(entry.path)?.revision === entry.rev
      },
      {
        root: raceTelRoot,
        now,
        withLiveLock: action => raceCatalog.withCatalogLease(action),
        beforeWrite: async () => {
          await new Promise(resolveDelay => setTimeout(resolveDelay, 5))
          // Mutate changed.md concurrently while beforeWrite awaits; catalog lease is NOT held yet so save succeeds.
          raceGlobal.save('changed.md', 'v2 updated during beforeWrite', noteChanged.revision)
        }
      }
    )
    assert.equal(sawCatalogLeaseDuringVerify, true, 'final live revision check runs under memory catalog writer lease')
    assert.equal(existsSync(join(raceMemRoot, '.writer')), false, 'catalog writer lease is released after commit')
    const raceState = readAuditState(raceTelRoot)
    assert.deepEqual(raceState.kept.map(k => k.path), ['stable.md'], 'stale revision edited during beforeWrite must not enter cooldown while unchanged note commits')

    // 6e. Regression: missing month shards advance reliableStartAt past the last missing month,
    // and a missing current month leaves reliableStartAt undefined.
    const gapMonthRoot = join(root, 'gap-month-telemetry')
    mkdirSync(gapMonthRoot, { recursive: true })
    const augAt = Date.UTC(2026, 7, 25, 12, 0, 0) // 2026-08-25
    const sepAt = Date.UTC(2026, 8, 10, 12, 0, 0) // 2026-09-10
    const novAt = Date.UTC(2026, 10, 5, 12, 0, 0) // 2026-11-05 (2026-10 missing!)
    await appendTelemetryRow(baseRow(augAt, 't-aug'), { root: gapMonthRoot, now })
    await appendTelemetryRow(baseRow(sepAt, 't-sep'), { root: gapMonthRoot, now })
    await appendTelemetryRow(baseRow(novAt, 't-nov'), { root: gapMonthRoot, now })
    const gapMonthWin = readTelemetryWindow({ now, root: gapMonthRoot })
    assert.equal(gapMonthWin.coverage.complete, false)
    assert.ok(gapMonthWin.coverage.missingShards.includes('2026-10'))
    assert.ok(gapMonthWin.coverage.incompleteReasons.includes('missing_shards'))
    assert.equal(gapMonthWin.coverage.reliableStartAt, Date.UTC(2026, 10, 1, 0, 0, 0), 'reliableStartAt must not precede end of missing 2026-10')

    const missingCurRoot = join(root, 'missing-cur-month')
    mkdirSync(missingCurRoot, { recursive: true })
    await appendTelemetryRow(baseRow(augAt, 't-aug-2'), { root: missingCurRoot, now })
    await appendTelemetryRow(baseRow(sepAt, 't-sep-2'), { root: missingCurRoot, now })
    await appendTelemetryRow(baseRow(octAt, 't-oct-2'), { root: missingCurRoot, now })
    const missingCurWin = readTelemetryWindow({ now, root: missingCurRoot })
    assert.equal(missingCurWin.coverage.complete, false)
    assert.ok(missingCurWin.coverage.missingShards.includes('2026-11'))
    assert.ok(missingCurWin.coverage.incompleteReasons.includes('missing_shards'))
    assert.equal(missingCurWin.coverage.reliableStartAt, undefined, 'missing current month yields no reliable observation window up to now')

    // Symlink telemetry file/directory fails safely.
    const symlinkRoot = join(root, 'sym-telemetry')
    mkdirSync(symlinkRoot, { recursive: true })
    const targetFile = join(root, 'outside.txt')
    writeFileSync(targetFile, 'KEEP')
    symlinkSync(targetFile, join(symlinkRoot, '2026-11.jsonl'))
    assert.equal(await appendTelemetryRow(baseRow(now, 't-sym'), { root: symlinkRoot, now }), false)
    assert.equal(readFileSync(targetFile, 'utf8'), 'KEEP')
    const symRead = readTelemetryWindow({ now, root: symlinkRoot })
    assert.deepEqual(symRead.coverage.unreadableShards, ['2026-11'])

    // Enqueue the burst in one tick, so the writer cannot drain it before testing overflow.
    const queueRoot = join(root, 'queue-telemetry')
    const queueOptions = { root: queueRoot, now }
    const pending = Array.from({ length: 64 }, (_, i) =>
      appendTelemetryRow(baseRow(now - 4000, `queued-${i}`), queueOptions))
    const droppedAt = now - 2000
    assert.equal(await appendTelemetryRow(baseRow(droppedAt, 'overflow'), queueOptions), false)
    assert.ok((await Promise.all(pending)).every(Boolean))
    assert.equal(await appendTelemetryRow(baseRow(now - 1000, 'after-overflow'), queueOptions), true)
    const queueWin = readTelemetryWindow({ ...queueOptions, windowDays: 1 })
    assert.deepEqual(queueWin.rows.map(row => row.turnId), [
      ...Array.from({ length: 64 }, (_, i) => `queued-${i}`), 'after-overflow'
    ])
    assert.equal(queueWin.coverage.complete, false)
    assert.deepEqual(queueWin.coverage.incompleteReasons, ['dropped_appends'])
    assert.equal(queueWin.coverage.reliableStartAt, droppedAt + 1)

    if (process.platform !== 'win32') {
      // No peer opens these FIFOs. The isolated fixture timeout guards fail-fast behavior.
      const fifoRoot = join(root, 'fifo-telemetry')
      const fifoOptions = { root: fifoRoot, now }
      mkdirSync(join(fifoRoot, '.writer'), { recursive: true })
      const pidFifo = join(fifoRoot, '.writer', 'pid')
      const shardFifo = join(fifoRoot, '2026-11.jsonl')
      const auditFifo = join(fifoRoot, 'audit-state.json')
      const fifoSetup = await runChild(['mkfifo', pidFifo, shardFifo, auditFifo], { timeoutMs: 3000 })
      assert.equal(fifoSetup.exitCode, 0, fifoSetup.stderr)
      assert.equal(appendTelemetryRowSync(baseRow(now, 'fifo-pid'), fifoOptions), false)
      rmSync(pidFifo)
      rmSync(join(fifoRoot, '.writer'), { recursive: true })
      assert.equal(appendTelemetryRowSync(baseRow(now, 'fifo-shard'), fifoOptions), false)
      assert.deepEqual(readTelemetryWindow(fifoOptions).coverage.unreadableShards, ['2026-11'])
      assert.throws(() => readAuditState(fifoRoot), /DREAM_AUDIT_STATE/)
    }
    chmodSync(telemetryRoot, 0o700)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
} else {
  test('memory telemetry store shards by UTC month, enforces row/read limits, sanitizes fields, and protects audit-state', async () => {
    const result = await runSelf(import.meta.path, ['--telemetry-store-fixture'], { timeoutMs: 15_000 })
    assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  })
}
