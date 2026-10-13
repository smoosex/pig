import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import type { BrowserWindow } from 'electron'
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { PastedTextMetadata } from '../src/shared/pasted-text'

async function fixture(): Promise<void> {
  const busyError = new Error('Agent is already processing')
  const accepted: Array<Parameters<AgentSession['prompt']>[1]> = []
  const pendingModes: unknown[] = []
  let cancelled = 0
  let released = 0
  const session = {
    isStreaming: false,
    isBashRunning: false,
    prompt: async (_text: string, options?: Parameters<AgentSession['prompt']>[1]) => {
      // The agent starts after the host's idle snapshot but before SDK acceptance.
      session.isStreaming = true
      if (!options?.streamingBehavior) throw busyError
      accepted.push(options)
    }
  }
  mock.module('../src/main/pi/session-registry', () => ({
    activateSessionInput: async () => ({ session: { cwd: '/project', agentSession: session }, releaseInput: () => { released++ } })
  }))
  mock.module('../src/main/project-worktrees', () => ({
    worktrees: { assertAvailable: () => {}, nameOnFirstPrompt: () => { throw new Error('Message not yet accepted') } }
  }))
  mock.module('../src/main/pi/branch-namer', () => ({ nameWorktreeBranch: () => {}, runBranchNamer: () => {} }))
  mock.module('../src/main/i18n', () => ({ t: (key: string) => key }))
  mock.module('../src/main/pi/event-bridge', () => ({
    queuePendingUserMessage: (_session: unknown, _text: unknown, _metadata: unknown, _onStart: unknown, mode: unknown) => {
      pendingModes.push(mode)
      return {
        cancel: () => { cancelled++ },
        submit: (task: () => Promise<unknown>) => task()
      }
    }
  }))
  const { promptSession } = await import('../src/main/pi/session-prompt')
  for (const streamingBehavior of ['followUp', 'steer'] as const) {
    session.isStreaming = false
    await promptSession('session', { text: 'Additional instructions', streamingBehavior })
    assert.equal(accepted.at(-1)?.streamingBehavior, streamingBehavior)
    assert.equal(pendingModes.at(-1), streamingBehavior)
  }
  for (const streamingBehavior of [undefined, 'invalid']) {
    session.isStreaming = false
    await assert.rejects(
      promptSession('session', { text: 'No valid delivery intent', streamingBehavior }),
      (error) => error === busyError
    )
    assert.equal(pendingModes.at(-1), undefined)
  }
  assert.equal(accepted.length, 2)
  assert.equal(cancelled, 2)
  assert.equal(released, 4)

  const { attachSystemUI, detachSystemUI, resetSystemUI } = await import('../src/main/pi/system-plugin-ui')
  const { reviewUI } = await import('../src/main/plugins/pig-ui')
  const events: unknown[] = []
  attachSystemUI('session', {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: (_channel: string, event: unknown) => events.push(event) }
  } as unknown as BrowserWindow)
  const ui = reviewUI({ sessionManager: { getSessionId: () => 'session' } })
  try {
    ui.setReturning(true)
    assert.deepEqual(events.at(-1), { kind: 'review-returning', sessionId: 'session', returning: true })
    for (const streamingBehavior of ['followUp', 'steer'] as const) {
      await assert.rejects(promptSession('session', { text: 'During summary', streamingBehavior }), /returning from review/)
    }
    assert.equal(accepted.length, 2)
    assert.equal(pendingModes.length, 4, 'blocked prompts never enter the delivery queue')
    assert.equal(released, 6, 'rejected prompts release the input lease')
    await promptSession('other-session', { text: 'Another session', streamingBehavior: 'followUp' })
    assert.equal(accepted.length, 3)
    resetSystemUI('session')
    assert.equal(ui.returning, false)
    assert.deepEqual(events.at(-1), { kind: 'reset', sessionId: 'session' })
    await promptSession('session', { text: 'After return', streamingBehavior: 'followUp' })
    assert.equal(accepted.length, 4)
  } finally {
    detachSystemUI('session')
  }
}

