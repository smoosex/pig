import { test, mock, spyOn } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSelf } from './helpers/subprocess'

if (process.argv.includes('--audit-runtime-fixture')) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pig-audit-runtime-')))
  const pigDir = join(root, 'pig')
  const projDir = join(root, 'proj-a')
  const otherProjDir = join(root, 'proj-b')
  const missingProjDir = join(root, 'proj-missing')
  const sessionsDir = join(root, 'sessions')
  mkdirSync(pigDir, { recursive: true })
  mkdirSync(projDir, { recursive: true })
  mkdirSync(otherProjDir, { recursive: true })
  mkdirSync(sessionsDir, { recursive: true })
  process.env.PIG_DIR = pigDir

  let fileMemoryEnabled = true
  let permMode = 'default'
  let memorySettingsHook: (() => Promise<void>) | undefined
  const listeners = new Set<() => void>()
  mock.module('../src/main/pig-dir', () => ({ pigPath: (...parts: string[]) => join(pigDir, ...parts) }))
  mock.module('../src/main/features/memory-settings', () => ({
    getMemorySettings: async () => {
      if (memorySettingsHook) await memorySettingsHook()
      return { fileMemory: { enabled: fileMemoryEnabled } }
    }
  }))
  mock.module('../src/main/permissions/store', () => ({
    sessionPermission: () => ({ mode: permMode }),
    readPermissionSettings: () => ({ defaultMode: permMode }),
    onPermissionsChanged: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn) }
  }))
  mock.module('../src/main/opened-projects', () => ({
    listOpenedCwds: async () => [projDir]
  }))

  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent')
  const { createAssistantMessageEventStream, getCurrentTools } = await import('@earendil-works/pi-ai')
  const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: join(root, 'models.json') })
  runtime.registerProvider('audit-fixture', {
    api: 'openai-completions',
    baseUrl: 'http://unused.invalid',
    apiKey: 'fixture',
    models: [{
      id: 'model', name: 'Fixture', reasoning: false, input: ['text'],
      contextWindow: 100_000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    }]
  })
  await runtime.setRuntimeApiKey('audit-fixture', 'fixture')
  mock.module('../src/main/pi/model-settings', () => ({
    startModelRuntime: async () => runtime,
    readDefaultSettings: async () => ({ effective: { model: { provider: 'audit-fixture', id: 'model' }, thinkingLevel: 'off' } })
  }))

  const { DREAM_AUDIT_PROMPT, auditLaunchPrompt, auditWrapUpPrompt } = await import('../src/main/features/memory/dream/audit-prompt')
  const { DREAM_PROMPT } = await import('../src/main/features/memory/dream/prompt')
  const { MemoryFiles, memoryRoot, projectMemoryKey } = await import('../src/main/features/memory/long-term/files')
  const { memoryAccess } = await import('../src/main/features/memory/long-term/access')
  const { appendTelemetryRow, readAuditState } = await import('../src/main/features/memory/telemetry/store')
  const { DreamHistory } = await import('../src/main/features/memory/dream/history')
  const { DreamService, validateDreamRequest } = await import('../src/main/features/memory/dream/service')
  const { listDreamRecords, readDreamRecord } = await import('../src/main/features/memory/dream/records')
  const { buildAuditHealthReport } = await import('../src/main/features/memory/dream/audit')

  // 1. Verbatim prompt verification against spec section 6.
  assert.ok(DREAM_AUDIT_PROMPT.startsWith("You are the agent's Dream memory-audit mechanism. Inspect telemetry-flagged memory issues"))
  assert.ok(DREAM_AUDIT_PROMPT.endsWith("4. Uninspected leads (remaining items if stopped early)"))
  assert.equal(auditLaunchPrompt('Simplified Chinese'), 'Audit memory health using telemetry and historical conversations. Start by calling dream_memory_health, follow the priority order, and report in Simplified Chinese.')
  assert.equal(auditWrapUpPrompt('tokens'), 'You have reached 80% of the tokens budget. Stop opening new leads. Finish verifying any note currently being edited, repair affected links and MEMORY.md entries, and write the final report including any uninspected leads and items needing user confirmation. Do not claim unviewed history was verified.')
  assert.ok(DREAM_PROMPT.endsWith('You may call dream_memory_health as an optional signal to spot poisoned notes, misleading index clues, or repeated misses relevant to this topic. Treat telemetry as leads to verify against notes and history, not conclusions, and do not drift into maintaining unrelated memories.'))

  const projId = projectMemoryKey((await memoryAccess({ cwd: projDir, sessionManager: { getSessionId: () => 'x' } as any })).project)
  const otherProjId = projectMemoryKey((await memoryAccess({ cwd: otherProjDir, sessionManager: { getSessionId: () => 'x' } as any })).project)
  const forgedProjId = 'f'.repeat(64)

  // Prepare live notes.
  const globalStore = new MemoryFiles(join(memoryRoot(), 'global'), memoryRoot())
  const gIndex = globalStore.save('MEMORY.md', '[Poison](poison.md)\n[Keep](keep.md)\n[MissingHist](nohist.md)\n[Paged](paged.md)', null)
  const gPoison = globalStore.save('poison.md', 'Old rule', null)
  const gKeep = globalStore.save('keep.md', 'Valid rule', null)
  const gNoHist = globalStore.save('nohist.md', 'Uncertain rule', null)
  const gPaged = globalStore.save('paged.md', 'Paged evidence rule', null)
  const projStore = new MemoryFiles(join(memoryRoot(), 'projects', projId), memoryRoot())
  projStore.save('MEMORY.md', '[P](p.md)', null)
  projStore.save('p.md', 'Project note', null)

  // Prepare session JSONLs for branch verification and toolUse/no-final-reply reads.
  const writeSessionJsonl = (fileName: string, sessionId: string, cwd: string, lines: object[]) => {
    const path = join(sessionsDir, fileName)
    writeFileSync(path, JSON.stringify({ type: 'session', id: sessionId, version: 3, cwd }) + '\n' + lines.map(l => JSON.stringify(l)).join('\n') + '\n')
    return { id: sessionId, title: fileName, path, cwd }
  }
  const ts = '2026-11-18T00:00:00Z'
  // Active toolUse round followed by a user-only correction turn (no assistant reply yet).
  const sKeep1 = writeSessionJsonl('s-keep-1.jsonl', 's-keep-1', projDir, [
    { type: 'message', id: 'u1', parentId: null, timestamp: ts, message: { role: 'user', content: 'run build' } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: ts, message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'tc1', name: 'bash', arguments: { command: 'false' } }] } },
    { type: 'message', id: 'tr1', parentId: 'a1', timestamp: ts, message: { role: 'toolResult', toolCallId: 'tc1', toolName: 'bash', isError: true, content: [{ type: 'text', text: 'boom' }] } },
    { type: 'message', id: 'u2', parentId: 'tr1', timestamp: ts, message: { role: 'user', content: 'Actually ignore that, keep rule works' } }
  ])
  const sKeep2 = writeSessionJsonl('s-keep-2.jsonl', 's-keep-2', projDir, [
    { type: 'message', id: 'u10', parentId: null, timestamp: ts, message: { role: 'user', content: 'check' } },
    { type: 'message', id: 'a10', parentId: 'u10', timestamp: ts, message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'checked' }] } }
  ])
  // Branch-switched session: u-sw -> a-old (switched away) -> a-new (active leaf).
  const sSwitched = writeSessionJsonl('s-switched.jsonl', 's-switched', projDir, [
    { type: 'message', id: 'u-sw', parentId: null, timestamp: ts, message: { role: 'user', content: 'branch test' } },
    { type: 'message', id: 'a-old', parentId: 'u-sw', timestamp: ts, message: { role: 'assistant', stopReason: 'error', content: [{ type: 'text', text: '' }] } },
    { type: 'message', id: 'a-new', parentId: 'u-sw', timestamp: ts, message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'active branch' }] } }
  ])
  // Missing project cwd session -> projectIdentity === 'unresolved' -> historyAvailable: false.
  const sMissingProj = writeSessionJsonl('s-missing-proj.jsonl', 's-missing-proj', missingProjDir, [
    { type: 'message', id: 'u-mp', parentId: null, timestamp: ts, message: { role: 'user', content: 'old' } },
    { type: 'message', id: 'a-mp', parentId: 'u-mp', timestamp: ts, message: { role: 'assistant', stopReason: 'error', content: [] } }
  ])
  // Ambiguous multi-branch session with NO anchorEntryId.
  const sAmbig = writeSessionJsonl('s-ambig.jsonl', 's-ambig', projDir, [
    { type: 'message', id: 'u-am', parentId: null, timestamp: ts, message: { role: 'user', content: 'ambig' } },
    { type: 'message', id: 'a-am1', parentId: 'u-am', timestamp: ts, message: { role: 'assistant', stopReason: 'error', content: [] } },
    { type: 'message', id: 'a-am2', parentId: 'u-am', timestamp: ts, message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'ok' }] } }
  ])

  // Paged session: previous turn exceeds one PAGE (14000 chars), so page 1 with before=1 returns only u-prev.
  const sPaged = writeSessionJsonl('s-paged.jsonl', 's-paged', projDir, [
    { type: 'message', id: 'u-prev', parentId: null, timestamp: ts, message: { role: 'user', content: 'P'.repeat(15000) } },
    { type: 'message', id: 'a-prev', parentId: 'u-prev', timestamp: ts, message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'prev ok' }] } },
    { type: 'message', id: 'u-target', parentId: 'a-prev', timestamp: ts, message: { role: 'user', content: 'verify paged target evidence' } },
    { type: 'message', id: 'a-target', parentId: 'u-target', timestamp: ts, message: { role: 'assistant', stopReason: 'error', content: [{ type: 'text', text: '' }] } }
  ])
  // Placeholder-only target turn: attachment-only user + error reply, followed by a substantive next turn.
  const sOmitted = writeSessionJsonl('s-omitted.jsonl', 's-omitted', projDir, [
    { type: 'message', id: 'u-omitted', parentId: null, timestamp: ts, message: { role: 'user', content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] } },
    { type: 'message', id: 'a-omitted', parentId: 'u-omitted', timestamp: ts, message: { role: 'assistant', stopReason: 'error', content: [{ type: 'text', text: '' }] } },
    { type: 'message', id: 'u-after', parentId: 'a-omitted', timestamp: ts, message: { role: 'user', content: 'next turn substantive text' } },
    { type: 'message', id: 'a-after', parentId: 'u-after', timestamp: ts, message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'next ok' }] } }
  ])

  const allSources = [sKeep1, sKeep2, sSwitched, sMissingProj, sAmbig, sPaged, sOmitted]

  const now = Date.now()
  // Telemetry for keep.md and poison.md across 2 independent rounds (s-keep-1, s-keep-2).
  await appendTelemetryRow({
    v: 1, at: now - 5000, sessionId: 's-keep-1', turnId: 'u1', anchorEntryId: 'tr1', projectId: projId, outcome: 'error',
    ops: [
      { op: 'read', scope: 'global', ok: true, path: 'keep.md', rev: gKeep.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } },
      { op: 'read', scope: 'global', ok: true, path: 'poison.md', rev: gPoison.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }
    ],
    tail: { calls: 1, errs: 1 }
  }, { now })
  await appendTelemetryRow({
    v: 1, at: now - 4000, sessionId: 's-keep-2', turnId: 'u10', anchorEntryId: 'a10', projectId: projId, outcome: 'error',
    ops: [
      { op: 'read', scope: 'global', ok: true, path: 'keep.md', rev: gKeep.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } },
      { op: 'read', scope: 'global', ok: true, path: 'poison.md', rev: gPoison.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }
    ],
    tail: { calls: 1, errs: 1 }
  }, { now })

  // Telemetry for paged.md pointing to s-paged/u-target and s-omitted/u-omitted.
  await appendTelemetryRow({
    v: 1, at: now - 3500, sessionId: 's-paged', turnId: 'u-target', anchorEntryId: 'a-target', projectId: projId, outcome: 'error',
    ops: [{ op: 'read', scope: 'global', ok: true, path: 'paged.md', rev: gPaged.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }],
    tail: { calls: 1, errs: 1 }
  }, { now })
  await appendTelemetryRow({
    v: 1, at: now - 3000, sessionId: 's-omitted', turnId: 'u-omitted', anchorEntryId: 'a-omitted', projectId: projId, outcome: 'error',
    ops: [{ op: 'read', scope: 'global', ok: true, path: 'paged.md', rev: gPaged.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }],
    tail: { calls: 1, errs: 1 }
  }, { now })

  // Telemetry for nohist.md: only switched-away branch, deleted session, and ambiguous unanchored rounds -> ALL historyAvailable: false!
  await appendTelemetryRow({
    v: 1, at: now - 2500, sessionId: 's-switched', turnId: 'u-sw', anchorEntryId: 'a-old', projectId: projId, outcome: 'error',
    ops: [{ op: 'read', scope: 'global', ok: true, path: 'nohist.md', rev: gNoHist.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }],
    tail: { calls: 1, errs: 1 }
  }, { now })
  await appendTelemetryRow({
    v: 1, at: now - 2000, sessionId: 's-ambig', turnId: 'u-am', projectId: projId, outcome: 'error',
    ops: [{ op: 'read', scope: 'global', ok: true, path: 'nohist.md', rev: gNoHist.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }],
    tail: { calls: 1, errs: 1 }
  }, { now })
  await appendTelemetryRow({
    v: 1, at: now - 1500, sessionId: 's-missing-proj', turnId: 'u-mp', anchorEntryId: 'a-mp', outcome: 'error',
    ops: [{ op: 'read', scope: 'global', ok: true, path: 'nohist.md', rev: gNoHist.revision, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }],
    tail: { calls: 1, errs: 1 }
  }, { now })

  // Forged project telemetry that must NEVER grant write permission.
  await appendTelemetryRow({
    v: 1, at: now - 1000, sessionId: 's-forged', turnId: 't-f1', anchorEntryId: 'a-f1', projectId: forgedProjId, outcome: 'completed',
    ops: [{ op: 'search', scope: 'project', projectId: forgedProjId, ok: true, query: 'forged', hits: 0, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }],
    tail: { calls: 0, errs: 0 }
  }, { now })

  // 2. Test DreamHistory verification & audit whitelist read rules directly.
  const hTest = new DreamHistory(allSources)
  hTest.enableAuditWhitelist()
  assert.equal((await hTest.verifyAuditRound({ sessionId: 's-switched', turnId: 'u-sw', anchorEntryId: 'a-old', expectedProjectId: projId })).historyAvailable, false)
  assert.equal((await hTest.verifyAuditRound({ sessionId: 's-ambig', turnId: 'u-am', expectedProjectId: projId })).historyAvailable, false)
  assert.equal((await hTest.verifyAuditRound({ sessionId: 's-missing-proj', turnId: 'u-mp', anchorEntryId: 'a-mp', expectedProjectId: undefined })).historyAvailable, false)
  assert.equal((await hTest.verifyAuditRound({ sessionId: 's-deleted', turnId: 'u-del', anchorEntryId: 'a-del', expectedProjectId: projId })).historyAvailable, false)

  await assert.rejects(hTest.read({ sessionId: 's-switched', turnId: 'u-sw' }), /whitelist/)
  await assert.rejects(hTest.read({ sessionId: 's-keep-1', turnId: 'u2' }), /whitelist/)
  assert.equal((await hTest.verifyAuditRound({ sessionId: 's-keep-1', turnId: 'u1', anchorEntryId: 'tr1', expectedProjectId: projId })).historyAvailable, true)
  const readRes = await hTest.read({ sessionId: 's-keep-1', turnId: 'u1', before: 0, after: 1 })
  const readText = JSON.stringify(readRes)
  assert.match(readText, /run build/)
  assert.match(readText, /Assistant requested tool calls; no final reply/)
  assert.doesNotMatch(readText, /Reply interrupted/, 'toolUse must not be mislabeled as user-interrupted')
  assert.match(readText, /Actually ignore that, keep rule works/, 'next user turn without reply is still readable')
  await assert.rejects(hTest.read({ sessionId: 's-keep-1', turnId: 'u2' }), /whitelist/, 'reading after:1 must not expand whitelist to u2')

  // 2b. Regression: inspectedRounds must only record after actual target-turn substantive evidence is returned.
  assert.equal((await hTest.verifyAuditRound({ sessionId: 's-paged', turnId: 'u-target', anchorEntryId: 'a-target', expectedProjectId: projId })).historyAvailable, true)
  const pagedPage1 = await hTest.read({ sessionId: 's-paged', turnId: 'u-target', before: 1, after: 0 })
  assert.ok(pagedPage1.nextCursor, 'long preceding turn paginates before reaching target turn')
  assert.ok((pagedPage1.records as any[]).every(r => r.turnId === 'u-prev'), 'page 1 returns only u-prev')
  assert.equal(hTest.hasInspectedRound('s-paged', 'u-target'), false, 'page 1 containing only u-prev must NOT mark u-target inspected')
  let cursor: string | null = pagedPage1.nextCursor
  while (cursor && !hTest.hasInspectedRound('s-paged', 'u-target')) {
    const nextPage = await hTest.read({ sessionId: 's-paged', turnId: 'u-target', before: 1, after: 0, cursor })
    cursor = nextPage.nextCursor
  }
  assert.equal(hTest.hasInspectedRound('s-paged', 'u-target'), true, 'paginating to u-target substantive content marks it inspected')

  assert.equal((await hTest.verifyAuditRound({ sessionId: 's-omitted', turnId: 'u-omitted', anchorEntryId: 'a-omitted', expectedProjectId: projId })).historyAvailable, true)
  const omittedRead = await hTest.read({ sessionId: 's-omitted', turnId: 'u-omitted', before: 0, after: 1 })
  assert.match(JSON.stringify(omittedRead), /next turn substantive text/)
  assert.equal(hTest.hasInspectedRound('s-omitted', 'u-omitted'), false, 'placeholder-only target turn plus substantive next turn must NOT mark u-omitted inspected')

  const toolSource = writeSessionJsonl('s-tool-pages.jsonl', 's-tool-pages', projDir, [
    { type: 'message', id: 'u-tool', parentId: null, timestamp: ts, message: { role: 'user', content: 'check' } },
    { type: 'message', id: 'a-tool', parentId: 'u-tool', timestamp: ts, message: { role: 'assistant', stopReason: 'toolUse', content: [
      { type: 'toolCall', id: 'tc', name: 'metadata', arguments: { metadataKey: {}, empty: [] } }
    ] } },
    { type: 'message', id: 'tr-attachment', parentId: 'a-tool', timestamp: ts, message: {
      role: 'toolResult', toolCallId: 'tc', toolName: 'metadata', isError: true, content: [
        { type: 'image', data: 'never returned', mimeType: 'image/png' },
        { type: 'text', text: 'sk-' + 'F'.repeat(40) }
      ]
    } },
    { type: 'message', id: 'tr-paged', parentId: 'tr-attachment', timestamp: ts, message: {
      role: 'toolResult', toolCallId: 'tc', toolName: 'm'.repeat(12100), isError: false, content: [
        { type: 'image', data: 'never returned', mimeType: 'image/png' },
        { type: 'text', text: ' '.repeat(12000) + 'actual tool output' }
      ]
    } }
  ])
  const toolsHistory = new DreamHistory([toolSource])
  toolsHistory.enableAuditWhitelist()
  const toolRound = { sessionId: toolSource.id, turnId: 'u-tool' }
  assert.equal((await toolsHistory.verifyAuditRound({ ...toolRound, anchorEntryId: 'tr-paged', expectedProjectId: projId })).historyAvailable, true)
  let toolPage = await toolsHistory.tools(toolRound)
  for (const nonEvidence of ['metadataKey', '[Attachment omitted]\\n[Credential omitted]', '"name":', '[Attachment omitted]']) {
    assert.ok(toolPage.text.includes(nonEvidence))
    assert.equal(toolsHistory.hasInspectedRound(toolRound.sessionId, toolRound.turnId), false)
    assert.ok(toolPage.nextCursor)
    toolPage = await toolsHistory.tools({ ...toolRound, cursor: toolPage.nextCursor })
  }
  assert.match(toolPage.text, /actual tool output/)
  assert.equal(toolsHistory.hasInspectedRound(toolRound.sessionId, toolRound.turnId), true)

  // 3. Test full DreamService + real runDreamWorker across audit scenarios.
  let mode: 'audit_keep_and_edit' | 'audit_two_keeps' | 'audit_keep_rejects' | 'audit_paged_keep' | 'audit_scope_violation' | 'audit_budget_limit' | 'audit_zero_change_keep' | 'audit_clickbait_keep' | 'topic_health' = 'audit_keep_and_edit'
  let reqIndex = 0
  let keepCandidateId = ''
  let noHistCandidateId = ''
  let pagedCandidateId = ''
  let pagedCursor = ''
  let pagedKeepRejectedBeforePage2 = false
  let pagedKeepSucceededAfterPage2 = false
  let currentPoisonRev = gPoison.revision
  let nextPoisonText = 'Verified corrected rule'
  const seenTools: string[][] = []
  const seenPrompts: string[] = []
  let keepRejectCount = 0

  const spy = spyOn(runtime, 'streamSimple').mockImplementation((model, context) => {
    seenTools.push(getCurrentTools(context.messages).map(t => t.name))
    const systemMsg = context.messages.find(m => m.role === 'system')
    if (systemMsg && typeof systemMsg.content === 'string') seenPrompts.push(systemMsg.content)
    const i = reqIndex++
    const out = createAssistantMessageEventStream()
    const reply = (stopReason: 'toolUse' | 'stop', content: any[], usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }) => {
      out.push({
        type: 'done',
        reason: stopReason,
        message: {
          role: 'assistant', timestamp: Date.now(), api: model.api, provider: model.provider, model: model.id,
          content, stopReason,
          usage: { ...usage, totalTokens: usage.input + usage.output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
        }
      })
    }

    if (mode === 'audit_keep_rejects') {
      if (i === 0) reply('toolUse', [{ type: 'toolCall', id: 'h0', name: 'dream_memory_health', arguments: {} }])
      else if (i === 1) {
        const lastTool = [...context.messages].reverse().find(m => m.role === 'toolResult') as any
        const report = JSON.parse(lastTool.content[0].text.split('\n')[2])
        keepCandidateId = report.candidates.find((c: any) => c.path === 'keep.md').id
        noHistCandidateId = report.candidates.find((c: any) => c.path === 'nohist.md').id
        // Try keeping BEFORE reading note -> must fail!
        reply('toolUse', [{ type: 'toolCall', id: 'k-unread', name: 'dream_audit_keep', arguments: { candidateId: keepCandidateId } }])
      } else if (i === 2) {
        const res = [...context.messages].reverse().find(m => m.role === 'toolResult') as any
        if (res.isError) keepRejectCount++
        // Read keep.md, then try keeping BEFORE reading history -> must fail!
        reply('toolUse', [
          { type: 'toolCall', id: 'r-keep', name: 'memory_read', arguments: { scope: 'global', path: 'keep.md' } },
          { type: 'toolCall', id: 'k-nohist-read', name: 'dream_audit_keep', arguments: { candidateId: keepCandidateId } }
        ])
      } else if (i === 3) {
        const res = [...context.messages].reverse().find(m => m.role === 'toolResult') as any
        if (res.isError) keepRejectCount++
        // Read nohist.md (whose rounds are ALL historyAvailable: false) -> keeping must fail!
        reply('toolUse', [
          { type: 'toolCall', id: 'r-nohist', name: 'memory_read', arguments: { scope: 'global', path: 'nohist.md' } },
          { type: 'toolCall', id: 'k-unavail', name: 'dream_audit_keep', arguments: { candidateId: noHistCandidateId } }
        ])
      } else if (i === 4) {
        const res = [...context.messages].reverse().find(m => m.role === 'toolResult') as any
        if (res.isError) keepRejectCount++
        // Inspect available history round for keep.md, then keep succeeds!
        reply('toolUse', [
          { type: 'toolCall', id: 'hr-keep', name: 'dream_history_read', arguments: { sessionId: 's-keep-1', turnId: 'u1', after: 1 } },
          { type: 'toolCall', id: 'k-ok', name: 'dream_audit_keep', arguments: { candidateId: keepCandidateId } }
        ])
      } else {
        reply('stop', [{ type: 'text', text: '1. Changes applied\nNone\n2. Verified & kept\n- global/keep.md\n3. Needs user confirmation\n- global/nohist.md\n4. Uninspected leads\nNone' }])
      }
      return out
    }

    if (mode === 'audit_paged_keep') {
      if (i === 0) reply('toolUse', [{ type: 'toolCall', id: 'pk-h', name: 'dream_memory_health', arguments: {} }])
      else if (i === 1) {
        const lastTool = [...context.messages].reverse().find(m => m.role === 'toolResult') as any
        const report = JSON.parse(lastTool.content[0].text.split('\n')[2])
        pagedCandidateId = report.candidates.find((c: any) => c.path === 'paged.md').id
        // Read paged.md, read only page 1 of s-paged (before=1 -> only u-prev returned), then try dream_audit_keep.
        reply('toolUse', [
          { type: 'toolCall', id: 'pk-r', name: 'memory_read', arguments: { scope: 'global', path: 'paged.md' } },
          { type: 'toolCall', id: 'pk-hr1', name: 'dream_history_read', arguments: { sessionId: 's-paged', turnId: 'u-target', before: 1, after: 0 } }
        ])
      } else if (i === 2) {
        const lastTool = [...context.messages].reverse().find(m => m.role === 'toolResult') as any
        pagedCursor = JSON.parse(lastTool.content[0].text.split('\n')[2]).nextCursor
        // Premature keep BEFORE paging to u-target must fail!
        reply('toolUse', [{ type: 'toolCall', id: 'pk-k1', name: 'dream_audit_keep', arguments: { candidateId: pagedCandidateId } }])
      } else if (i === 3) {
        const lastTool = [...context.messages].reverse().find(m => m.role === 'toolResult') as any
        pagedKeepRejectedBeforePage2 = Boolean(lastTool.isError)
        // Page to page 2 (contains u-target substantive content), then keep again!
        reply('toolUse', [
          { type: 'toolCall', id: 'pk-hr2', name: 'dream_history_read', arguments: { sessionId: 's-paged', turnId: 'u-target', before: 1, after: 0, cursor: pagedCursor } },
          { type: 'toolCall', id: 'pk-k2', name: 'dream_audit_keep', arguments: { candidateId: pagedCandidateId } }
        ])
      } else {
        const lastTool = [...context.messages].reverse().find(m => m.role === 'toolResult') as any
        pagedKeepSucceededAfterPage2 = !lastTool.isError
        reply('stop', [{ type: 'text', text: '1. Changes applied\nNone\n2. Verified & kept\n- global/paged.md\n3. Needs user confirmation\nNone\n4. Uninspected leads\nNone' }])
      }
      return out
    }

    if (mode === 'audit_two_keeps') {
      if (i === 0) reply('toolUse', [{ type: 'toolCall', id: 'tk-h', name: 'dream_memory_health', arguments: {} }])
      else if (i === 1) {
        const lastTool = [...context.messages].reverse().find(m => m.role === 'toolResult') as any
        const report = JSON.parse(lastTool.content[0].text.split('\n')[2])
        keepCandidateId = report.candidates.find((c: any) => c.path === 'keep.md').id
        pagedCandidateId = report.candidates.find((c: any) => c.path === 'paged.md').id
        reply('toolUse', [
          { type: 'toolCall', id: 'tk-rk', name: 'memory_read', arguments: { scope: 'global', path: 'keep.md' } },
          { type: 'toolCall', id: 'tk-hrk', name: 'dream_history_read', arguments: { sessionId: 's-keep-1', turnId: 'u1' } },
          { type: 'toolCall', id: 'tk-rp', name: 'memory_read', arguments: { scope: 'global', path: 'paged.md' } },
          { type: 'toolCall', id: 'tk-hrp', name: 'dream_history_read', arguments: { sessionId: 's-paged', turnId: 'u-target', before: 0, after: 0 } }
        ])
      } else if (i === 2) {
        reply('toolUse', [
          { type: 'toolCall', id: 'tk-k1', name: 'dream_audit_keep', arguments: { candidateId: keepCandidateId } },
          { type: 'toolCall', id: 'tk-k2', name: 'dream_audit_keep', arguments: { candidateId: pagedCandidateId } }
        ])
      } else {
        reply('stop', [{ type: 'text', text: '1. Changes applied\nNone\n2. Verified & kept\n- global/keep.md\n- global/paged.md\n3. Needs user confirmation\nNone\n4. Uninspected leads\nNone' }])
      }
      return out
    }

    if (mode === 'audit_scope_violation') {
      if (i === 0) reply('toolUse', [{ type: 'toolCall', id: 'sv-1', name: 'memory_add', arguments: { scope: 'project', projectId: forgedProjId, path: 'bad.md', content: 'no' } }])
      else reply('stop', [{ type: 'text', text: 'failed' }])
      return out
    }

    if (mode === 'audit_budget_limit') {
      if (i === 0) reply('toolUse', [{ type: 'toolCall', id: 'bl-h', name: 'dream_memory_health', arguments: {} }])
      else if (i === 1) {
        const lastTool = [...context.messages].reverse().find(m => m.role === 'toolResult') as any
        const report = JSON.parse(lastTool.content[0].text.split('\n')[2])
        keepCandidateId = report.candidates.find((c: any) => c.path === 'keep.md').id
        reply('toolUse', [
          { type: 'toolCall', id: 'bl-r', name: 'memory_read', arguments: { scope: 'global', path: 'keep.md' } },
          { type: 'toolCall', id: 'bl-hr', name: 'dream_history_read', arguments: { sessionId: 's-keep-1', turnId: 'u1' } }
        ], { input: 16_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }) // 80% wrap-up!
      } else if (i === 2) {
        // Verify 80% wrap-up prompt matches spec verbatim!
        const userMsgs = context.messages.filter(m => m.role === 'user').map(m => JSON.stringify(m.content))
        assert.ok(userMsgs.some(text => text.includes('You have reached 80% of the tokens budget. Stop opening new leads.')))
        reply('toolUse', [
          { type: 'toolCall', id: 'bl-k', name: 'dream_audit_keep', arguments: { candidateId: keepCandidateId } }
        ], { input: 5_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }) // >20M hard abort!
      } else {
        reply('stop', [{ type: 'text', text: 'never reached' }])
      }
      return out
    }

    if (mode === 'audit_keep_and_edit') {
      if (i === 0) reply('toolUse', [{ type: 'toolCall', id: 'ae-h', name: 'dream_memory_health', arguments: {} }])
      else if (i === 1) {
        const lastTool = [...context.messages].reverse().find(m => m.role === 'toolResult') as any
        const report = JSON.parse(lastTool.content[0].text.split('\n')[2])
        keepCandidateId = report.candidates.find((c: any) => c.path === 'keep.md').id
        reply('toolUse', [
          { type: 'toolCall', id: 'ae-r1', name: 'memory_read', arguments: { scope: 'global', path: 'keep.md' } },
          { type: 'toolCall', id: 'ae-hr1', name: 'dream_history_read', arguments: { sessionId: 's-keep-1', turnId: 'u1' } },
          { type: 'toolCall', id: 'ae-rp', name: 'memory_read', arguments: { scope: 'global', path: 'poison.md' } }
        ])
      } else if (i === 2) {
        reply('toolUse', [
          { type: 'toolCall', id: 'ae-k', name: 'dream_audit_keep', arguments: { candidateId: keepCandidateId } },
          { type: 'toolCall', id: 'ae-ep', name: 'memory_edit', arguments: { scope: 'global', path: 'poison.md', revision: currentPoisonRev, oldText: globalStore.read('poison.md').content, newText: nextPoisonText } }
        ])
      } else {
        reply('stop', [{ type: 'text', text: '1. Changes applied\n- global/poison.md revised\n2. Verified & kept\n- global/keep.md\n3. Needs user confirmation\nNone\n4. Uninspected leads\nNone' }])
      }
      return out
    }

    if (mode === 'audit_clickbait_keep') {
      const lastTool = [...context.messages].reverse().find(m => m.role === 'toolResult') as any
      const step = (name: string, id: string, args: object = {}) => ({ type: 'toolCall', id, name, arguments: args })
      const read = (path: string, id: string) => step('memory_read', id, { scope: 'global', path })
      const keep = (id: string) => step('dream_audit_keep', id, { candidateId: keepCandidateId })
      if (i === 0) reply('toolUse', [step('dream_memory_health', 'cb-h')])
      else if (i === 1) {
        const report = JSON.parse(lastTool.content[0].text.split('\n')[2])
        const candidate = report.candidates.find((c: any) => c.kind === 'clickbait')
        assert.equal(candidate.fromRev, gIndex.revision)
        keepCandidateId = candidate.id
        reply('toolUse', [read('keep.md', 'cb-target'), keep('cb-unread')])
      } else if (i === 2) {
        assert.equal(lastTool.isError, true)
        assert.match(lastTool.content[0].text, /Read the original revision/)
        reply('toolUse', [read('MEMORY.md', 'cb-source'), keep('cb-valid')])
      } else if (i === 3) {
        assert.equal(lastTool.isError, false)
        assert.equal(JSON.parse(lastTool.content[0].text.split('\n')[2]).recorded, true)
        reply('toolUse', [
          step('memory_edit', 'cb-edit', { scope: 'global', path: 'MEMORY.md', revision: gIndex.revision, oldText: '[Keep]', newText: '[Better clue]' }),
          read('MEMORY.md', 'cb-changed-source'),
          keep('cb-changed')
        ])
      } else {
        assert.equal(lastTool.isError, true)
        assert.match(lastTool.content[0].text, /source revision is missing or changed/)
        reply('stop', [{ type: 'text', text: 'Updated the index clue.' }])
      }
      return out
    }

    if (mode === 'topic_health') {
      if (i === 0) reply('toolUse', [{ type: 'toolCall', id: 'th-1', name: 'dream_memory_health', arguments: { topic: 'poison' } }])
      else reply('stop', [{ type: 'text', text: 'Topic checked with health signal.' }])
      return out
    }

    return out
  })

  try {
    const service = new DreamService(async () => allSources)
    const settle = async () => {
      for (let i = 0; i < 400 && service.status().state === 'running'; i++) await new Promise(r => setTimeout(r, 10))
      return service.status()
    }

    // Request validation.
    assert.throws(() => validateDreamRequest({ audit: true, scope: { kind: 'project', projectId: 'bad' } }), /DREAM_SCOPE/)
    assert.throws(() => validateDreamRequest({ audit: true, scope: { kind: 'all' }, topic: 'extra' }), /DREAM_TOPIC|Invalid/)

    // Unverified project fails with DREAM_SCOPE.
    service.start(1, { audit: true, scope: { kind: 'project', projectId: forgedProjId } })
    assert.equal((await settle()).error, 'DREAM_SCOPE')

    // 3a. Keep verification rejects missing reads / missing history / unavailable history, then succeeds on zero-change publish!
    mode = 'audit_keep_rejects'; reqIndex = 0; seenTools.length = 0; keepRejectCount = 0
    service.start(1, { audit: true, scope: { kind: 'all' } })
    let status = await settle()
    assert.equal(status.state, 'done')
    assert.equal(keepRejectCount, 3, 'all 3 unverified keep attempts were rejected')
    assert.deepEqual(status.changes, [], 'zero-change audit still succeeds')
    assert.deepEqual(
      seenTools[0]!.slice().sort(),
      ['dream_audit_keep', 'dream_history_read', 'dream_memory_health', 'dream_turn_tools', 'memory_add', 'memory_delete', 'memory_edit', 'memory_read']
    )
    assert.equal(readAuditState().kept.length, 1, 'zero-change successful audit commits keep cooldown')
    assert.equal(readAuditState().kept[0]!.path, 'keep.md')

    // 3a-2. Regression: dream_audit_keep rejects after page-1-only read of preceding turn and succeeds after paging to target turn.
    mode = 'audit_paged_keep'; reqIndex = 0
    service.start(1, { audit: true, scope: { kind: 'all' } })
    status = await settle()
    assert.equal(status.state, 'done')
    assert.equal(pagedKeepRejectedBeforePage2, true, 'dream_audit_keep rejects when page 1 only returned preceding turn')
    assert.equal(pagedKeepSucceededAfterPage2, true, 'dream_audit_keep succeeds once target turn evidence is paginated')
    assert.ok(readAuditState().kept.some(item => item.path === 'paged.md'))

    // Verify receipt fields.
    const page = listDreamRecords()
    assert.equal(page.items[0]!.audit, true)
    assert.deepEqual(page.items[0]!.auditScope, { kind: 'all' })
    const savedRec = readDreamRecord(status.id!)
    assert.equal(savedRec.audit, true)

    // 3b. Scope lock rejects forged telemetry project write.
    mode = 'audit_scope_violation'; reqIndex = 0
    service.start(1, { audit: true, scope: { kind: 'global' } })
    status = await settle()
    assert.equal(status.state, 'error')
    assert.equal(status.error, 'DREAM_TOOL')

    // 3c. Budget hard stop never commits keep cooldown.
    rmSync(join(pigDir, 'memory-telemetry', 'audit-state.json'), { force: true })
    mode = 'audit_budget_limit'; reqIndex = 0
    service.start(1, { audit: true, scope: { kind: 'global' } })
    status = await settle()
    assert.equal(status.state, 'limited')
    assert.equal(status.error, 'DREAM_TOKEN_BUDGET')
    assert.equal(existsSync(join(pigDir, 'memory-telemetry', 'audit-state.json')), false, 'budget abort never writes cooldown')

    // 3d. Corrupt audit-state.json after successful publish reports partial result DREAM_AUDIT_STATE without rolling back published edits.
    // First start a valid run where keep.md is still flagged, then corrupt audit-state.json mid-run before publish commits keeps!
    mode = 'audit_keep_and_edit'; reqIndex = 0
    const badState = '{"v":1,"kept":"corrupt"}'
    // Inject corruption right after buildAuditHealthReport has read empty state (via first stream call).
    const origStream = spy.getMockImplementation()!
    let corruptedOnce = false
    spy.mockImplementation((model, context, opts) => {
      if (!corruptedOnce && mode === 'audit_keep_and_edit') {
        corruptedOnce = true
        writeFileSync(join(pigDir, 'memory-telemetry', 'audit-state.json'), badState)
      }
      return origStream(model, context, opts)
    })
    service.start(1, { audit: true, scope: { kind: 'global' } })
    status = await settle()
    assert.equal(status.state, 'error')
    assert.equal(status.error, 'DREAM_AUDIT_STATE')
    assert.deepEqual(status.changes, ['global/poison.md'], 'published edits stay in changes even when audit-state write fails')
    assert.ok(status.report && status.report.includes('poison.md'), 'report is preserved for partial result')
    assert.equal(globalStore.read('poison.md').content, 'Verified corrected rule', 'published memory edit is NOT rolled back')
    assert.equal(readFileSync(join(pigDir, 'memory-telemetry', 'audit-state.json'), 'utf8'), badState, 'corrupt audit-state.json is never overwritten')
    rmSync(join(pigDir, 'memory-telemetry', 'audit-state.json'), { force: true })

    // 3d-2. Regression: permission switch to read-only while commitAuditKeeps waits on .writer lease (then restored to default)
    // must NOT commit audit-state.json, yet preserves published edits, changes, and report without claiming full success.
    currentPoisonRev = globalStore.read('poison.md').revision
    nextPoisonText = 'Published before read-only switch'
    mode = 'audit_keep_and_edit'; reqIndex = 0
    const writerLockDir = join(pigDir, 'memory-telemetry', '.writer')
    let lockedForPermTest = false
    spy.mockImplementation((model, context, opts) => {
      if (!lockedForPermTest && mode === 'audit_keep_and_edit' && reqIndex === 3) {
        lockedForPermTest = true
        mkdirSync(writerLockDir, { recursive: true })
        writeFileSync(join(writerLockDir, 'pid'), String(process.pid))
        const triggerAfterPublish = () => {
          if (globalStore.optional('poison.md')?.content !== 'Published before read-only switch') {
            setTimeout(triggerAfterPublish, 2)
            return
          }
          setTimeout(() => {
            permMode = 'read-only'
            for (const listener of listeners) listener()
            // Immediately restore permission before releasing the writer lock; aborted commit must NOT revive!
            permMode = 'default'
            rmSync(writerLockDir, { recursive: true, force: true })
          }, 10)
        }
        setTimeout(triggerAfterPublish, 2)
      }
      return origStream(model, context, opts)
    })
    service.start(1, { audit: true, scope: { kind: 'global' } })
    status = await settle()
    spy.mockImplementation(origStream)
    rmSync(writerLockDir, { recursive: true, force: true })
    permMode = 'default'
    assert.equal(status.state, 'error')
    assert.equal(status.error, 'DREAM_PERMISSION')
    assert.deepEqual(status.changes, ['global/poison.md'])
    assert.ok(status.report && status.report.includes('poison.md'))
    assert.equal(globalStore.read('poison.md').content, 'Published before read-only switch')
    assert.equal(existsSync(join(pigDir, 'memory-telemetry', 'audit-state.json')), false, 'restored permission never revives cancelled keep commit')

    // 3d-3. Regression: closing owner window while commitAuditKeeps holds .writer lease in beforeWrite
    // aborts commit cleanly, preserves published changes/report, and releases .writer.
    currentPoisonRev = globalStore.read('poison.md').revision
    nextPoisonText = 'Published before owner close'
    mode = 'audit_keep_and_edit'; reqIndex = 0
    memorySettingsHook = async () => {
      if (existsSync(writerLockDir)) {
        service.cancelOwner(1)
      }
    }
    service.start(1, { audit: true, scope: { kind: 'global' } })
    status = await settle()
    memorySettingsHook = undefined
    assert.equal(status.state, 'cancelled')
    assert.equal(status.error, 'DREAM_CANCELLED')
    assert.deepEqual(status.changes, ['global/poison.md'])
    assert.ok(status.report && status.report.includes('poison.md'))
    assert.equal(globalStore.read('poison.md').content, 'Published before owner close')
    assert.equal(existsSync(join(pigDir, 'memory-telemetry', 'audit-state.json')), false, 'owner close during held lease skips audit-state commit')
    assert.equal(existsSync(writerLockDir), false, 'writer lease is released after cancelled commit')

    // 3d-4. Regression: disabling fileMemory while commitAuditKeeps holds .writer lease rejects with DREAM_DISABLED,
    // preserves published changes/report, and does not write audit-state.json.
    currentPoisonRev = globalStore.read('poison.md').revision
    nextPoisonText = 'Published before disable'
    mode = 'audit_keep_and_edit'; reqIndex = 0
    memorySettingsHook = async () => {
      if (existsSync(writerLockDir)) {
        fileMemoryEnabled = false
      }
    }
    service.start(1, { audit: true, scope: { kind: 'global' } })
    status = await settle()
    memorySettingsHook = undefined
    fileMemoryEnabled = true
    assert.equal(status.state, 'error')
    assert.equal(status.error, 'DREAM_DISABLED')
    assert.deepEqual(status.changes, ['global/poison.md'])
    assert.ok(status.report && status.report.includes('poison.md'))
    assert.equal(globalStore.read('poison.md').content, 'Published before disable')
    assert.equal(existsSync(join(pigDir, 'memory-telemetry', 'audit-state.json')), false, 'disabling fileMemory during held lease skips audit-state commit')
    assert.equal(existsSync(writerLockDir), false, 'writer lease is released after disabled commit')

    // 3d-5. Regression: editing keep.md during commitAuditKeeps's async beforeWrite prevents the stale revision
    // of keep.md from entering audit-state.json, while unchanged paged.md still commits under the memory catalog lease.
    rmSync(join(pigDir, 'memory-telemetry', 'audit-state.json'), { force: true })
    const keepBeforeBeforeWrite = globalStore.read('keep.md')
    mode = 'audit_two_keeps'; reqIndex = 0
    let mutatedDuringBeforeWrite = false
    memorySettingsHook = async () => {
      if (existsSync(writerLockDir) && !mutatedDuringBeforeWrite) {
        mutatedDuringBeforeWrite = true
        globalStore.save('keep.md', 'Updated concurrently during beforeWrite', keepBeforeBeforeWrite.revision)
      }
    }
    service.start(1, { audit: true, scope: { kind: 'global' } })
    status = await settle()
    memorySettingsHook = undefined
    assert.equal(status.state, 'done')
    assert.equal(mutatedDuringBeforeWrite, true)
    assert.deepEqual(
      readAuditState().kept.map(entry => entry.path),
      ['paged.md'],
      'revision modified during beforeWrite is excluded while unchanged note commits'
    )
    assert.equal(existsSync(join(memoryRoot(), '.writer')), false, 'memory catalog lease is released after commit')

    // 3d-6. Regression: busy memory catalog writer lease blocks keep commit cleanly with DREAM_AUDIT_STATE
    // without rolling back published edits.
    rmSync(join(pigDir, 'memory-telemetry', 'audit-state.json'), { force: true })
    // Restore keep.md to original text so telemetry revision matches gKeep.revision again.
    globalStore.save('keep.md', 'Valid rule', globalStore.read('keep.md').revision)
    currentPoisonRev = globalStore.read('poison.md').revision
    nextPoisonText = 'Published before busy catalog lease'
    mode = 'audit_keep_and_edit'; reqIndex = 0
    const memWriterLockDir = join(memoryRoot(), '.writer')
    memorySettingsHook = async () => {
      if (existsSync(writerLockDir) && !existsSync(memWriterLockDir)) {
        mkdirSync(memWriterLockDir, { recursive: true })
        writeFileSync(join(memWriterLockDir, 'pid'), String(process.pid))
      }
    }
    service.start(1, { audit: true, scope: { kind: 'global' } })
    status = await settle()
    memorySettingsHook = undefined
    rmSync(memWriterLockDir, { recursive: true, force: true })
    assert.equal(status.state, 'error')
    assert.equal(status.error, 'DREAM_AUDIT_STATE')
    assert.deepEqual(status.changes, ['global/poison.md'])
    assert.equal(globalStore.read('poison.md').content, 'Published before busy catalog lease')
    assert.equal(existsSync(join(pigDir, 'memory-telemetry', 'audit-state.json')), false, 'busy catalog lease prevents bypassing live revision protection')

    // 3e. Topic Dream has filtered dream_memory_health and NO dream_audit_keep.
    mode = 'topic_health'; reqIndex = 0; seenTools.length = 0
    service.start(1, { topic: 'poison' })
    status = await settle()
    assert.equal(status.state, 'done')
    assert.ok(seenTools[0]!.includes('dream_memory_health'))
    assert.ok(!seenTools[0]!.includes('dream_audit_keep'))
    // Also verify topic filter leaves unrelated notes out.
    const filtered = await buildAuditHealthReport({
      scope: { kind: 'all' }, history: new DreamHistory(allSources),
      verifiedProjects: new Map([[projId, { id: projId }]]), verifyHistory: false, topicFilter: { topic: 'nohist' }
    })
    assert.deepEqual(filtered.candidates.map(c => c.path), ['nohist.md'])

    // A source revision read can authorize a keep, but a later source edit invalidates it at publication.
    for (let i = 0; i < 3; i++) {
      await appendTelemetryRow({
        v: 1, at: now - 100 - i, sessionId: 'clickbait-sample', turnId: `cb-${i}`, outcome: 'completed',
        ops: [
          { op: 'read', scope: 'global', ok: true, path: 'keep.md', rev: gKeep.revision, from: 'MEMORY.md', offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } },
          { op: 'list', scope: 'global', ok: true, count: 1, offset: 0, hasMore: false, gap: { calls: 0, errs: 0 } }
        ],
        tail: { calls: 0, errs: 0 }
      }, { now })
    }
    mode = 'audit_clickbait_keep'; reqIndex = 0
    service.start(1, { audit: true, scope: { kind: 'global' } })
    status = await settle()
    assert.equal(status.state, 'done')
    assert.equal(reqIndex, 5)
    assert.deepEqual(status.changes, ['global/MEMORY.md'])
    assert.ok(!readAuditState().kept.some(entry => entry.kind === 'clickbait'))

    // 3f. Disabled fileMemory prevents audit start.
    fileMemoryEnabled = false
    service.start(1, { audit: true, scope: { kind: 'global' } })
    status = await settle()
    assert.equal(status.error, 'DREAM_DISABLED')
    fileMemoryEnabled = true

    assert.ok(gIndex.revision && otherProjId)
  } finally {
    spy.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
} else {
  test('Dream audit runtime enforces prompts, tool loadout, branch/history whitelists, keep verification, cooldown commit, and partial-failure reporting', async () => {
    const result = await runSelf(import.meta.path, ['--audit-runtime-fixture'], { timeoutMs: 25_000 })
    assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  }, 30_000)
}
