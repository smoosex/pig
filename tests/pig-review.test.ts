import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import reviewExtension from '../src/main/plugins/pig-review/index'
import type { ReviewFeedback, ReviewReturnPhase } from '../src/shared/api'
import { isReviewReturning, registerSystemUI, type ReviewUI } from '../src/main/plugins/pig-ui'

interface Session {
  api: unknown
  ctx: unknown
  commands: Map<string, (args: string, ctx: unknown) => Promise<void>>
  handlers: Map<string, ((event: unknown, ctx: unknown) => unknown)[]>
  reviewStates: boolean[]
  returningStates: boolean[]
  returningPhases: (ReviewReturnPhase | undefined)[]
  appended: unknown[]
  sent: string[]
  feedback: (ReviewFeedback | null)[]
  reviewUI: ReviewUI
}

// Pi caches extension modules per cwd, so one module instance backs every session in a worktree.
// Calling the factory twice models two Pig sessions sharing that instance.
function createSession(id: string, branch: unknown[] = [], cwd = '/nonexistent-pig-review-workspace', finishAction?: string): Session {
  const feedback: (ReviewFeedback | null)[] = []
  const reviewStates: boolean[] = []
  const returningStates: boolean[] = []
  const returningPhases: (ReviewReturnPhase | undefined)[] = []
  const appended: unknown[] = []
  const sent: string[] = []
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>()
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>()
  const ctx = {
    hasUI: false,
    cwd,
    sessionManager: {
      getSessionId: () => id,
      getBranch: () => branch,
      getEntries: () => branch,
      getLeafId: () => 'leaf-1'
    },
    get ui(): never { throw new Error('Native plugin UI must not be used') },
    navigateTree: async () => ({ cancelled: false })
  }
  const api = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.set(name, options.handler)
    },
    appendEntry: (_customType: string, data?: unknown) => appended.push(data),
    exec: async () => ({ stdout: '', stderr: '', code: 0 }),
    sendUserMessage: (content: string) => sent.push(content)
  }
  const reviewUI: ReviewUI = {
      available: true, get returning() { return returningStates.at(-1) ?? false },
      choose: async (step) => step === 'finish' ? finishAction : undefined, edit: async () => undefined,
      setActive: (active) => reviewStates.push(active),
      setReturning: (returning, phase) => { returningStates.push(returning); returningPhases.push(phase) },
      setFeedback: (value) => feedback.push(value)
  }
  registerSystemUI(id, { send: () => {}, memory: { notify: () => {} }, review: reviewUI })
  return { api, ctx, commands, handlers, reviewStates, returningStates, returningPhases, appended, sent, feedback, reviewUI }
}

function loadExtension(session: Session): void {
  ;(reviewExtension as unknown as (pi: unknown) => void)(session.api)
}

async function emit(session: Session, event: string, data = {}): Promise<void> {
  for (const handler of session.handlers.get(event) ?? []) await handler({ type: event, ...data }, session.ctx)
}