async function metadataFixture(action: 'dismiss' | 'steer' | 'handled'): Promise<void> {
  let handleNextInput = action === 'handled'
  let followUp: string[] = []
  let steering: string[] = []
  const listeners = new Set<(event: AgentSessionEvent) => void>()
  const events: AgentSessionEvent[] = []
  const persisted: Array<{ type: string; data: PastedTextMetadata }> = []
  const named: string[] = []
  const emit = (event: AgentSessionEvent) => { for (const listener of listeners) listener(event) }
  const emitQueue = () => emit({ type: 'queue_update', steering: [...steering], followUp: [...followUp] })
  const session = {
    isStreaming: false,
    isBashRunning: false,
    extensionRunner: { getCommand: (name: string) => name === 'end-review' ? { invocationName: name } : undefined },
    sessionManager: { appendCustomEntry: (type: string, data: PastedTextMetadata) => persisted.push({ type, data }) },
    subscribe(listener: (event: AgentSessionEvent) => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getFollowUpMessages: () => followUp,
    getSteeringMessages: () => steering,
    clearQueue() {
      const previous = { steering: [...steering], followUp: [...followUp] }
      steering = []
      followUp = []
      emitQueue()
      return previous
    },
    async steer(text: string) { steering.push(text); emitQueue() },
    async followUp(text: string) { followUp.push(text); emitQueue() },
    async prompt(text: string, options?: Parameters<AgentSession['prompt']>[1]) {
      assert.equal(options?.streamingBehavior, 'followUp', 'commands must keep their SDK delivery intent too')
      if (text === '/end-review') {
        options?.preflightResult?.('handled')
        return
      }
      assert.equal(this.isStreaming, true)
      if (handleNextInput) {
        handleNextInput = false
        options?.preflightResult?.('handled')
        return
      }
      await this.followUp(text)
      options?.preflightResult?.('queued')
    }
  }
  mock.module('../src/main/pi/session-registry', () => ({
    activateSessionInput: async () => ({ session: { cwd: '/project', agentSession: session }, releaseInput: () => {} })
  }))
  mock.module('../src/main/project-worktrees', () => ({
    worktrees: { assertAvailable: () => {}, nameOnFirstPrompt: async (_cwd: string, text: string) => { named.push(text) } }
  }))
  mock.module('../src/main/pi/branch-namer', () => ({ nameWorktreeBranch: () => {}, runBranchNamer: () => {} }))
  mock.module('../src/main/i18n', () => ({ t: (key: string) => key }))

  const { bridgeEvents } = await import('../src/main/pi/event-bridge')
  const { promptSession } = await import('../src/main/pi/session-prompt')
  const { updateFollowUpMessage } = await import('../src/main/pi/session-actions')
  const { normalizeSessionPrompt } = await import('../src/main/pi/prompt-input')
  const { PASTED_TEXT_CUSTOM_TYPE } = await import('../src/shared/pasted-text')
  const sdkSession = session as unknown as AgentSession
  const unsubscribe = bridgeEvents(sdkSession, 'session', {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: (_channel: string, payload: { event: AgentSessionEvent }) => events.push(payload.event) }
  } as unknown as BrowserWindow)
  try {
    // Cancelling an idle review command succeeds but produces no user message or queue entry.
    await promptSession('session', { text: '/end-review', streamingBehavior: 'followUp' })
    assert.deepEqual(followUp, [])
    assert.deepEqual(persisted, [])
    assert.deepEqual(named, [])
    session.isStreaming = true
    const inputs = ['A', 'B'].map((id) => ({
      text: 'Read notes', streamingBehavior: 'followUp',
      textAttachments: [{ id, text: 'identical attachment content', filename: `${id}.txt` }]
    }))
    const [first, second] = inputs.map(normalizeSessionPrompt)
    assert.equal(first.modelText, second.modelText)
    await promptSession('session', inputs[0])
    await promptSession('session', inputs[1])
    assert.deepEqual(followUp, action === 'handled' ? [second.modelText] : [first.modelText, second.modelText])
    assert.deepEqual(persisted, [], 'queued metadata cannot be written before delivery')
    const expected = action === 'steer' ? first : second
    if (action !== 'handled') await updateFollowUpMessage(sdkSession, 0, action)
    if (action === 'steer') {
      assert.deepEqual(steering, [first.modelText])
      await updateFollowUpMessage(sdkSession, 0, 'dismiss')
      assert.deepEqual(followUp, [])
    } else {
      assert.deepEqual(followUp, [second.modelText])
    }
    if (action === 'steer') steering.shift()
    else followUp.shift()
    emitQueue()
    const message = { role: 'user' as const, content: expected.modelText, timestamp: 1 }
    emit({ type: 'message_start', message })
    emit({ type: 'message_end', message })
    assert.deepEqual(persisted, [{ type: PASTED_TEXT_CUSTOM_TYPE, data: expected.metadata }])
    const delivered = events.filter((event) => event.type === 'message_start' || event.type === 'message_end')
    assert.equal(delivered.length, 2)
    for (const event of delivered) {
      assert.deepEqual((event.message as typeof message & { pastedText: unknown }).pastedText, expected.displayMetadata)
    }
    assert.deepEqual(named, ['Read notes'])
  } finally {
    unsubscribe()
  }
}

if (process.argv[2] === '--prompt-fixture') {
  const scenario = process.argv[3] ?? 'delivery'
  if (scenario === 'delivery') await fixture()
  else if (scenario === 'dismiss' || scenario === 'steer' || scenario === 'handled') await metadataFixture(scenario)
  else throw new Error(`Unknown prompt fixture: ${scenario}`)
} else {
  const cases = {
    delivery: 'prompt delivery intent survives an idle snapshot and real SDK failures still propagate',
    dismiss: 'a cancelled idle command cannot shift duplicate follow-up attachment metadata on dismissal',
    steer: 'a cancelled idle command cannot shift promoted follow-up metadata when the other duplicate is dismissed',
    handled: 'extension-handled input cannot shift attachment metadata onto a later identical follow-up'
  }
  for (const [scenario, name] of Object.entries(cases)) test(name, async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--prompt-fixture', scenario], { stdout: 'pipe', stderr: 'pipe' })
    const timeout = setTimeout(() => child.kill(), 10_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
      ])
      assert.equal(code, 0, stderr || stdout)
    } finally {
      clearTimeout(timeout)
      child.kill()
    }
  }, 15_000)
}
