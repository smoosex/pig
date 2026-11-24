/**
 * Regression tests for OM proactive-compaction optimizations:
 * 1. Sending a prompt during OM proactive idle compaction immediately aborts compaction and proceeds.
 * 2. Sending a prompt during explicit manual compaction waits for `compaction_end` without aborting
 *    compaction, and cancels cleanly if `stopSessionExecution` fires while waiting.
 * 3. `DEFAULTS` use 70% ratio mode (`0.7`), `compactionCatchUpMaxChunks = 0`, and `enableInProjects = false`.
 * 4. `isObservationalMemoryEnabledForCwd` enables OM for Bot & Chats by default and keeps Project sessions off unless opted in.
 * 5. `bridgeEvents` tags proactive OM `compaction_start` events with `reason: 'memory'`.
 */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import { runSelf } from './helpers/subprocess.ts'

async function fixture(): Promise<void> {
  assert.ok(process.env.PIG_DIR, 'isolated PIG_DIR is required')
  mock.module('electron', () => ({
    app: { isPackaged: false, getPath: () => process.env.PIG_DIR!, getAppPath: () => process.cwd() }
  }))

  const { DEFAULTS, resolveCompactAfterTokens } = await import('../src/main/features/memory/config')
  const { getMemoryDefaults } = await import('../src/main/features/observational-memory-settings')
  const { Runtime, registerMemoryRuntime } = await import('../src/main/features/memory/runtime')
  const { awaitCompactionBeforePrompt, isProactiveMemoryCompaction } = await import('../src/main/features/memory/proactive-compaction')
  const { isObservationalMemoryEnabledForCwd } = await import('../src/main/features/runtime')
  const { bridgeEvents } = await import('../src/main/pi/event-bridge')

  // 1. Default values: 70% ratio, 0 catch-up chunks, project sessions enabled by default
  assert.equal(DEFAULTS.compactAfterTokensMode, 'ratio')
  assert.equal(DEFAULTS.compactAfterTokensRatio, 0.7)
  assert.equal(DEFAULTS.compactionCatchUpMaxChunks, 0)
  assert.equal(DEFAULTS.enableInProjects, true)
  const uiDefaults = await getMemoryDefaults()
  assert.equal(uiDefaults.compactAfterTokensRatio, 0.7)
  assert.equal(uiDefaults.compactionCatchUpMaxChunks, 0)
  assert.equal(resolveCompactAfterTokens(DEFAULTS, 200_000), 140_000)
  assert.equal(resolveCompactAfterTokens(DEFAULTS, 1_000_000), 700_000)

  // 2. Session-kind scope differentiation: Bot, Chat & Project enabled by default; Project can opt out independently
  const chatCwd = join(process.env.PIG_DIR!, 'chats', 'c1')
  const botCwd = join(process.env.PIG_DIR!, 'bot', 'workspace')
  const projectCwd = join(process.env.PIG_DIR!, 'some-repo')
  assert.equal(isObservationalMemoryEnabledForCwd(chatCwd), true)
  assert.equal(isObservationalMemoryEnabledForCwd(botCwd), true)
  assert.equal(isObservationalMemoryEnabledForCwd('/scratch/bot', { isolatedWorkspace: true }), true)
  assert.equal(isObservationalMemoryEnabledForCwd(projectCwd), true)

  const settingsDir = join(process.env.PIG_DIR!, 'plugins', 'observational-memory')
  mkdirSync(settingsDir, { recursive: true })
  writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({
    'observational-memory': { enableInProjects: false }
  }))
  assert.equal(isObservationalMemoryEnabledForCwd(projectCwd), false)
  assert.equal(isObservationalMemoryEnabledForCwd(chatCwd), true)
  assert.equal(isObservationalMemoryEnabledForCwd(botCwd), true)

  // 3. Proactive compaction event tagging (`reason: 'memory'`) + automatic abort when user sends a prompt
  const listeners = new Set<(event: AgentSessionEvent) => void>()
  const forwarded: Array<{ type: string; reason?: string }> = []
  let compacting = true
  let abortCalls = 0
  const emit = (event: AgentSessionEvent) => {
    for (const listener of [...listeners]) listener(event)
  }

  const fakeSession = {
    get isCompacting() { return compacting },
    abortCompaction: () => {
      abortCalls += 1
      queueMicrotask(() => {
        compacting = false
        emit({ type: 'compaction_end', reason: 'manual', result: undefined, aborted: true, willRetry: false } as unknown as AgentSessionEvent)
      })
    },
    subscribe: (fn: (event: AgentSessionEvent) => void) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    getFollowUpMessages: () => [],
    getSteeringMessages: () => [],
    sessionManager: { getEntries: () => [], getLeafId: () => null },
    agent: { streamFunction: createAssistantMessageEventStream }
  } as unknown as AgentSession

  const fakeWin = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (_channel: string, payload: { event: { type: string; reason?: string } }) => {
        forwarded.push(payload.event)
      }
    }
  } as unknown as BrowserWindow

  const runtime = new Runtime()
  runtime.proactiveCompactionRunning = true
  registerMemoryRuntime('om-session', runtime)
  const unbridge = bridgeEvents(fakeSession, 'om-session', fakeWin, async () => {})

  try {
    assert.equal(isProactiveMemoryCompaction('om-session'), true)
    emit({ type: 'compaction_start', reason: 'manual' } as unknown as AgentSessionEvent)
    assert.equal(forwarded.at(-1)?.reason, 'memory', 'proactive OM compaction reports reason="memory" to UI')

    await awaitCompactionBeforePrompt('om-session', fakeSession)
    assert.equal(abortCalls, 1, 'user prompt aborts proactive OM compaction immediately')
    assert.equal(compacting, false)

    // 4. Manual compaction (`proactiveCompactionRunning = false`): queues behind compaction without aborting it
    runtime.proactiveCompactionRunning = false
    compacting = true
    emit({ type: 'compaction_start', reason: 'manual' } as unknown as AgentSessionEvent)
    assert.equal(forwarded.at(-1)?.reason, 'manual', 'explicit manual compaction keeps reason="manual"')

    let promptReleased = false
    const waitingPrompt = awaitCompactionBeforePrompt('om-session', fakeSession).then(() => {
      promptReleased = true
    })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(abortCalls, 1, 'manual compaction is NOT aborted when user queues a prompt')
    assert.equal(promptReleased, false, 'prompt waits while manual compaction is still running')

    compacting = false
    emit({ type: 'compaction_end', reason: 'manual', result: {} as never, aborted: false, willRetry: false } as unknown as AgentSessionEvent)
    await waitingPrompt
    assert.equal(promptReleased, true, 'queued prompt proceeds automatically once manual compaction finishes')

    // 5. Cancellation while waiting behind manual compaction rejects cleanly
    compacting = true
    const cancelController = new AbortController()
    const cancelledWait = awaitCompactionBeforePrompt('om-session', fakeSession, cancelController.signal)
    cancelController.abort()
    await assert.rejects(cancelledWait, (err: unknown) => err instanceof DOMException && err.name === 'AbortError')
  } finally {
    unbridge()
    registerMemoryRuntime('om-session', undefined)
  }
}

if (process.argv.includes('--proactive-compaction-prompt-fixture')) {
  await fixture()
} else {
  test('OM proactive compaction yields to prompts, queues manual compaction, uses 70% ratio + 0 catch-up, and scopes projects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pig-om-opt-'))
    try {
      const { exitCode, stdout, stderr } = await runSelf(
        import.meta.path,
        ['--proactive-compaction-prompt-fixture'],
        { env: { PIG_DIR: dir }, timeoutMs: 12_000 }
      )
      assert.equal(exitCode, 0, stderr || stdout)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
