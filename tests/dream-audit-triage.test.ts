import { test, mock } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSelf } from './helpers/subprocess'

if (process.argv.includes('--audit-triage-fixture')) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pig-audit-triage-')))
  const pigDir = join(root, 'pig')
  const liveRoot = join(pigDir, 'memory')
  const telemetryRoot = join(pigDir, 'memory-telemetry')
  process.env.PIG_DIR = pigDir
  mock.module('../src/main/pig-dir', () => ({ pigPath: (...parts: string[]) => join(pigDir, ...parts) }))

  const { MemoryFiles } = await import('../src/main/features/memory/long-term/files')
  const { appendTelemetryRow, AUDIT_COOLDOWN_MS, commitAuditKeeps } = await import('../src/main/features/memory/telemetry/store')
  const { buildAuditHealthReport, matchesStructuralKeep, structureDefectKey } = await import('../src/main/features/memory/dream/audit')
  const { DreamHistory } = await import('../src/main/features/memory/dream/history')

  const day = 86_400_000
  const now = Date.UTC(2026, 10, 19, 12, 0, 0)
  const projA = '1'.repeat(64)
  const forgedProj = 'f'.repeat(64)
  const globalStore = new MemoryFiles(join(liveRoot, 'global'), liveRoot)
  const projStore = new MemoryFiles(join(liveRoot, 'projects', projA), liveRoot)

  const touchDaysAgo = (store: InstanceType<typeof MemoryFiles>, path: string, daysAgo: number) => {
    const t = new Date(now - daysAgo * day)
    utimesSync(store.resolve(path), t, t)
  }

  try {
    // Prepare memory files in global and project A.
    const gIndex = globalStore.save('MEMORY.md', [
      '[Poisoned](poisoned.md)',
      '[Troubleshoot](troubleshoot.md)',
      '[Churn](churn.md)',
      '[Clickbait](clickbait.md)',
      '[TwoHop](twohop.md)',
      '[HopTarget](hop-target.md)',
      '[StaleDoc](stale-doc.md)',
      '[RecentDoc](recent-doc.md)',
      '[Broken](missing-target.md)'
    ].join('\n'), null)
    const gPoisoned = globalStore.save('poisoned.md', 'Wrong instruction', null)
    const gTroubleshoot = globalStore.save('troubleshoot.md', 'Valid troubleshooting guide', null)
    let gChurn = globalStore.save('churn.md', 'v1', null)
    const revChurn1 = gChurn.revision
    gChurn = globalStore.save('churn.md', 'v2', gChurn.revision)
    const revChurn2 = gChurn.revision
    gChurn = globalStore.save('churn.md', 'v3', gChurn.revision)
    const revChurn3 = gChurn.revision
    const gClickbait = globalStore.save('clickbait.md', 'Misleading note', null)
    const gTwoHop = globalStore.save('twohop.md', '[Next](hop-target.md)', null)
    const gHopTarget = globalStore.save('hop-target.md', 'Actual answer', null)
    const gStale = globalStore.save('stale-doc.md', 'Release rollback checklist', null)
    const gRecent = globalStore.save('recent-doc.md', 'Brand new note', null)
    const gOrphan = globalStore.save('orphan.md', 'Unlinked useful note', null)
    const pIndex = projStore.save('MEMORY.md', '[ProjNote](proj.md)', null)
    const pNote = projStore.save('proj.md', 'Project fact', null)

    touchDaysAgo(globalStore, 'stale-doc.md', 25)
    touchDaysAgo(globalStore, 'orphan.md', 25)
    touchDaysAgo(globalStore, 'recent-doc.md', 3)

    const verifiedProjects = new Map([[projA, { id: projA, name: 'Project A' }]])
    const history = new DreamHistory([])

    let turnSeq = 0
    const addRow = async (
      daysAgo: number,
      outcome: 'completed' | 'aborted' | 'error' | 'steered' | 'unknown',
      ops: any[],
      tail = { calls: 0, errs: 0 },
      opts: { projectId?: string; anchor?: boolean; opsTruncated?: boolean } = {}
    ) => {
      turnSeq++
      await appendTelemetryRow({
        v: 1,
        at: now - daysAgo * day + turnSeq * 1000,
        sessionId: `s-${turnSeq}`,
        turnId: `t-${turnSeq}`,
        ...(opts.anchor !== false ? { anchorEntryId: `a-${turnSeq}` } : {}),
        ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
        outcome,
        ops,
        tail,
        ...(opts.opsTruncated ? { opsTruncated: true } : {})
      }, { root: telemetryRoot, now })
    }

    // Telemetry spans >= 20 days ago so 14-day stale window has full reliable coverage.
    await addRow(20, 'completed', [
      { op: 'read', scope: 'global', ok: true, path: 'MEMORY.md', rev: gIndex.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }
    ])

    // 10 MEMORY.md initial-read turns over the last 18 days for stale threshold.
    for (let i = 0; i < 10; i++) {
      await addRow(18 - i, 'completed', [
        { op: 'read', scope: 'global', ok: true, path: 'MEMORY.md', rev: gIndex.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } },
        // Read twohop -> hop-target (normal 2nd hop from twohop.md; must NOT trigger clickbait!).
        ...(i < 4 ? [
          { op: 'read', scope: 'global', ok: true, path: 'twohop.md', from: 'MEMORY.md', rev: gTwoHop.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } },
          { op: 'read', scope: 'global', ok: true, path: 'hop-target.md', from: 'twohop.md', rev: gHopTarget.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }
        ] : [])
      ])
    }

    // Stale doc had ONLY a forMutationOnly read->edit in a project session (outer row.projectId = projA):
    // global op must ignore outer projectId when matching next global edit so maintenance read is NOT counted as recall.
    await addRow(5, 'completed', [
      { op: 'read', scope: 'global', ok: true, path: 'stale-doc.md', rev: gStale.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } },
      { op: 'edit', scope: 'global', ok: true, path: 'stale-doc.md', beforeRev: gStale.revision, afterRev: gStale.revision, gap: { calls: 0, errs: 0 } }
    ], { calls: 0, errs: 0 }, { projectId: projA })

    // Poisoned: 2 independent turns with post-read anomalies on current rev.
    await addRow(4, 'error', [
      { op: 'read', scope: 'global', ok: true, path: 'poisoned.md', rev: gPoisoned.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }
    ], { calls: 1, errs: 1 })
    await addRow(3, 'completed', [
      { op: 'read', scope: 'global', ok: true, path: 'poisoned.md', rev: gPoisoned.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }
    ], { calls: 1, errs: 1 })

    // Troubleshoot: pre-read errors occurred BEFORE reading troubleshoot.md and turn completed -> NOT poisoned.
    await addRow(4, 'completed', [
      { op: 'read', scope: 'global', ok: true, path: 'troubleshoot.md', rev: gTroubleshoot.revision, offset: 0, hasMore: false, gap: { calls: 2, errs: 2 } }
    ])
    await addRow(3, 'completed', [
      { op: 'read', scope: 'global', ok: true, path: 'troubleshoot.md', rev: gTroubleshoot.revision, offset: 0, hasMore: false, gap: { calls: 1, errs: 1 } }
    ])
    // Plus 1 single abort on troubleshoot.md is also insufficient (needs >=2 anomalies).
    await addRow(2, 'aborted', [
      { op: 'read', scope: 'global', ok: true, path: 'troubleshoot.md', rev: gTroubleshoot.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }
    ])

    // High churn: 3 independent turns with distinct substantive revisions (no post-read poisoning on revChurn3).
    await addRow(10, 'completed', [{ op: 'add', scope: 'global', ok: true, path: 'churn.md', afterRev: revChurn1, gap: { calls: 0, errs: 0 } }])
    await addRow(8, 'completed', [{ op: 'edit', scope: 'global', ok: true, path: 'churn.md', beforeRev: revChurn1, afterRev: revChurn2, gap: { calls: 0, errs: 0 } }])
    await addRow(6, 'completed', [{ op: 'edit', scope: 'global', ok: true, path: 'churn.md', beforeRev: revChurn2, afterRev: revChurn3, gap: { calls: 0, errs: 0 } }])
    // Same-rev edit on recent-doc.md repeated 4 times -> NOT high_churn!
    for (let i = 0; i < 4; i++) {
      await addRow(2, 'completed', [{ op: 'edit', scope: 'global', ok: true, path: 'recent-doc.md', beforeRev: gRecent.revision, afterRev: gRecent.revision, gap: { calls: 0, errs: 0 } }])
    }

    // Clickbait: opened 3 times from MEMORY.md; 2 of 3 immediately backtracked (gap.calls === 0) to search;
    // plus extra paged read (offset: 5) and same-turn reread that must NOT inflate denominator.
    for (let i = 0; i < 2; i++) {
      await addRow(5, 'completed', [
        { op: 'read', scope: 'global', ok: true, path: 'clickbait.md', from: 'MEMORY.md', rev: gClickbait.revision, offset: 0, hasMore: true, gap: { calls: 0, errs: 0 } },
        { op: 'read', scope: 'global', ok: true, path: 'clickbait.md', from: 'MEMORY.md', rev: gClickbait.revision, offset: 5, hasMore: false, gap: { calls: 0, errs: 0 } },
        { op: 'search', scope: 'global', ok: true, query: 'actual topic', hits: 1, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }
      ])
    }
    await addRow(4, 'completed', [
      { op: 'read', scope: 'global', ok: true, path: 'clickbait.md', from: 'MEMORY.md', rev: gClickbait.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }
    ], { calls: 1, errs: 0 })

    // Repeated misses:
    // - 'token rotation' has 2 independent zero-hit initial searches -> candidate!
    // - 'single miss' has only 1 -> NOT candidate!
    // - 'paged miss' only hit offset > 0 -> NOT candidate!
    // - 'failed search' has ok: false -> NOT candidate!
    // - 'excerpt hit' has hits: 1 -> NOT candidate!
    // - omitted query (undefined) -> NOT candidate!
    for (let i = 0; i < 2; i++) {
      await addRow(2, 'completed', [{ op: 'search', scope: 'project', ok: true, query: 'token rotation', hits: 0, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }], { calls: 0, errs: 0 }, { projectId: projA })
    }
    await addRow(2, 'completed', [{ op: 'search', scope: 'project', ok: true, query: 'single miss', hits: 0, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }], { calls: 0, errs: 0 }, { projectId: projA })
    await addRow(2, 'completed', [{ op: 'search', scope: 'project', ok: true, query: 'paged miss', hits: 0, offset: 10, hasMore: false, gap: { calls: 0, errs: 0 } }], { calls: 0, errs: 0 }, { projectId: projA })
    await addRow(2, 'completed', [{ op: 'search', scope: 'project', ok: true, query: 'paged miss', hits: 0, offset: 10, hasMore: false, gap: { calls: 0, errs: 0 } }], { calls: 0, errs: 0 }, { projectId: projA })
    await addRow(2, 'completed', [{ op: 'search', scope: 'project', ok: false, query: 'failed search', err: 'EIO', gap: { calls: 0, errs: 0 } }], { calls: 0, errs: 0 }, { projectId: projA })
    await addRow(2, 'completed', [{ op: 'search', scope: 'project', ok: false, query: 'failed search', err: 'EIO', gap: { calls: 0, errs: 0 } }], { calls: 0, errs: 0 }, { projectId: projA })
    await addRow(2, 'completed', [{ op: 'search', scope: 'project', ok: true, query: 'excerpt hit', hits: 2, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }], { calls: 0, errs: 0 }, { projectId: projA })
    await addRow(2, 'completed', [{ op: 'search', scope: 'project', ok: true, query: 'excerpt hit', hits: 2, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }], { calls: 0, errs: 0 }, { projectId: projA })
    await addRow(2, 'completed', [{ op: 'search', scope: 'project', ok: true, hits: 0, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }], { calls: 0, errs: 0 }, { projectId: projA })
    await addRow(2, 'completed', [{ op: 'search', scope: 'project', ok: true, hits: 0, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }], { calls: 0, errs: 0 }, { projectId: projA })

    // Empty-lookup weak lead in project A (truncated turn MUST NOT count as empty lookup!).
    // Placed 19 days ago so the recent 18-day uninterrupted span still qualifies for stale-doc.md while marking coverage incomplete.
    await addRow(2, 'completed', [{ op: 'list', scope: 'project', ok: true, count: 1, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }], { calls: 0, errs: 0 }, { projectId: projA })
    await addRow(1, 'completed', [{ op: 'read', scope: 'project', ok: true, path: 'MEMORY.md', rev: pIndex.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }], { calls: 0, errs: 0 }, { projectId: projA })
    await addRow(19, 'completed', [{ op: 'list', scope: 'global', ok: true, count: 1, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }], { calls: 0, errs: 0 }, { opsTruncated: true })

    // Unverified / unattributed project ops must NEVER leak into global or verified stats.
    for (let i = 0; i < 3; i++) {
      await addRow(2, 'error', [{ op: 'read', scope: 'project', projectId: forgedProj, ok: true, path: 'poisoned.md', rev: gPoisoned.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }], { calls: 1, errs: 1 })
      await addRow(2, 'completed', [{ op: 'search', scope: 'project', projectId: forgedProj, ok: true, query: 'forged miss', hits: 0, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }])
      // Missing project attribution altogether:
      await addRow(2, 'completed', [{ op: 'search', scope: 'project', ok: true, query: 'unattributed miss', hits: 0, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }])
    }

    const report = await buildAuditHealthReport({
      scope: { kind: 'all' },
      history,
      verifiedProjects,
      liveRoot,
      telemetryRoot,
      now,
      verifyHistory: false
    })

    // Assert priority 1: poisoned.md & churn.md found; troubleshoot.md & recent-doc.md excluded.
    const p1 = report.candidates.filter(c => c.priority === 1)
    assert.deepEqual(p1.map(c => `${c.kind}:${c.path}`).sort(), ['high_churn:churn.md', 'poisoned:poisoned.md'])
    const poisoned = p1.find(c => c.kind === 'poisoned')!
    assert.equal(poisoned.numerator, 2)
    assert.equal(poisoned.denominator, 2)

    // Assert priority 2: broken link in MEMORY.md, orphan.md, and clickbait.md; twohop.md NOT flagged.
    const p2 = report.candidates.filter(c => c.priority === 2)
    assert.ok(p2.some(c => c.kind === 'structure' && c.subkind === 'broken_link' && c.path === 'MEMORY.md'))
    assert.ok(p2.some(c => c.kind === 'structure' && c.subkind === 'orphan' && c.path === 'orphan.md'))
    const cb = p2.find(c => c.kind === 'clickbait' && c.path === 'clickbait.md')!
    assert.equal(cb.numerator, 2)
    assert.equal(cb.denominator, 3)
    assert.ok(!p2.some(c => c.path === 'twohop.md'), 'normal 2nd hop from twohop -> hop-target is not clickbait')

    // Assert priority 3: only 'token rotation' and empty_lookup weak leads (excluding opsTruncated global list turn).
    const p3 = report.candidates.filter(c => c.priority === 3)
    assert.deepEqual(p3.map(c => c.query ?? `${c.scope}:${c.subkind}`).sort(), ['global:empty_lookup', 'project:empty_lookup', 'token rotation'])
    const globalEmpty = p3.find(c => c.scope === 'global' && c.subkind === 'empty_lookup')!
    assert.equal(globalEmpty.weak, true)
    assert.equal(globalEmpty.numerator, 7, 'opsTruncated turn does not increment empty_lookup')
    const projEmpty = p3.find(c => c.scope === 'project' && c.subkind === 'empty_lookup')!
    assert.equal(projEmpty.weak, true)
    assert.equal(projEmpty.numerator, 2)

    // Assert priority 4: stale-doc.md flagged; recent-doc.md (<14d), orphan.md (excluded from stale), proj.md (<10 project index reads) excluded.
    assert.equal(report.coverage.complete, false, 'truncated row marks coverage incomplete')
    assert.ok(report.coverage.incompleteReasons.includes('truncated_rows'))
    assert.equal(report.coverage.truncatedRows, 1)
    const p4 = report.candidates.filter(c => c.priority === 4)
    assert.deepEqual(p4.map(c => c.path), ['stale-doc.md'])
    assert.match(p4[0]!.reason, /No direct reads observed within window/)
    assert.equal(p4[0]!.numerator, 0)
    assert.equal(p4[0]!.denominator, 10)
    assert.equal(p4[0]!.rev, gStale.revision)

    // Assert scope filtering: project-only audit excludes global candidates; global-only excludes project candidates.
    const projReport = await buildAuditHealthReport({ scope: { kind: 'project', projectId: projA }, history, verifiedProjects, liveRoot, telemetryRoot, now, verifyHistory: false })
    assert.ok(projReport.candidates.every(c => c.scope === 'project' && c.projectId === projA))
    assert.ok(projReport.candidates.some(c => c.query === 'token rotation'))
    assert.equal(pNote.path, 'proj.md')

    // Assert unverified single project fails with DREAM_SCOPE.
    await assert.rejects(
      buildAuditHealthReport({ scope: { kind: 'project', projectId: forgedProj }, history, verifiedProjects, liveRoot, telemetryRoot, now, verifyHistory: false }),
      /DREAM_SCOPE/
    )

    // Cooldown tests:
    // 1. Keep stale-doc.md & poisoned.md -> suppressed within 60 days when no new signal & same rev.
    await commitAuditKeeps([
      { scope: 'global', path: 'stale-doc.md', rev: gStale.revision, kind: 'stale', checkedAt: now, signalThrough: 0 },
      { scope: 'global', path: 'poisoned.md', rev: gPoisoned.revision, kind: 'poisoned', checkedAt: now, signalThrough: poisoned.signalThrough }
    ], () => true, { root: telemetryRoot, now })

    const suppressed = await buildAuditHealthReport({ scope: { kind: 'all' }, history, verifiedProjects, liveRoot, telemetryRoot, now: now + 5 * day, verifyHistory: false })
    assert.ok(!suppressed.candidates.some(c => c.path === 'stale-doc.md'), 'stale cooldown suppresses same rev within 60 days')
    assert.ok(!suppressed.candidates.some(c => c.path === 'poisoned.md'), 'poisoned cooldown suppresses same rev without newer signal')
    assert.ok(suppressed.suppressedCount >= 2)

    // 2. Old sample sliding out of the 90-day window does NOT count as a new signal for stale/poisoned.
    const slid = await buildAuditHealthReport({ scope: { kind: 'all' }, history, verifiedProjects, liveRoot, telemetryRoot, now: now + 35 * day, verifyHistory: false })
    assert.ok(!slid.candidates.some(c => c.path === 'stale-doc.md'))
    assert.ok(!slid.candidates.some(c => c.path === 'poisoned.md'))

    // 3. After 60 days cooldown expiry -> re-triggers even without new signal (with continuous coverage up to evaluation time).
    await commitAuditKeeps([
      { scope: 'global', path: 'stale-doc.md', rev: gStale.revision, kind: 'stale', checkedAt: now - AUDIT_COOLDOWN_MS - 1000, signalThrough: 0 },
      { scope: 'global', path: 'poisoned.md', rev: gPoisoned.revision, kind: 'poisoned', checkedAt: now, signalThrough: poisoned.signalThrough }
    ], () => true, { root: telemetryRoot, now })
    const expired = await buildAuditHealthReport({ scope: { kind: 'all' }, history, verifiedProjects, liveRoot, telemetryRoot, now, verifyHistory: false })
    assert.ok(expired.candidates.some(c => c.kind === 'stale' && c.path === 'stale-doc.md'), 'stale re-triggers after 60-day cooldown expiry')
    // Re-stamp stale-doc.md fresh before testing that stale cooldown never suppresses new poisoned signal.
    await commitAuditKeeps([
      { scope: 'global', path: 'stale-doc.md', rev: gStale.revision, kind: 'stale', checkedAt: now, signalThrough: 0 }
    ], () => true, { root: telemetryRoot, now })

    // 4. Stale keep cooldown MUST NOT suppress a new poisoned signal on stale-doc.md!
    const afterKeepTime = now + 6 * day
    await appendTelemetryRow({
      v: 1, at: afterKeepTime, sessionId: 's-stale-p1', turnId: 't-sp1', anchorEntryId: 'a-sp1',
      outcome: 'error', ops: [{ op: 'read', scope: 'global', ok: true, path: 'stale-doc.md', rev: gStale.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }],
      tail: { calls: 1, errs: 1 }
    }, { root: telemetryRoot, now: afterKeepTime })
    await appendTelemetryRow({
      v: 1, at: afterKeepTime + 1000, sessionId: 's-stale-p2', turnId: 't-sp2', anchorEntryId: 'a-sp2',
      outcome: 'error', ops: [{ op: 'read', scope: 'global', ok: true, path: 'stale-doc.md', rev: gStale.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }],
      tail: { calls: 1, errs: 1 }
    }, { root: telemetryRoot, now: afterKeepTime + 1000 })

    // Also add a newer negative signal for poisoned.md -> breaks poisoned cooldown!
    await appendTelemetryRow({
      v: 1, at: afterKeepTime + 2000, sessionId: 's-p-new', turnId: 't-p-new', anchorEntryId: 'a-p-new',
      outcome: 'error', ops: [{ op: 'read', scope: 'global', ok: true, path: 'poisoned.md', rev: gPoisoned.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }],
      tail: { calls: 1, errs: 1 }
    }, { root: telemetryRoot, now: afterKeepTime + 2000 })

    const retriggered = await buildAuditHealthReport({ scope: { kind: 'all' }, history, verifiedProjects, liveRoot, telemetryRoot, now: afterKeepTime + 5000, verifyHistory: false })
    assert.ok(retriggered.candidates.some(c => c.kind === 'poisoned' && c.path === 'stale-doc.md'), 'stale cooldown never suppresses new poisoned signal')
    assert.ok(retriggered.candidates.some(c => c.kind === 'poisoned' && c.path === 'poisoned.md'), 'new post-keep signal re-triggers poisoned candidate')

    // 5. Insufficient reliable coverage (<14 days or corrupt current shard) never reports stale.
    const shortRoot = join(root, 'short-telemetry')
    mkdirSync(shortRoot, { recursive: true })
    await appendTelemetryRow({
      v: 1, at: now - 5 * day, sessionId: 's-short', turnId: 't-short', outcome: 'completed',
      ops: [{ op: 'read', scope: 'global', ok: true, path: 'MEMORY.md', rev: gIndex.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }],
      tail: { calls: 0, errs: 0 }
    }, { root: shortRoot, now })
    const shortReport = await buildAuditHealthReport({ scope: { kind: 'all' }, history, verifiedProjects, liveRoot, telemetryRoot: shortRoot, now, verifyHistory: false })
    assert.equal(shortReport.candidates.filter(c => c.kind === 'stale').length, 0, 'under-14-day telemetry never flags stale notes')

    // Corrupt current shard suppresses stale.
    const novFile = join(telemetryRoot, '2026-11.jsonl')
    writeFileSync(novFile, '{"corrupt":true\n', { flag: 'a' })
    const corruptReport = await buildAuditHealthReport({ scope: { kind: 'all' }, history, verifiedProjects, liveRoot, telemetryRoot, now, verifyHistory: false })
    assert.equal(corruptReport.candidates.filter(c => c.kind === 'stale').length, 0, 'corrupt current shard prevents stale false positives')
    assert.equal(gOrphan.path, 'orphan.md')
    assert.equal(gRecent.path, 'recent-doc.md')

    // 6. Regression: opsTruncated turns cannot produce stale candidates, yet preserve affirmative signals.
    const truncLive = join(root, 'trunc-live')
    const truncTelemetry = join(root, 'trunc-telemetry')
    const truncStore = new MemoryFiles(join(truncLive, 'global'), truncLive)
    const truncIdx = truncStore.save('MEMORY.md', '[Entry](entry.md)\n[Bad](bad.md)', null)
    const truncEntry = truncStore.save('entry.md', 'Maybe read in truncated tail', null)
    const truncBad = truncStore.save('bad.md', 'Affirmative poisoned note', null)
    touchDaysAgo(truncStore, 'entry.md', 25)
    touchDaysAgo(truncStore, 'bad.md', 25)
    for (let i = 0; i < 10; i++) {
      await appendTelemetryRow({
        v: 1, at: now - (20 - i) * day, sessionId: `tr-s-${i}`, turnId: `tr-t-${i}`, anchorEntryId: `tr-a-${i}`,
        outcome: 'completed',
        ops: [{ op: 'read', scope: 'global', ok: true, path: 'MEMORY.md', rev: truncIdx.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }],
        tail: { calls: 0, errs: 0 },
        opsTruncated: true
      }, { root: truncTelemetry, now })
    }
    const onlyTruncReport = await buildAuditHealthReport({
      scope: { kind: 'global' }, history, verifiedProjects: new Map(), liveRoot: truncLive, telemetryRoot: truncTelemetry, now, verifyHistory: false
    })
    assert.equal(onlyTruncReport.coverage.complete, false)
    assert.ok(onlyTruncReport.coverage.incompleteReasons.includes('truncated_rows'))
    assert.equal(onlyTruncReport.coverage.truncatedRows, 10)
    assert.equal(onlyTruncReport.candidates.filter(c => c.kind === 'stale').length, 0, '10 truncated MEMORY.md turns never mark entry.md stale')

    // Even with 10 complete MEMORY.md turns, a single truncated turn inside the 14-day window prevents crossing the gap for stale,
    // while affirmative signals (poisoned + zero_hit_query) inside the truncated turn remain detected.
    const gapTelemetry = join(root, 'gap-telemetry')
    for (let i = 0; i < 10; i++) {
      await appendTelemetryRow({
        v: 1, at: now - (18 - i) * day, sessionId: `gap-ok-${i}`, turnId: `gap-t-${i}`, anchorEntryId: `gap-a-${i}`,
        outcome: 'completed',
        ops: [{ op: 'read', scope: 'global', ok: true, path: 'MEMORY.md', rev: truncIdx.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }],
        tail: { calls: 0, errs: 0 }
      }, { root: gapTelemetry, now })
    }
    for (let i = 0; i < 2; i++) {
      await appendTelemetryRow({
        v: 1, at: now - (3 - i) * day, sessionId: `gap-tr-${i}`, turnId: `gap-tr-t-${i}`, anchorEntryId: `gap-tr-a-${i}`,
        outcome: 'error',
        ops: [
          { op: 'read', scope: 'global', ok: true, path: 'bad.md', rev: truncBad.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } },
          { op: 'search', scope: 'global', ok: true, query: 'missing playbook', hits: 0, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }
        ],
        tail: { calls: 1, errs: 1 },
        opsTruncated: true
      }, { root: gapTelemetry, now })
    }
    const gapReport = await buildAuditHealthReport({
      scope: { kind: 'global' }, history, verifiedProjects: new Map(), liveRoot: truncLive, telemetryRoot: gapTelemetry, now, verifyHistory: false
    })
    assert.equal(gapReport.coverage.complete, false)
    assert.ok(gapReport.coverage.incompleteReasons.includes('truncated_rows'))
    assert.equal(gapReport.candidates.filter(c => c.kind === 'stale').length, 0, 'cannot infer unread across a truncated gap in the window')
    assert.ok(gapReport.candidates.some(c => c.kind === 'poisoned' && c.path === 'bad.md'), 'affirmative poisoned signal survives truncation')
    assert.ok(gapReport.candidates.some(c => c.kind === 'repeated_miss' && c.query === 'missing playbook'), 'affirmative zero-hit query survives truncation')
    assert.equal(truncEntry.path, 'entry.md')

    // 7. Regression: redacted pathOmitted op preserves order & sibling ops without triggering empty_lookup.
    const omitTelemetry = join(root, 'omit-telemetry')
    for (let i = 0; i < 2; i++) {
      await appendTelemetryRow({
        v: 1, at: now - (2 - i) * day, sessionId: `om-${i}`, turnId: `om-t-${i}`, anchorEntryId: `om-a-${i}`,
        outcome: 'completed',
        ops: [
          { op: 'read', scope: 'global', ok: true, path: 'MEMORY.md', rev: truncIdx.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } },
          { op: 'read', scope: 'global', ok: true, pathOmitted: true, from: 'MEMORY.md', rev: truncEntry.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } },
          { op: 'search', scope: 'global', ok: true, query: 'redacted sibling', hits: 0, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }
        ],
        tail: { calls: 0, errs: 0 }
      }, { root: omitTelemetry, now })
    }
    const omitReport = await buildAuditHealthReport({
      scope: { kind: 'global' }, history, verifiedProjects: new Map(), liveRoot: truncLive, telemetryRoot: omitTelemetry, now, verifyHistory: false
    })
    assert.equal(omitReport.coverage.skippedLines, 0)
    assert.ok(omitReport.candidates.some(c => c.kind === 'repeated_miss' && c.query === 'redacted sibling'))
    assert.ok(!omitReport.candidates.some(c => c.subkind === 'empty_lookup'), 'redacted read prevents false empty_lookup')

    // 8. Regression: orphan reachability and whole-scope broken links are separate (A -> B -> missing.md).
    const graphLive = join(root, 'graph-live')
    const graphTelemetry = join(root, 'graph-telemetry')
    const graphStore = new MemoryFiles(join(graphLive, 'global'), graphLive)
    graphStore.save('MEMORY.md', '# Index\nNo links here.', null)
    const orphanA = graphStore.save('a.md', 'Links to [B](b.md) and [C](c.md)', null)
    const orphanB = graphStore.save('b.md', 'Links to [Missing](missing.md)', null)
    const orphanC = graphStore.save('c.md', 'Leaf note C', null)
    const legacyOrphan = graphStore.save('legacy.md', 'Legacy orphan', null)

    const graphReport1 = await buildAuditHealthReport({
      scope: { kind: 'global' }, history, verifiedProjects: new Map(), liveRoot: graphLive, telemetryRoot: graphTelemetry, now, verifyHistory: false
    })
    const graphOrphans = graphReport1.candidates.filter(c => c.kind === 'structure' && c.subkind === 'orphan').map(c => c.path).sort()
    assert.deepEqual(graphOrphans, ['a.md', 'b.md', 'c.md', 'legacy.md'], 'orphan-to-orphan links never confer reachability')
    const graphBrokenB = graphReport1.candidates.find(c => c.kind === 'structure' && c.subkind === 'broken_link' && c.path === 'b.md')
    assert.ok(graphBrokenB, 'broken link inside unreachable orphan B must still be reported')
    assert.deepEqual(graphBrokenB!.brokenLinks, ['missing.md'])

    // 9. Regression: structural cooldown distinguishes subkind & defectKey, and legacy broad keeps never match.
    const orphanACand = graphReport1.candidates.find(c => c.kind === 'structure' && c.subkind === 'orphan' && c.path === 'a.md')!
    await commitAuditKeeps([
      {
        scope: 'global', path: 'a.md', rev: orphanA.revision, kind: 'structure',
        subkind: 'orphan', defectKey: orphanACand.defectKey, checkedAt: now, signalThrough: 0
      },
      // Legacy broad structure keep without subkind/defectKey for legacy.md:
      {
        scope: 'global', path: 'legacy.md', rev: legacyOrphan.revision, kind: 'structure',
        checkedAt: now, signalThrough: 0
      }
    ], () => true, { root: graphTelemetry, now })

    // Verify orphan A is suppressed while legacy broad keep does NOT suppress legacy.md.
    const graphReportKeptOrphan = await buildAuditHealthReport({
      scope: { kind: 'global' }, history, verifiedProjects: new Map(), liveRoot: graphLive, telemetryRoot: graphTelemetry, now: now + day, verifyHistory: false
    })
    assert.ok(!graphReportKeptOrphan.candidates.some(c => c.subkind === 'orphan' && c.path === 'a.md'), 'exact orphan keep suppresses orphan A within 60 days')
    assert.ok(graphReportKeptOrphan.candidates.some(c => c.subkind === 'orphan' && c.path === 'legacy.md'), 'legacy broad structure keep never suppresses precise defect')

    // Now delete B while leaving A untouched (same rev!): A must now report broken_link for b.md!
    graphStore.delete('b.md', orphanB.revision)
    const graphReportAfterDelB = await buildAuditHealthReport({
      scope: { kind: 'global' }, history, verifiedProjects: new Map(), liveRoot: graphLive, telemetryRoot: graphTelemetry, now: now + 2 * day, verifyHistory: false
    })
    assert.ok(!graphReportAfterDelB.candidates.some(c => c.subkind === 'orphan' && c.path === 'a.md'), 'orphan A stays suppressed')
    const brokenA1 = graphReportAfterDelB.candidates.find(c => c.subkind === 'broken_link' && c.path === 'a.md')
    assert.ok(brokenA1, 'deleting B must re-flag A for broken_link even with unchanged A rev')
    assert.deepEqual(brokenA1!.brokenLinks, ['b.md'])

    // Stamp broken_link for A (only b.md broken), confirm suppressed, then delete C (same A rev!) -> defect changes -> must re-flag!
    await commitAuditKeeps([{
      scope: 'global', path: 'a.md', rev: orphanA.revision, kind: 'structure',
      subkind: 'broken_link', defectKey: brokenA1!.defectKey, checkedAt: now + 2 * day, signalThrough: 0
    }], () => true, { root: graphTelemetry, now: now + 2 * day })
    const graphReportSuppressedBroken = await buildAuditHealthReport({
      scope: { kind: 'global' }, history, verifiedProjects: new Map(), liveRoot: graphLive, telemetryRoot: graphTelemetry, now: now + 3 * day, verifyHistory: false
    })
    assert.ok(!graphReportSuppressedBroken.candidates.some(c => c.subkind === 'broken_link' && c.path === 'a.md'), 'exact broken_link defect is suppressed within 60 days')

    graphStore.delete('c.md', orphanC.revision)
    const graphReportAfterDelC = await buildAuditHealthReport({
      scope: { kind: 'global' }, history, verifiedProjects: new Map(), liveRoot: graphLive, telemetryRoot: graphTelemetry, now: now + 4 * day, verifyHistory: false
    })
    const brokenA2 = graphReportAfterDelC.candidates.find(c => c.subkind === 'broken_link' && c.path === 'a.md')
    assert.ok(brokenA2, 'adding a second broken link on the same rev changes defectKey and re-flags A')
    assert.deepEqual(brokenA2!.brokenLinks?.slice().sort(), ['b.md', 'c.md'])
    assert.notEqual(brokenA2!.defectKey, structureDefectKey('broken_link', { brokenLinks: ['b.md'] }))

    const orphanKeep = { scope: 'global', path: 'a.md', subkind: 'orphan', defectKey: orphanACand.defectKey } as const
    const brokenKeep = { scope: 'global', path: 'a.md', subkind: 'broken_link', defectKey: brokenA2!.defectKey } as const
    assert.equal(matchesStructuralKeep(graphLive, orphanKeep), true)
    assert.equal(matchesStructuralKeep(graphLive, brokenKeep), true)
    graphStore.save('MEMORY.md', '[A](a.md)', graphStore.read('MEMORY.md').revision)
    graphStore.save('b.md', 'Restored B', null)
    graphStore.save('c.md', 'Restored C', null)
    assert.equal(graphStore.read('a.md').revision, orphanA.revision)
    assert.equal(matchesStructuralKeep(graphLive, orphanKeep), false, 'linking an unchanged orphan resolves the lead')
    assert.equal(matchesStructuralKeep(graphLive, brokenKeep), false, 'restoring targets resolves the lead without editing the source')

    // 10. Regression: preprocessTurns compares actual scopeKey (project session editing global + project override mismatch).
    const scopeLive = join(root, 'scope-live')
    const scopeTelemetry = join(root, 'scope-telemetry')
    const projB = '2'.repeat(64)
    const sgStore = new MemoryFiles(join(scopeLive, 'global'), scopeLive)
    const spAStore = new MemoryFiles(join(scopeLive, 'projects', projA), scopeLive)
    const spBStore = new MemoryFiles(join(scopeLive, 'projects', projB), scopeLive)
    const sgNote = sgStore.save('global-note.md', 'Global rule', null)
    const spANote = spAStore.save('same.md', 'Project A note', null)
    const spBNote = spBStore.save('same.md', 'Project B note', null)
    // Two error turns in project A session doing read(global) -> edit(global): must be forMutationOnly, NOT poisoned recall!
    for (let i = 0; i < 2; i++) {
      await appendTelemetryRow({
        v: 1, at: now - (3 - i) * day, sessionId: `sc-g-${i}`, turnId: `sc-gt-${i}`, anchorEntryId: `sc-ga-${i}`,
        projectId: projA, outcome: 'error',
        ops: [
          { op: 'read', scope: 'global', ok: true, path: 'global-note.md', rev: sgNote.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } },
          { op: 'edit', scope: 'global', ok: true, path: 'global-note.md', beforeRev: sgNote.revision, afterRev: sgNote.revision, gap: { calls: 0, errs: 0 } }
        ],
        tail: { calls: 1, errs: 1 }
      }, { root: scopeTelemetry, now })
    }
    // Two error turns in project A session doing read(project B override) -> delete(project B override): forMutationOnly!
    // And two error turns doing read(project A) -> edit(project B override): DIFFERENT scopeKey -> NOT forMutationOnly -> poisoned!
    for (let i = 0; i < 2; i++) {
      await appendTelemetryRow({
        v: 1, at: now - (2 - i) * day, sessionId: `sc-p-${i}`, turnId: `sc-pt-${i}`, anchorEntryId: `sc-pa-${i}`,
        projectId: projA, outcome: 'error',
        ops: [
          { op: 'read', scope: 'project', projectId: projB, ok: true, path: 'same.md', rev: spBNote.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } },
          { op: 'delete', scope: 'project', projectId: projB, ok: false, path: 'same.md', err: 'READ_ONLY', gap: { calls: 0, errs: 0 } }
        ],
        tail: { calls: 1, errs: 1 }
      }, { root: scopeTelemetry, now })
      await appendTelemetryRow({
        v: 1, at: now - (2 - i) * day + 500, sessionId: `sc-x-${i}`, turnId: `sc-xt-${i}`, anchorEntryId: `sc-xa-${i}`,
        projectId: projA, outcome: 'error',
        ops: [
          { op: 'read', scope: 'project', ok: true, path: 'same.md', rev: spANote.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } },
          { op: 'edit', scope: 'project', projectId: projB, ok: true, path: 'same.md', beforeRev: spBNote.revision, afterRev: spBNote.revision, gap: { calls: 0, errs: 0 } }
        ],
        tail: { calls: 1, errs: 1 }
      }, { root: scopeTelemetry, now })
    }
    const scopeReport = await buildAuditHealthReport({
      scope: { kind: 'all' },
      history,
      verifiedProjects: new Map([[projA, { id: projA, name: 'A' }], [projB, { id: projB, name: 'B' }]]),
      liveRoot: scopeLive,
      telemetryRoot: scopeTelemetry,
      now,
      verifyHistory: false
    })
    assert.ok(!scopeReport.candidates.some(c => c.kind === 'poisoned' && c.path === 'global-note.md'), 'global read->edit inside project session is maintenance-only, not recall')
    assert.ok(!scopeReport.candidates.some(c => c.kind === 'poisoned' && c.projectId === projB && c.path === 'same.md'), 'matching project override read->delete is maintenance-only')
    assert.ok(scopeReport.candidates.some(c => c.kind === 'poisoned' && c.projectId === projA && c.path === 'same.md'), 'cross-project read(A)->edit(B) is still real recall on A')

    // 11. Regression: missing month gap (2026-10 absent) must prevent cross-gap stale inference while preserving earlier affirmative signals,
    // and sufficient post-gap coverage (10 complete reads in 2026-11 over >=14 days) must still detect stale normally.
    const monthGapLive = join(root, 'month-gap-live')
    const monthGapTelemetry = join(root, 'month-gap-telemetry')
    const mgStore = new MemoryFiles(join(monthGapLive, 'global'), monthGapLive)
    const mgIdx = mgStore.save('MEMORY.md', '[Entry](entry.md)\n[OldBad](old-bad.md)', null)
    const mgEntry = mgStore.save('entry.md', 'Unread candidate across month gap', null)
    const mgOldBad = mgStore.save('old-bad.md', 'Poisoned before month gap', null)
    touchDaysAgo(mgStore, 'entry.md', 80)
    touchDaysAgo(mgStore, 'old-bad.md', 80)

    // 8/9 月合计 10 次 MEMORY.md 首读 + 肯定事实（2 次 poisoned 异常与 2 次 zero_hit_query）; 10 月无分片; 11 月仅 3 次首读.
    const preGapTimes = [
      Date.UTC(2026, 7, 23, 10, 0, 0), Date.UTC(2026, 7, 25, 10, 0, 0), Date.UTC(2026, 7, 27, 10, 0, 0),
      Date.UTC(2026, 7, 29, 10, 0, 0), Date.UTC(2026, 7, 30, 10, 0, 0),
      Date.UTC(2026, 8, 2, 10, 0, 0), Date.UTC(2026, 8, 5, 10, 0, 0), Date.UTC(2026, 8, 10, 10, 0, 0),
      Date.UTC(2026, 8, 15, 10, 0, 0), Date.UTC(2026, 8, 20, 10, 0, 0)
    ]
    for (let i = 0; i < preGapTimes.length; i++) {
      const at = preGapTimes[i]!
      await appendTelemetryRow({
        v: 1, at, sessionId: `mg-pre-${i}`, turnId: `mg-pt-${i}`, anchorEntryId: `mg-pa-${i}`,
        outcome: i < 2 ? 'error' : 'completed',
        ops: [
          { op: 'read', scope: 'global', ok: true, path: 'MEMORY.md', rev: mgIdx.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } },
          ...(i < 2 ? [
            { op: 'read' as const, scope: 'global' as const, ok: true, path: 'old-bad.md', rev: mgOldBad.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } },
            { op: 'search' as const, scope: 'global' as const, ok: true, query: 'pre gap miss', hits: 0, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }
          ] : [])
        ],
        tail: i < 2 ? { calls: 1, errs: 1 } : { calls: 0, errs: 0 }
      }, { root: monthGapTelemetry, now })
    }
    // Only 3 reads in 2026-11 so far (2026-10 is completely missing).
    for (let i = 0; i < 3; i++) {
      await appendTelemetryRow({
        v: 1, at: Date.UTC(2026, 10, 2 + i * 4, 10, 0, 0), sessionId: `mg-nov-${i}`, turnId: `mg-nt-${i}`, anchorEntryId: `mg-na-${i}`,
        outcome: 'completed',
        ops: [{ op: 'read', scope: 'global', ok: true, path: 'MEMORY.md', rev: mgIdx.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }],
        tail: { calls: 0, errs: 0 }
      }, { root: monthGapTelemetry, now })
    }
    const mgReportGap = await buildAuditHealthReport({
      scope: { kind: 'global' }, history, verifiedProjects: new Map(), liveRoot: monthGapLive, telemetryRoot: monthGapTelemetry, now, verifyHistory: false
    })
    assert.ok(mgReportGap.coverage.missingShards.includes('2026-10'))
    assert.ok(mgReportGap.coverage.incompleteReasons.includes('missing_shards'))
    assert.equal(mgReportGap.coverage.reliableStartAt, Date.UTC(2026, 10, 1, 0, 0, 0))
    assert.equal(mgReportGap.candidates.filter(c => c.kind === 'stale').length, 0, 'must NOT count Aug/Sep index reads across missing Oct shard to flag stale')
    assert.ok(mgReportGap.candidates.some(c => c.kind === 'poisoned' && c.path === 'old-bad.md'), 'pre-gap affirmative poisoned signal is preserved')
    assert.ok(mgReportGap.candidates.some(c => c.kind === 'repeated_miss' && c.query === 'pre gap miss'), 'pre-gap affirmative zero-hit miss is preserved')

    // Missing current month (2026-11 absent, 2026-08/09/10 present) -> no reliable coverage to now -> 0 stale, affirmative signals preserved.
    const mgCurMissingTel = join(root, 'month-gap-cur-missing')
    for (let i = 0; i < preGapTimes.length; i++) {
      const at = preGapTimes[i]!
      await appendTelemetryRow({
        v: 1, at, sessionId: `mc-pre-${i}`, turnId: `mc-pt-${i}`, anchorEntryId: `mc-pa-${i}`,
        outcome: i < 2 ? 'error' : 'completed',
        ops: [
          { op: 'read', scope: 'global', ok: true, path: 'MEMORY.md', rev: mgIdx.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } },
          ...(i < 2 ? [{ op: 'read' as const, scope: 'global' as const, ok: true, path: 'old-bad.md', rev: mgOldBad.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }] : [])
        ],
        tail: i < 2 ? { calls: 1, errs: 1 } : { calls: 0, errs: 0 }
      }, { root: mgCurMissingTel, now })
    }
    await appendTelemetryRow({
      v: 1, at: Date.UTC(2026, 9, 15, 10, 0, 0), sessionId: 'mc-oct-1', turnId: 'mc-ot-1', anchorEntryId: 'mc-oa-1',
      outcome: 'completed',
      ops: [{ op: 'read', scope: 'global', ok: true, path: 'MEMORY.md', rev: mgIdx.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }],
      tail: { calls: 0, errs: 0 }
    }, { root: mgCurMissingTel, now })
    const mgCurMissingReport = await buildAuditHealthReport({
      scope: { kind: 'global' }, history, verifiedProjects: new Map(), liveRoot: monthGapLive, telemetryRoot: mgCurMissingTel, now, verifyHistory: false
    })
    assert.equal(mgCurMissingReport.coverage.reliableStartAt, undefined)
    assert.equal(mgCurMissingReport.candidates.filter(c => c.kind === 'stale').length, 0)
    assert.ok(mgCurMissingReport.candidates.some(c => c.kind === 'poisoned' && c.path === 'old-bad.md'))

    // Now add 7 more complete MEMORY.md reads in 2026-11 (total 10 post-gap reads over 18.5 continuous days >= 14d):
    // stale detection must succeed using ONLY the post-gap continuous span (denominator === 10, not 20)!
    for (let i = 0; i < 7; i++) {
      await appendTelemetryRow({
        v: 1, at: Date.UTC(2026, 10, 3 + i * 2, 12, 0, 0), sessionId: `mg-nov-more-${i}`, turnId: `mg-nmt-${i}`, anchorEntryId: `mg-nma-${i}`,
        outcome: 'completed',
        ops: [{ op: 'read', scope: 'global', ok: true, path: 'MEMORY.md', rev: mgIdx.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }],
        tail: { calls: 0, errs: 0 }
      }, { root: monthGapTelemetry, now })
    }
    const mgReportPostGap = await buildAuditHealthReport({
      scope: { kind: 'global' }, history, verifiedProjects: new Map(), liveRoot: monthGapLive, telemetryRoot: monthGapTelemetry, now, verifyHistory: false
    })
    const mgStale = mgReportPostGap.candidates.find(c => c.kind === 'stale' && c.path === 'entry.md')
    assert.ok(mgStale, 'sufficient post-gap coverage (>=14d and >=10 reads in Nov) still flags entry.md as stale')
    assert.equal(mgStale!.numerator, 0)
    assert.equal(mgStale!.denominator, 10, 'stale denominator counts only post-gap Nov turns, excluding pre-gap Aug/Sep turns')
    assert.equal(mgEntry.path, 'entry.md')

    const isolatedLive = join(root, 'topic-and-clickbait-live')
    const isolatedTel = join(root, 'topic-and-clickbait-telemetry')
    const isolated = new MemoryFiles(join(isolatedLive, 'global'), isolatedLive)
    const index = isolated.save('MEMORY.md', '[Sources](source-a.md) [More](source-b.md)', null)
    const firstSource = isolated.save('source-a.md', '[Target](target.md)', null)
    const secondSource = isolated.save('source-b.md', '[Target](target.md)', null)
    const target = isolated.save('target.md', 'Target content', null)
    for (let i = 0; i < 6; i++) isolated.save(`unrelated-${i}.md`, '[Broken](missing.md)', null)
    const isolatedReport = (topicFilter?: { topic: string; paths?: string[] }) => buildAuditHealthReport({
      scope: { kind: 'global' }, history, verifiedProjects: new Map(), liveRoot: isolatedLive,
      telemetryRoot: isolatedTel, now, verifyHistory: false, topicFilter
    })
    for (const from of [firstSource.path, secondSource.path]) {
      for (let i = 0; i < 3; i++) {
        await appendTelemetryRow({
          v: 1, at: now - 1000 - i, sessionId: from, turnId: `cb-${i}`, outcome: 'completed',
          ops: [
            { op: 'read', scope: 'global', ok: true, path: target.path, rev: target.revision, from, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } },
            { op: 'list', scope: 'global', ok: true, count: 1, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }
          ],
          tail: { calls: 0, errs: 0 }
        }, { root: isolatedTel, now })
      }
    }
    const full = await isolatedReport()
    assert.equal(full.candidates.filter(c => c.priority === 2).length, 5)
    assert.ok(!full.candidates.some(c => c.path === target.path))
    const topicFilter = { topic: 'irrelevant topic', paths: [target.path] }
    const clickbaitSources = async () => (await isolatedReport(topicFilter)).candidates.map(c => {
      assert.equal(c.kind, 'clickbait')
      return c.from
    }).sort()
    assert.deepEqual(await clickbaitSources(), [firstSource.path, secondSource.path])
    assert.deepEqual((await isolatedReport({ topic: 'source-a' })).candidates.map(c => c.from), [firstSource.path])

    const keep = { scope: 'global', kind: 'clickbait', path: target.path, rev: target.revision, checkedAt: now, signalThrough: now } as const
    await commitAuditKeeps([keep], () => true, { root: isolatedTel, now })
    assert.deepEqual(await clickbaitSources(), [firstSource.path, secondSource.path], 'legacy keeps cannot suppress an entry pair')
    await commitAuditKeeps([{ ...keep, from: firstSource.path, fromRev: firstSource.revision }], () => true, { root: isolatedTel, now })
    assert.deepEqual(await clickbaitSources(), [secondSource.path], 'keeping one entry must not suppress a different source')
    isolated.save(firstSource.path, '[Updated target clue](target.md)', firstSource.revision)
    assert.deepEqual(await clickbaitSources(), [firstSource.path, secondSource.path], 'changing just the source revision reopens the lead')

    writeFileSync(isolated.resolve(target.path), Buffer.from([0xff]))
    await assert.rejects(isolatedReport(), { code: 'ERR_ENCODING_INVALID_ENCODED_DATA' }, 'a target read failure must not produce fake broken links')
    writeFileSync(isolated.resolve(index.path), 'x'.repeat(64 * 1024 + 1))
    await assert.rejects(isolatedReport(), /oversized/i, 'a scan failure must not masquerade as an empty scope')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
} else {
  test('audit triage accurately separates poisoned, high-churn, structure, clickbait, misses, and stale with 60-day cooldowns', async () => {
    const result = await runSelf(import.meta.path, ['--audit-triage-fixture'], { timeoutMs: 20_000 })
    assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  })
}