test('pig-review: configured models borrow only the review turn and fall back once on failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pig-review-model-'))
  const previous = process.env.PIG_DIR
  process.env.PIG_DIR = root
  try {
    await mkdir(join(root, 'plugin-settings'))
    const settingsPath = join(root, 'plugin-settings', 'pig-review.json')
    const original = { provider: 'session', id: 'original' }
    const review = { provider: 'review', id: 'configured' }
    for (const scenario of ['inherit', 'thinking-only', 'success', 'missing', 'no-auth', 'switch-failed', 'auth-error', 'switch-error', 'request-failed', 'aborted', 'manual-change']) {
      await writeFile(settingsPath, JSON.stringify({ 'pig-review': scenario === 'inherit' ? {} : scenario === 'thinking-only' ? { thinking: 'high' } : { provider: review.provider, modelId: review.id, thinking: 'high' } }))
      let thinking = 'medium'
      const unexpected = new Error('Unexpected model selection failure')
      const session = createSession(`model-${scenario}`)
      const selected: unknown[] = []
      const ctx = Object.assign(session.ctx as object, {
        model: original,
        modelRegistry: {
          find: () => scenario === 'missing' ? undefined : review,
          getApiKeyAndHeaders: async () => {
            if (scenario === 'auth-error') throw unexpected
            return scenario === 'no-auth' ? { ok: false, error: 'Missing key' } : { ok: true }
          }
        }
      })
      Object.assign(session.api as object, {
        getThinkingLevel: () => thinking,
        setThinkingLevel: (level: string) => { thinking = level },
        setModel: async (model: typeof original) => {
          selected.push(model)
          if (scenario === 'switch-error') throw unexpected
          if (scenario === 'switch-failed' && model === review) return false
          ctx.model = model
          thinking = 'off'
          return true
        }
      })
      loadExtension(session)
      if (scenario === 'auth-error' || scenario === 'switch-error') {
        await assert.rejects(runReview(session, 'uncommitted'), (error) => error === unexpected)
        assert.equal(session.sent.length, 0)
        continue
      }
      await runReview(session, 'uncommitted')
      assert.equal(session.sent.length, 1)
      if (['inherit', 'thinking-only', 'missing', 'no-auth', 'switch-failed'].includes(scenario)) {
        assert.equal(ctx.model, original)
        assert.equal(thinking, 'medium')
        assert.equal(selected.length, scenario === 'switch-failed' ? 1 : 0)
        const fallback = session.feedback.at(-1)
        if (['missing', 'no-auth', 'switch-failed'].includes(scenario)) {
          assert.equal(fallback?.level, 'warning')
          assert.ok(fallback?.message.includes('review/configured'))
          assert.ok(fallback?.message.includes('session/original'))
          assert.ok(fallback?.detail)
        } else assert.equal(fallback, null)
        continue
      }
      assert.equal(ctx.model, scenario === 'thinking-only' ? original : review)
      assert.equal(thinking, 'high')
      if (scenario === 'manual-change') ctx.model = { provider: 'manual', id: 'chosen' }
      const modelBeforeToolRound = ctx.model
      await emit(session, 'turn_end', { message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall' }] } })
      assert.equal(ctx.model, modelBeforeToolRound)
      assert.equal(thinking, 'high', 'tool rounds must keep the review settings')
      const messages = [{ role: 'assistant', content: [], stopReason: scenario === 'request-failed' ? 'error' : scenario === 'aborted' ? 'aborted' : 'stop' }]
      await emit(session, 'turn_end', { message: messages[0] })
      assert.equal(ctx.model.provider, scenario === 'manual-change' ? 'manual' : original.provider)
      assert.equal(thinking, scenario === 'manual-change' ? 'high' : 'medium')
      assert.equal(session.sent.length, scenario === 'request-failed' ? 2 : 1)
      if (scenario === 'request-failed') {
        assert.equal(session.feedback.at(-1)?.level, 'warning')
        assert.ok(session.feedback.at(-1)?.detail?.includes('once'))
      }
      await emit(session, 'agent_end', { messages: [{ role: 'assistant', stopReason: 'error' }] })
      assert.equal(session.sent.length, scenario === 'request-failed' ? 2 : 1, 'fallback must not loop')
    }
  } finally {
    if (previous === undefined) delete process.env.PIG_DIR
    else process.env.PIG_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('pig-review: real agent follow-up queue uses restored session settings before agent_end', async () => {
  const { Agent } = await import('@earendil-works/pi-agent-core')
  const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai')
  const root = await mkdtemp(join(tmpdir(), 'pig-review-queue-'))
  const previous = process.env.PIG_DIR
  process.env.PIG_DIR = root
  try {
    await mkdir(join(root, 'plugin-settings'))
    const original: import('@earendil-works/pi-ai').Model<'openai-responses'> = {
      id: 'session-model', name: 'Session model', provider: 'fixture', api: 'openai-responses',
      baseUrl: 'http://unused.invalid', reasoning: true, input: ['text'],
      contextWindow: 100000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    }
    const review = { ...original, id: 'review-model' }
    for (const thinkingOnly of [false, true]) {
      await writeFile(join(root, 'plugin-settings', 'pig-review.json'), JSON.stringify({ 'pig-review': {
        ...(thinkingOnly ? {} : { provider: review.provider, modelId: review.id }), thinking: 'high'
      } }))
      const session = createSession(`queue-${thinkingOnly}`)
      const requests: { model: string; thinking: string | undefined; ended: boolean }[] = []
      let ended = false
      const agent = new Agent({
        initialState: { model: original, thinkingLevel: 'medium' },
        // AgentSession refreshes the request model/thinking from live state between turns.
        prepareNextTurn: () => ({ model: agent.state.model, thinkingLevel: agent.state.thinkingLevel }),
        streamFn: (model, _context, options) => {
          requests.push({ model: model.id, thinking: options?.reasoning, ended })
          if (requests.length === 1) agent.followUp({ role: 'user', content: 'Fix these issues', timestamp: Date.now() })
          const stream = createAssistantMessageEventStream()
          stream.push({ type: 'done', reason: 'stop', message: {
            role: 'assistant', api: model.api, provider: model.provider, model: model.id,
            content: [{ type: 'text', text: requests.length === 1 ? 'Review findings' : 'Fixes complete' }],
            stopReason: 'stop', timestamp: Date.now(),
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
          } })
          return stream
        }
      })
      Object.assign(session.ctx as object, {
        modelRegistry: { find: () => review, getApiKeyAndHeaders: async () => ({ ok: true }) }
      })
      Object.defineProperty(session.ctx, 'model', { get: () => agent.state.model })
      Object.assign(session.api as object, {
        getThinkingLevel: () => agent.state.thinkingLevel,
        setThinkingLevel: (level: typeof agent.state.thinkingLevel) => { agent.state.thinkingLevel = level },
        setModel: async (model: typeof original) => { agent.state.model = model; return true }
      })
      loadExtension(session)
      agent.subscribe(async (event) => {
        for (const handler of session.handlers.get(event.type) ?? []) await handler(event, session.ctx)
        if (event.type === 'agent_end') ended = true
      })
      await runReview(session, 'uncommitted')
      await agent.prompt(session.sent[0])
      assert.deepEqual(requests, [
        { model: thinkingOnly ? original.id : review.id, thinking: thinkingOnly ? 'medium' : 'high', ended: false },
        { model: original.id, thinking: 'medium', ended: false }
      ])
      assert.equal(ended, true)
    }
  } finally {
    if (previous === undefined) delete process.env.PIG_DIR
    else process.env.PIG_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('pig-review: configuration parse, validation and IO errors abort before review state changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pig-review-invalid-settings-'))
  const previous = process.env.PIG_DIR
  process.env.PIG_DIR = root
  try {
    await mkdir(join(root, 'plugin-settings'))
    const settingsPath = join(root, 'plugin-settings', 'pig-review.json')
    const invalid = [
      '{broken', 'null', '[]',
      JSON.stringify({ 'pig-review': [] }),
      JSON.stringify({ 'pig-review': { provider: 'only-provider' } }),
      JSON.stringify({ 'pig-review': { thinking: 'invalid' } })
    ]
    for (const [index, text] of invalid.entries()) {
      await writeFile(settingsPath, text)
      const session = createSession(`invalid-config-${index}`)
      loadExtension(session)
      await assert.rejects(runReview(session, 'uncommitted'))
      assert.deepEqual(session.sent, [])
      assert.deepEqual(session.appended, [])
      assert.deepEqual(session.reviewStates, [])
    }
    await rm(settingsPath)
    await mkdir(settingsPath)
    const session = createSession('settings-io-error')
    loadExtension(session)
    await assert.rejects(runReview(session, 'uncommitted'), { code: 'EISDIR' })
    assert.deepEqual(session.sent, [])
    assert.deepEqual(session.appended, [])
  } finally {
    if (previous === undefined) delete process.env.PIG_DIR
    else process.env.PIG_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})

async function runReview(session: Session, args: string): Promise<void> {
  const handler = session.commands.get('review')
  assert.ok(handler, 'review command is registered')
  await handler(args, session.ctx)
}

const reviewState = (originId: string) => ({
  type: 'custom',
  customType: 'review-session',
  data: { active: true, originId }
})

const reviewSettings = (customInstructions: string) => ({
  type: 'custom',
  customType: 'review-settings',
  data: { customInstructions }
})

test('pig-review: an active review in one session does not block or leak into another', async () => {
  const first = createSession('session-a', [reviewState('origin-a')])
  const second = createSession('session-b')
  loadExtension(first)
  loadExtension(second)

  await emit(first, 'session_start')
  assert.equal(first.reviewStates.at(-1), true)
  await emit(second, 'session_start')
  assert.deepEqual(second.reviewStates, [false])

  // The second session's own (empty) review state must not erase the first session's review.
  await assert.rejects(runReview(first, 'uncommitted'), /Already in a review/)
  assert.equal(first.sent.length, 0)

  await runReview(second, 'uncommitted')
  assert.equal(second.sent.length, 1)
})

test('pig-review: unreadable guidelines abort the review before any state is written', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pig-review-'))
  await mkdir(join(workspace, '.pi'))
  await writeFile(join(workspace, 'REVIEW_GUIDELINES.md'), 'Use tabs.\n')
  await chmod(join(workspace, 'REVIEW_GUIDELINES.md'), 0o000)

  // Root can read a 0000 file; then there is no failure left to assert.
  const unreadable = await readFile(join(workspace, 'REVIEW_GUIDELINES.md'), 'utf8').then(() => false, () => true)
  if (!unreadable) return

  const session = createSession('session-a', [], workspace)
  loadExtension(session)
  await emit(session, 'session_start')

  await assert.rejects(() => runReview(session, 'uncommitted'), /Could not read .*REVIEW_GUIDELINES\.md/)
  assert.equal(session.sent.length, 0)
  // Only the session_start deactivation, no activation push.
  assert.deepEqual(session.reviewStates, [false])
  assert.deepEqual(session.appended, [])
})

test('pig-review: guidelines that are not a regular file are ignored instead of failing the review', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pig-review-'))
  await mkdir(join(workspace, '.pi'))
  await mkdir(join(workspace, 'REVIEW_GUIDELINES.md'))

  const session = createSession('session-a', [], workspace)
  loadExtension(session)
  await emit(session, 'session_start')

  await runReview(session, 'uncommitted')
  assert.equal(session.sent.length, 1)
  assert.ok(!session.sent[0].includes('project has additional instructions'))
  assert.equal(session.reviewStates.at(-1), true)
})

test('pig-review: custom review instructions are read from the asking session only', async () => {
  const first = createSession('session-a', [reviewSettings('A-only rules')])
  const second = createSession('session-b')
  loadExtension(first)
  loadExtension(second)

  await emit(first, 'session_start')
  await emit(second, 'session_start')

  await runReview(second, 'uncommitted')
  assert.equal(second.sent.length, 1)
  assert.ok(!second.sent[0].includes('A-only rules'))

  await runReview(first, 'uncommitted')
  assert.equal(first.sent.length, 1)
  assert.ok(first.sent[0].includes('A-only rules'))
})

for (const action of ['returnOnly', 'returnAndSummarize', 'returnAndFix']) {
  test(`pig-review: ${action} locks only its session until navigation finishes`, async () => {
    const id = `return-${action}`
    const session = createSession(id, [reviewState('origin')], undefined, action)
    const other = createSession(`${id}-other`)
    loadExtension(session)
    loadExtension(other)
    await emit(session, 'session_start')
    let finish!: (value: { cancelled: boolean }) => void
    const navigation = new Promise<{ cancelled: boolean }>((resolve) => { finish = resolve })
    const ctx = session.ctx as Pick<ExtensionCommandContext, 'navigateTree'>
    ctx.navigateTree = async (target, options) => {
      assert.equal(target, 'origin')
      assert.equal(options?.summarize, action !== 'returnOnly')
      return navigation
    }
    const end = session.commands.get('end-review')!
    const ending = end('', session.ctx)
    await Promise.resolve()
    assert.equal(isReviewReturning(id), true)
    assert.equal(isReviewReturning(`${id}-other`), false)
    assert.deepEqual(session.returningStates, [true, true])
    assert.deepEqual(session.returningPhases, [undefined, action === 'returnOnly' ? 'returning' : 'summarizing'])
    await end('', session.ctx)
    assert.deepEqual(session.returningStates, [true, true], 'a duplicate command must not unlock the active return')
    assert.equal(session.sent.length, 0)
    finish({ cancelled: false })
    await ending
    assert.deepEqual(session.returningStates, [true, true, false])
    assert.equal(session.returningPhases.at(-1), undefined)
    assert.equal(isReviewReturning(id), false)
    assert.equal(session.reviewStates.at(-1), false)
    assert.equal(session.sent.length, action === 'returnAndFix' ? 1 : 0)
  })
}

test('pig-review: host forwards panel errors and feedback without notification events', async () => {
  const { attachSystemUI, detachSystemUI, replyReviewUI, reportReviewError } = await import('../src/main/pi/system-plugin-ui')
  const { reviewUI } = await import('../src/main/plugins/pig-ui')
  const events: import('../src/shared/api').SystemUIEvent[] = []
  const sender = { isDestroyed: () => false, send: (_channel: string, event: import('../src/shared/api').SystemUIEvent) => events.push(event) }
  attachSystemUI('review-host-errors', { isDestroyed: () => false, webContents: sender } as unknown as Parameters<typeof attachSystemUI>[1])
  try {
    const ui = reviewUI({ sessionManager: { getSessionId: () => 'review-host-errors' } })
    ui.setReturning(true, 'summarizing')
    assert.deepEqual(events.at(-1), { kind: 'review-returning', sessionId: 'review-host-errors', returning: true, phase: 'summarizing' })
    ui.setReturning(false)
    assert.deepEqual(events.at(-1), { kind: 'review-returning', sessionId: 'review-host-errors', returning: false })
    const editing = ui.edit('pr', '42', 'Sign in to GitHub')
    const prompt = events.at(-1)!
    assert.equal(prompt.kind, 'review-prompt')
    if (prompt.kind !== 'review-prompt') throw new Error('Expected review prompt')
    assert.equal(prompt.prefill, '42')
    assert.equal(prompt.error, 'Sign in to GitHub')
    replyReviewUI(sender as unknown as Parameters<typeof replyReviewUI>[0], prompt.id, null)
    assert.equal(await editing, undefined)
    reportReviewError('review-host-errors', 'command:end-review', 'Summary failed')
    assert.deepEqual(events.at(-1), { kind: 'review-feedback', sessionId: 'review-host-errors', feedback: { level: 'error', message: 'Summary failed' } })
    assert.equal(reportReviewError('review-host-errors', '/builtin/pig-review/index.ts', 'Model restoration failed', '/builtin/pig-review/index.ts'), true)
    assert.deepEqual(events.at(-1), { kind: 'review-feedback', sessionId: 'review-host-errors', feedback: { level: 'error', message: 'Model restoration failed' } })
    assert.equal(events.some((event) => event.kind === 'notify'), false)
  } finally {
    detachSystemUI('review-host-errors')
  }
})

for (const action of ['returnOnly', 'returnAndSummarize', 'returnAndFix']) {
  test(`pig-review: ${action} failures reach inline feedback through Pi command error dispatch`, async () => {
    const { AgentSession } = await import('@earendil-works/pi-coding-agent')
    const { reportReviewError } = await import('../src/main/pi/system-plugin-ui')
    const id = `failed-${action}`
    const session = createSession(id, [reviewState('origin')], undefined, action)
    loadExtension(session)
    await emit(session, 'session_start')
    const failure = new Error(`Navigation failed for ${action}`)
    ;(session.ctx as Pick<ExtensionCommandContext, 'navigateTree'>).navigateTree = async () => { throw failure }
    const dispatch = (AgentSession.prototype as unknown as {
      _tryExecuteExtensionCommand(text: string): Promise<boolean>
    })._tryExecuteExtensionCommand
    const emitted: string[] = []
    const handled = await dispatch.call({
      _extensionRunner: {
        getCommand: () => ({ handler: session.commands.get('end-review')! }),
        createCommandContext: () => session.ctx,
        emitError: (error: { extensionPath: string; error: string }) => {
          emitted.push(error.extensionPath)
          assert.equal(reportReviewError(id, error.extensionPath, error.error), true)
        }
      }
    }, '/end-review')
    assert.equal(handled, true, 'Pi consumes command errors instead of rejecting prompt()')
    assert.deepEqual(emitted, ['command:end-review'])
    assert.deepEqual(session.feedback.at(-1), { level: 'error', message: failure.message })
    assert.equal(reportReviewError(id, '/other/plugin.ts', 'Unrelated failure'), false)
    assert.deepEqual(session.returningStates, [true, true, false])
    assert.equal(session.returningPhases.at(-1), undefined)
    assert.equal(session.reviewStates.at(-1), true)
    assert.equal(session.sent.length, 0, 'failed returns never enqueue fixes')
    assert.equal(session.appended.length, 0, 'failed returns preserve review state')
  })
}

for (const scenario of ['missing-cli', 'no-auth', 'pending-changes', 'invalid-ref', 'fetch-failed', 'checkout-failed']) {
  test(`pig-review: PR ${scenario} stays in the input panel with the failed reference`, async () => {
    const session = createSession(`pr-${scenario}`)
    const edits: Array<{ prefill?: string; error?: string }> = []
    let checkoutCount = 0
    Object.assign(session.api as object, {
      exec: async (command: string, args: string[]) => {
        const result = { stdout: '', stderr: '', code: 0 }
        if (command === 'gh' && args[0] === '--version' && scenario === 'missing-cli') return { ...result, code: 1 }
        if (command === 'gh' && args[0] === 'auth' && scenario === 'no-auth') return { ...result, code: 1 }
        if (command === 'git' && args[0] === 'status' && scenario === 'pending-changes') return { ...result, stdout: ' M index.ts' }
        if (command === 'gh' && args[1] === 'view') {
          if (scenario === 'fetch-failed') return { ...result, code: 1, stderr: 'PR not found' }
          return { ...result, stdout: JSON.stringify({ baseRefName: 'main', headRefName: 'feature', title: 'Test PR' }) }
        }
        if (command === 'gh' && args[1] === 'checkout') {
          checkoutCount++
          return { ...result, code: 1, stderr: 'Checkout rejected' }
        }
        return result
      }
    })
    session.reviewUI.edit = async (_step, prefill, error) => {
      edits.push({ prefill, error })
      return undefined // Explicit cancellation after seeing the failure.
    }
    loadExtension(session)
    const ref = scenario === 'invalid-ref' ? 'invalid' : '42'
    await runReview(session, `pr ${ref}`)
    assert.equal(edits.length, 1)
    assert.equal(edits[0].prefill, ref)
    assert.ok(edits[0].error, 'preparation failure must be visible in the PR panel')
    assert.equal(checkoutCount, scenario === 'checkout-failed' ? 1 : 0)
    assert.deepEqual(session.sent, [])
    assert.deepEqual(session.appended, [])
    assert.deepEqual(session.feedback, [null], 'cancellation adds no error banner or toast')
  })
}

test('pig-review: PR retry uses the edited reference and unexpected execution errors propagate', async () => {
  const session = createSession('pr-retry')
  const viewed: string[] = []
  const checkedOut: string[] = []
  Object.assign(session.api as object, {
    exec: async (command: string, args: string[]) => {
      const result = { stdout: '', stderr: '', code: 0 }
      if (command === 'gh' && args[1] === 'view') {
        viewed.push(args[2])
        if (args[2] === '42') return { ...result, code: 1, stderr: 'PR not found' }
        return { ...result, stdout: JSON.stringify({ baseRefName: 'main', headRefName: 'feature', title: 'Test PR' }) }
      }
      if (command === 'gh' && args[1] === 'checkout') checkedOut.push(args[2])
      return result
    }
  })
  session.reviewUI.edit = async (_step, prefill, error) => {
    assert.equal(prefill, '42')
    assert.ok(error?.includes('PR not found'))
    return '43'
  }
  loadExtension(session)
  await runReview(session, 'pr 42')
  assert.deepEqual(viewed, ['42', '43'])
  assert.deepEqual(checkedOut, ['43'])
  assert.equal(session.sent.length, 1)

  const broken = createSession('pr-exec-error')
  const failure = new Error('Process spawn failed')
  Object.assign(broken.api as object, { exec: async (command: string) => {
    if (command === 'gh') throw failure
    return { stdout: '', stderr: '', code: 0 }
  } })
  broken.reviewUI.edit = async () => { throw new Error('Unexpected failure must not reopen the PR input') }
  loadExtension(broken)
  await assert.rejects(runReview(broken, 'pr 42'), (error) => error === failure)
})

for (const outcome of ['cancelled', 'failed', 'menu-cancelled']) {
  test(`pig-review: ${outcome} return unlocks the composer without clearing review mode`, async () => {
    const session = createSession(`return-${outcome}`, [reviewState('origin')], undefined,
      outcome === 'menu-cancelled' ? undefined : 'returnAndSummarize')
    loadExtension(session)
    await emit(session, 'session_start')
    const ctx = session.ctx as Pick<ExtensionCommandContext, 'navigateTree'>
    ctx.navigateTree = async () => {
      if (outcome === 'failed') throw new Error('Summary failed')
      return { cancelled: true }
    }
    const ending = session.commands.get('end-review')!('', session.ctx)
    if (outcome === 'failed') await assert.rejects(ending, /Summary failed/)
    else await ending
    assert.deepEqual(session.returningStates, outcome === 'menu-cancelled' ? [true, false] : [true, true, false])
    assert.equal(session.returningPhases.at(-1), undefined)
    assert.equal(session.reviewStates.at(-1), true)
    assert.equal(session.sent.length, 0)
  })
}
