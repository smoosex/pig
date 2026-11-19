import { test, mock, spyOn } from 'bun:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSelf } from './helpers/subprocess'

if (process.argv.includes('--collector-fixture')) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pig-telemetry-collector-')))
  const pigDir = join(root, 'pig')
  const projectA = join(root, 'project-a')
  const projectB = join(root, 'project-b')
  const chatDir = join(pigDir, 'chats', 'chat-1')
  mkdirSync(projectA, { recursive: true })
  mkdirSync(projectB, { recursive: true })
  mkdirSync(chatDir, { recursive: true })
  process.env.PIG_DIR = pigDir

  let fileMemoryEnabled = true
  let currentProject = projectA
  let permMode: 'default' | 'read-only' = 'default'
  mock.module('../src/main/features/memory-settings', () => ({
    getMemorySettings: async () => ({ fileMemory: { enabled: fileMemoryEnabled } })
  }))
  mock.module('../src/main/permissions/store', () => ({
    sessionPermission: () => ({ mode: permMode })
  }))
  mock.module('../src/main/features/memory/long-term/access', () => ({
    isChatMemoryCwd: (cwd: string) => cwd.startsWith(join(pigDir, 'chats')),
    memoryAccess: async (ctx: { sessionManager: { getSessionId: () => string } }) => ({
      project: currentProject.startsWith(join(pigDir, 'chats')) ? `chat:${ctx.sessionManager.getSessionId()}` : currentProject,
      session: ctx.sessionManager.getSessionId(),
      cwd: currentProject
    })
  }))

  const {
    createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, defineTool
  } = await import('@earendil-works/pi-coding-agent')
  const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai')
  const { obj, str } = await import('@earendil-works/pi-schema')
  const { registerLongTermMemory } = await import('../src/main/features/memory/long-term/extension')
  const { readTelemetryWindow } = await import('../src/main/features/memory/telemetry/store')
  const { projectMemoryKey, MemoryFiles } = await import('../src/main/features/memory/long-term/files')

  const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: join(root, 'models.json') })
  runtime.registerProvider('telemetry-fixture', {
    api: 'openai-completions',
    baseUrl: 'http://unused.invalid',
    apiKey: 'fixture',
    models: [{
      id: 'model',
      name: 'Fixture',
      reasoning: false,
      input: ['text'],
      contextWindow: 100_000,
      maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    }]
  })
  await runtime.setRuntimeApiKey('telemetry-fixture', 'fixture')

  let slowGate = Promise.withResolvers<void>()
  let lateToolGate = Promise.withResolvers<void>()
  let scenario = ''
  let step = 0

  const buildLoader = () => new DefaultResourceLoader({
    cwd: projectA,
    agentDir: root,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 5 } }),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      registerLongTermMemory,
      pi => {
        pi.registerTool(defineTool({
          name: 'plain_ok',
          label: 'Plain OK',
          description: 'Plain ok tool',
          parameters: obj({}),
          async execute() { return { content: [{ type: 'text', text: 'ok' }], details: undefined } }
        }))
        pi.registerTool(defineTool({
          name: 'plain_fail',
          label: 'Plain fail',
          description: 'Plain failing tool',
          parameters: obj({}),
          async execute() { throw new Error('plain boom') }
        }))
        pi.registerTool(defineTool({
          name: 'plain_slow_fail',
          label: 'Slow failing tool',
          description: 'Waits for gate then fails',
          parameters: obj({}),
          async execute() { await slowGate.promise; throw new Error('slow boom') }
        }))
        pi.registerTool(defineTool({
          name: 'late_memory',
          label: 'Late async',
          description: 'Waits on gate and runs memory_read after cancellation',
          parameters: obj({}),
          async execute(_id, _params, _sig, _upd, ctx) {
            await lateToolGate.promise
            await ctx.executeTool('memory_read', { scope: 'global' })
            return { content: [{ type: 'text', text: 'done' }], details: undefined }
          }
        }))
        pi.registerTool(defineTool({
          name: 'fake_codemode',
          label: 'Fake codemode',
          description: 'Runs nested tools',
          parameters: obj({ mode: str() }),
          async execute(_id, params, _sig, _upd, ctx) {
            if (params.mode === 'parallel_cross_read') {
              const p = ctx.executeTool('plain_slow_fail', {})
              await ctx.executeTool('memory_read', { scope: 'global', path: 'MEMORY.md' })
              slowGate.resolve()
              await p
              return { content: [{ type: 'text', text: 'parallel done' }], details: undefined }
            }
            if (params.mode === 'plain_only') {
              await ctx.executeTool('plain_ok', {})
              await ctx.executeTool('plain_fail', {})
              return { content: [{ type: 'text', text: 'plain only' }], details: undefined }
            }
            if (params.mode === 'memory_only_throw') {
              await ctx.executeTool('memory_read', { scope: 'global', path: 'MEMORY.md' })
              throw new Error('wrapper syntax error')
            }
            if (params.mode === 'mixed_throw') {
              await ctx.executeTool('plain_fail', {})
              await ctx.executeTool('memory_read', { scope: 'global', path: 'MEMORY.md' })
              await ctx.executeTool('plain_fail', {})
              throw new Error('outer failure after memory')
            }
            return { content: [{ type: 'text', text: 'noop' }], details: undefined }
          }
        }))
      }
    ]
  })

  const makeSession = async (cwd: string, sessionDir: string) => {
    mkdirSync(sessionDir, { recursive: true })
    const loader = buildLoader()
    await loader.reload()
    const settings = SettingsManager.inMemory({
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 5 }
    })
    const { session } = await createAgentSession({
      cwd,
      agentDir: root,
      sessionManager: SessionManager.create(cwd, sessionDir),
      settingsManager: settings,
      modelRuntime: runtime,
      model: runtime.getModel('telemetry-fixture', 'model')!,
      thinkingLevel: 'off',
      resourceLoader: loader,
      noTools: 'builtin'
    })
    session.agent.toolExecution = 'parallel'
    await session.bindExtensions({ mode: 'rpc', onError: err => { throw new Error(err.error) } })
    session.setActiveToolsByName(['memory_read', 'memory_add', 'memory_edit', 'memory_delete', 'plain_ok', 'plain_fail', 'plain_slow_fail', 'late_memory', 'fake_codemode'])
    return session
  }

  const spy = spyOn(runtime, 'streamSimple').mockImplementation(model => {
    const out = createAssistantMessageEventStream()
    const idx = step++
    const reply = (reason: 'stop' | 'toolUse' | 'error', content: any[], errorMessage?: string) => {
      const msg = {
        role: 'assistant' as const,
        timestamp: Date.now(),
        api: model.api,
        provider: model.provider,
        model: model.id,
        content,
        stopReason: reason,
        ...(errorMessage ? { errorMessage } : {}),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
      }
      if (reason === 'error') out.push({ type: 'error', reason: 'error', error: msg })
      else out.push({ type: 'done', reason, message: msg })
    }

    if (scenario === 'no-memory') {
      if (idx === 0) reply('toolUse', [{ type: 'toolCall', id: 'p1', name: 'plain_ok', arguments: {} }])
      else reply('stop', [{ type: 'text', text: 'done without memory' }])
    } else if (scenario === 'parallel-gap') {
      if (idx === 0) {
        reply('toolUse', [
          { type: 'toolCall', id: 'cm-par', name: 'fake_codemode', arguments: { mode: 'parallel_cross_read' } }
        ])
      } else {
        reply('stop', [{ type: 'text', text: 'completed after read' }])
      }
    } else if (scenario === 'nested-codemode') {
      if (idx === 0) {
        reply('toolUse', [
          { type: 'toolCall', id: 'cm-plain', name: 'fake_codemode', arguments: { mode: 'plain_only' } },
          { type: 'toolCall', id: 'cm-mem', name: 'fake_codemode', arguments: { mode: 'memory_only_throw' } }
        ])
      } else if (idx === 1) {
        reply('toolUse', [
          { type: 'toolCall', id: 'cm-mix', name: 'fake_codemode', arguments: { mode: 'mixed_throw' } }
        ])
      } else {
        reply('stop', [{ type: 'text', text: 'nested ok' }])
      }
    } else if (scenario === 'retry-same-turn') {
      if (idx === 0) reply('toolUse', [{ type: 'toolCall', id: 'r-mem', name: 'memory_read', arguments: { scope: 'global', path: 'MEMORY.md' } }])
      else if (idx === 1) reply('error', [{ type: 'text', text: '' }], 'transient 503')
      else reply('stop', [{ type: 'text', text: 'recovered on retry' }])
    } else if (scenario === 'steer') {
      if (idx === 0) reply('toolUse', [{ type: 'toolCall', id: 'st-mem1', name: 'memory_read', arguments: { scope: 'global', path: 'MEMORY.md' } }])
      else if (idx === 1) reply('toolUse', [{ type: 'toolCall', id: 'st-mem2', name: 'memory_read', arguments: { scope: 'global', query: 'refresh token' } }])
      else reply('stop', [{ type: 'text', text: 'steered reply' }])
    } else if (scenario === 'mid-turn-project-change') {
      if (idx === 0) {
        currentProject = projectB
        reply('toolUse', [{ type: 'toolCall', id: 'mp-1', name: 'memory_add', arguments: { scope: 'project', path: 'repo.md', content: 'Repo created mid-turn' } }])
      } else {
        reply('stop', [{ type: 'text', text: 'added' }])
      }
    } else if (scenario === 'chat') {
      if (idx === 0) {
        reply('toolUse', [
          { type: 'toolCall', id: 'ch-g', name: 'memory_read', arguments: { scope: 'global', path: 'MEMORY.md' } },
          { type: 'toolCall', id: 'ch-p', name: 'memory_read', arguments: { scope: 'project', path: 'MEMORY.md' } }
        ])
      } else reply('stop', [{ type: 'text', text: 'chat done' }])
    } else if (scenario === 'disabled') {
      if (idx === 0) reply('toolUse', [{ type: 'toolCall', id: 'dis-1', name: 'memory_read', arguments: { scope: 'global', path: 'MEMORY.md' } }])
      else reply('stop', [{ type: 'text', text: 'disabled done' }])
    } else if (scenario === 'shutdown-late') {
      if (idx === 0) reply('toolUse', [
        { type: 'toolCall', id: 'sl-ok', name: 'memory_read', arguments: { scope: 'global', path: 'MEMORY.md' } },
        { type: 'toolCall', id: 'sl-late', name: 'late_memory', arguments: {} }
      ])
      else reply('stop', [{ type: 'text', text: 'done' }])
    } else if (scenario === 'delete-cleanup-fail') {
      if (idx === 0) reply('toolUse', [
        { type: 'toolCall', id: 'del-cf', name: 'memory_delete', arguments: { scope: 'global', path: 'sub/temp.md', revision: deleteTargetRev } }
      ])
      else reply('stop', [{ type: 'text', text: 'delete handled' }])
    } else if (scenario === 'sensitive-path-mixed') {
      if (idx === 0) reply('toolUse', [
        { type: 'toolCall', id: 'sp-1', name: 'memory_read', arguments: { scope: 'global', path: 'MEMORY.md' } },
        { type: 'toolCall', id: 'sp-2', name: 'memory_read', arguments: { scope: 'global', path: 'user@example.com.md', from: 'MEMORY.md' } },
        { type: 'toolCall', id: 'sp-3', name: 'memory_read', arguments: { scope: 'global', query: 'deploy guide' } },
        { type: 'toolCall', id: 'sp-4', name: 'memory_read', arguments: { scope: 'global', query: '/srv/example/runbook.md' } },
        { type: 'toolCall', id: 'sp-5', name: 'memory_read', arguments: { scope: 'global', path: 'MEMORY.md', query: 'C:/Work/example/runbook.md' } }
      ])
      else reply('stop', [{ type: 'text', text: 'sensitive path read done' }])
    } else if (scenario === 'long-turn') {
      if (idx === 0) reply('toolUse', Array.from({ length: 40 }, (_, i) => ({
        type: 'toolCall', id: `many-${i}`, name: 'memory_read', arguments: { scope: 'global' }
      })))
      else reply('stop', [{ type: 'text', text: 'done' }])
    }
    return out
  })

  let deleteTargetRev = ''

  try {
    // Seed global memory.
    const globalStore = new MemoryFiles(join(pigDir, 'memory', 'global'), join(pigDir, 'memory'))
    globalStore.save('MEMORY.md', '[Alpha](alpha.md)', null)

    const session = await makeSession(projectA, join(root, 'sessions-1'))

    // 1. Plain turn with no memory calls writes 0 telemetry rows.
    scenario = 'no-memory'; step = 0
    await session.prompt('plain only', { expandPromptTemplates: false })
    await session.waitForIdle()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(readTelemetryWindow().rows.length, 0, 'turns without memory calls never write telemetry')

    // 2. Parallel tool started BEFORE memory_read and failing AFTER memory_read stays in gap, not tail.
    scenario = 'parallel-gap'; step = 0
    slowGate = Promise.withResolvers<void>()
    await session.prompt('parallel check', { expandPromptTemplates: false })
    await session.waitForIdle()
    await new Promise(resolve => setTimeout(resolve, 30))
    const rowsAfterParallel = readTelemetryWindow().rows
    assert.equal(rowsAfterParallel.length, 1)
    assert.deepEqual(rowsAfterParallel[0]!.ops[0]!.gap, { calls: 1, errs: 1 })
    assert.deepEqual(rowsAfterParallel[0]!.tail, { calls: 0, errs: 0 })
    assert.equal(rowsAfterParallel[0]!.projectId, projectMemoryKey(projectA))
    assert.ok(rowsAfterParallel[0]!.turnId && rowsAfterParallel[0]!.anchorEntryId)

    // 3. Nested codemode tracking:
    // - plain_only wrapper counts as 1 call (no duplicate parent+children)
    // - memory_only_throw wrapper withdraws itself & does not count as post-read error
    // - mixed_throw counts plain_fail before memory in gap, plain_fail after memory in tail, outer error excluded
    scenario = 'nested-codemode'; step = 0
    await session.prompt('nested check', { expandPromptTemplates: false })
    await session.waitForIdle()
    await new Promise(resolve => setTimeout(resolve, 30))
    const rowsNested = readTelemetryWindow().rows
    assert.equal(rowsNested.length, 2)
    const nestedRow = rowsNested[1]!
    assert.equal(nestedRow.ops.length, 2)
    assert.deepEqual(nestedRow.ops[0]!.gap, { calls: 1, errs: 0 }, 'plain_only wrapper counted once, memory_only_throw wrapper excluded')
    assert.deepEqual(nestedRow.ops[1]!.gap, { calls: 1, errs: 1 }, 'pre-memory plain_fail counted once in gap; outer throw excluded')
    assert.deepEqual(nestedRow.tail, { calls: 1, errs: 1 }, 'post-memory plain_fail counted in tail; outer throw excluded')

    // 4. Retry settles once per user turn.
    scenario = 'retry-same-turn'; step = 0
    await session.prompt('retry check', { expandPromptTemplates: false })
    await session.waitForIdle()
    await new Promise(resolve => setTimeout(resolve, 30))
    const rowsRetry = readTelemetryWindow().rows
    assert.equal(rowsRetry.length, 3, 'retry within the same user turn must not produce a second row')
    assert.equal(rowsRetry[2]!.outcome, 'completed')

    // 5. Steer creates a new user turn; old turn settles as 'steered'.
    scenario = 'steer'; step = 0
    const steerDone = Promise.withResolvers<void>()
    const unsubSteer = session.subscribe(event => {
      if (event.type === 'tool_execution_end' && event.toolCallId === 'st-mem1') {
        void session.prompt('Wait, search refresh token instead', { streamingBehavior: 'steer', expandPromptTemplates: false })
          .then(() => steerDone.resolve(), () => steerDone.resolve())
      }
    })
    await session.prompt('initial steer turn', { expandPromptTemplates: false })
    await steerDone.promise
    await session.waitForIdle()
    unsubSteer()
    await new Promise(resolve => setTimeout(resolve, 40))
    const rowsSteer = readTelemetryWindow().rows
    assert.equal(rowsSteer.length, 5)
    assert.equal(rowsSteer[3]!.outcome, 'steered')
    assert.equal(rowsSteer[4]!.outcome, 'completed')
    assert.notEqual(rowsSteer[3]!.turnId, rowsSteer[4]!.turnId)
    assert.equal(rowsSteer[4]!.ops[0]!.op, 'search')
    assert.equal(rowsSteer[4]!.ops[0]!.query, 'refresh token')

    // 6. Mid-turn project identity change records op.projectId distinct from row.projectId.
    scenario = 'mid-turn-project-change'; step = 0
    currentProject = projectA
    await session.prompt('init repo mid turn', { expandPromptTemplates: false })
    await session.waitForIdle()
    await new Promise(resolve => setTimeout(resolve, 30))
    const rowsMid = readTelemetryWindow().rows
    assert.equal(rowsMid.length, 6)
    assert.equal(rowsMid[5]!.projectId, projectMemoryKey(projectA))
    assert.equal(rowsMid[5]!.ops[0]!.projectId, projectMemoryKey(projectB))
    currentProject = projectA

    // 7. Disabled fileMemory never collects telemetry.
    fileMemoryEnabled = false
    scenario = 'disabled'; step = 0
    await session.prompt('disabled read', { expandPromptTemplates: false })
    await session.waitForIdle()
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(readTelemetryWindow().rows.length, 6, 'disabled memory tools emit no telemetry')
    fileMemoryEnabled = true

    // 8. Tree navigation settles attributable completed ops on old branch before switching; late callbacks cannot leak.
    const leafBeforeTree = session.sessionManager.getLeafId()!
    const treeTarget = session.sessionManager.getBranch()[0]!.id
    // Simulate an attributable active turn that completed one memory_read right before a session_tree switch.
    scenario = 'shutdown-late'; step = 0
    lateToolGate = Promise.withResolvers<void>()
    const treeSwitchReady = Promise.withResolvers<void>()
    const unsubTree = session.subscribe(event => {
      if (event.type === 'tool_execution_end' && event.toolCallId === 'sl-ok') treeSwitchReady.resolve()
    })
    const treeTurnPromise = session.prompt('tree switch mid turn', { expandPromptTemplates: false })
    await treeSwitchReady.promise
    unsubTree()
    await session.extensionRunner.emit({ type: 'session_tree', newLeafId: treeTarget, oldLeafId: leafBeforeTree })
    lateToolGate.resolve()
    await treeTurnPromise.catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 30))
    const rowsAfterTree = readTelemetryWindow().rows
    assert.equal(rowsAfterTree.length, 7)
    assert.equal(rowsAfterTree[6]!.outcome, 'unknown')
    assert.equal(rowsAfterTree[6]!.ops.length, 1, 'tree switch settles only completed ops and drops late in-flight results')
    session.dispose()

    // 9. Chat session omits row.projectId and never downgrades failed project call to global.
    currentProject = chatDir
    const chatSession = await makeSession(chatDir, join(root, 'sessions-chat'))
    scenario = 'chat'; step = 0
    await chatSession.prompt('chat read', { expandPromptTemplates: false })
    await chatSession.waitForIdle()
    await new Promise(resolve => setTimeout(resolve, 30))
    const rowsChat = readTelemetryWindow().rows
    assert.equal(rowsChat.length, 8)
    assert.equal(rowsChat[7]!.projectId, undefined)
    assert.equal(rowsChat[7]!.ops[0]!.scope, 'global')
    assert.equal(rowsChat[7]!.ops[1]!.scope, 'project')
    assert.equal(rowsChat[7]!.ops[1]!.ok, false)
    assert.equal(rowsChat[7]!.ops[1]!.projectId, undefined)
    chatSession.dispose()
    currentProject = projectA

    // 10. Shutdown settles already-completed attributable ops as 'unknown' and ignores late in-flight results.
    const lateSession = await makeSession(projectA, join(root, 'sessions-late'))
    scenario = 'shutdown-late'; step = 0
    lateToolGate = Promise.withResolvers<void>()
    const lateReady = Promise.withResolvers<void>()
    const unsubLate = lateSession.subscribe(event => {
      if (event.type === 'tool_execution_end' && event.toolCallId === 'sl-ok') lateReady.resolve()
    })
    const runPromise = lateSession.prompt('shutdown mid flight', { expandPromptTemplates: false })
    await lateReady.promise
    unsubLate()
    await lateSession.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
    lateSession.dispose()
    lateToolGate.resolve()
    await runPromise.catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 30))
    const rowsLate = readTelemetryWindow().rows
    assert.equal(rowsLate.length, 9)
    assert.equal(rowsLate[8]!.outcome, 'unknown')
    assert.equal(rowsLate[8]!.ops.length, 1, 'unfinished in-flight memory op is dropped; only completed op settles')
    assert.ok(leafBeforeTree)

    // 11. Delete that succeeds on disk but fails empty-dir cleanup marks committed: true & ok: false.
    const delFile = globalStore.save('sub/temp.md', 'Delete me', null)
    deleteTargetRev = delFile.revision
    const globalDir = join(pigDir, 'memory', 'global')
    const delSession = await makeSession(projectA, join(root, 'sessions-del'))
    chmodSync(globalDir, 0o500)
    try {
      scenario = 'delete-cleanup-fail'; step = 0
      await delSession.prompt('delete with cleanup failure', { expandPromptTemplates: false })
      await delSession.waitForIdle()
      await new Promise(resolve => setTimeout(resolve, 30))
    } finally {
      chmodSync(globalDir, 0o700)
      delSession.dispose()
    }
    const rowsDel = readTelemetryWindow().rows
    assert.equal(rowsDel.length, 10)
    assert.equal(rowsDel[9]!.ops[0]!.op, 'delete')
    assert.equal(rowsDel[9]!.ops[0]!.ok, false)
    assert.equal(rowsDel[9]!.ops[0]!.committed, true)
    assert.equal(rowsDel[9]!.ops[0]!.beforeRev, delFile.revision)

    // 11b. Sensitive filename read omits path with pathOmitted: true while preserving normal sibling ops in order.
    globalStore.save('user@example.com.md', 'Contact note', null)
    const sensitiveSession = await makeSession(projectA, join(root, 'sessions-sensitive'))
    scenario = 'sensitive-path-mixed'; step = 0
    await sensitiveSession.prompt('read sensitive and normal memory', { expandPromptTemplates: false })
    await sensitiveSession.waitForIdle()
    await new Promise(resolve => setTimeout(resolve, 30))
    const winSens = readTelemetryWindow()
    assert.equal(winSens.coverage.skippedLines, 0, 'redacted path op must not corrupt its telemetry row')
    assert.equal(winSens.rows.length, 11)
    const sensRow = winSens.rows[10]!
    assert.deepEqual(sensRow.ops.map(op => op.op), ['read', 'read', 'search', 'search', 'search'])
    assert.equal(sensRow.ops[3]!.ok, true)
    assert.equal(sensRow.ops[3]!.query, undefined)
    assert.equal(sensRow.ops[4]!.ok, false)
    assert.equal(sensRow.ops[4]!.err, 'INVALID_ARGS')
    assert.equal(sensRow.ops[4]!.query, undefined)
    assert.doesNotMatch(JSON.stringify(sensRow), /example\/runbook\.md/)
    assert.equal(sensRow.ops[0]!.path, 'MEMORY.md')
    assert.equal(sensRow.ops[1]!.ok, true)
    assert.equal(sensRow.ops[1]!.path, undefined, 'sensitive path is never written back')
    assert.equal(sensRow.ops[1]!.pathOmitted, true)
    assert.equal(sensRow.ops[1]!.from, 'MEMORY.md')
    assert.equal(sensRow.ops[2]!.query, 'deploy guide')
    scenario = 'long-turn'; step = 0
    await sensitiveSession.prompt('collect a bounded turn', { expandPromptTemplates: false })
    await sensitiveSession.waitForIdle()
    await new Promise(resolve => setTimeout(resolve, 30))
    const longTurn = readTelemetryWindow().rows.at(-1)!
    assert.equal(longTurn.ops.length, 32)
    assert.equal(longTurn.opsTruncated, true)
    sensitiveSession.dispose()

    // 12. Telemetry write failure never breaks normal memory tool results.
    const brokenTelemetryDir = join(root, 'broken-pig')
    mkdirSync(join(brokenTelemetryDir, 'memory', 'global'), { recursive: true })
    writeFileSync(join(brokenTelemetryDir, 'memory-telemetry'), 'not-a-directory')
    process.env.PIG_DIR = brokenTelemetryDir
    new MemoryFiles(join(brokenTelemetryDir, 'memory', 'global'), join(brokenTelemetryDir, 'memory')).save('MEMORY.md', 'Intact', null)
    const resilientSession = await makeSession(projectA, join(root, 'sessions-broken'))
    scenario = 'parallel-gap'; step = 0
    slowGate = Promise.withResolvers<void>()
    slowGate.resolve()
    await resilientSession.prompt('read under broken telemetry', { expandPromptTemplates: false })
    await resilientSession.waitForIdle()
    const lastAssistant = [...resilientSession.messages].reverse().find(m => m.role === 'assistant')
    assert.equal((lastAssistant as any).stopReason, 'stop', 'memory tool execution succeeds despite telemetry failure')
    resilientSession.dispose()
  } finally {
    spy.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
} else {
  test('main-session telemetry collector tracks direct & nested calls, concurrency, retries, steers, tree switches, shutdown, and write resilience', async () => {
    const result = await runSelf(import.meta.path, ['--collector-fixture'], { timeoutMs: 25_000 })
    assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  }, 30_000)
}
