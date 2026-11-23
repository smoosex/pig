/**
 * Focused regression tests for Bot model & thinking resolution:
 * - Preview and first actual prompt share one resolver (same model & thinking level, even when SDK default differs)
 * - Cached model-less session recovers on retry after logging into a single-model provider without calling setModel
 * - Emits controls_changed(null) when the last available model disappears and detects display-name changes
 * - Propagates settings read/parse failures and setModel failures explicitly without caching broken sessions
 * - Logs listener sync errors and async refresh rejections instead of swallowing them
 * - Isolates subprocess PIG_DIR to a temporary directory cleaned up after the run
 */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ThinkingLevel } from '../src/shared/api'
import type { BotEvent } from '../src/shared/bot'
import { runSelf } from './helpers/subprocess.ts'

interface FakeModel {
  id: string
  provider: string
  name: string
  contextWindow: number
  reasoning: boolean
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>
}

async function fixture() {
  assert.ok(process.env.PIG_DIR, 'fixture subprocess must receive an isolated PIG_DIR')
  const sdk = await import('@earendil-works/pi-coding-agent')
  const RealSettingsManager = sdk.SettingsManager

  const models: FakeModel[] = [
    { id: 'alpha', provider: 'anthropic', name: 'Alpha', contextWindow: 200_000, reasoning: true },
    { id: 'beta', provider: 'google', name: 'Beta', contextWindow: 1_000_000, reasoning: true }
  ]

  let available: FakeModel[] = [...models]
  let stored = JSON.stringify({})
  let failSettingsRead = false
  let failNextSetModel: Error | null = null
  let initialSdkModel: FakeModel | undefined = models[1]
  let initialSdkThinking: ThinkingLevel = 'medium'

  const promptCalls: Array<{
    text: string
    model: { provider: string; id: string } | undefined
    thinkingLevel: ThinkingLevel
  }> = []
  let createdSessions = 0
  let disposedSessions = 0

  const createSettings = () =>
    RealSettingsManager.fromStorage({
      withLock(scope, fn) {
        if (scope === 'global' && failSettingsRead) throw new Error('Corrupt settings.json')
        const next = fn(scope === 'global' ? stored : undefined)
        if (next !== undefined && scope === 'global') stored = next
      }
    })

  mock.module('electron', () => ({
    app: { getPath: () => process.env.PIG_DIR!, isPackaged: false, getAppPath: () => process.cwd() },
    BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
    ipcMain: { handle: () => {}, removeHandler: () => {} },
    dialog: {},
    nativeTheme: { shouldUseDarkColors: false },
    utilityProcess: {}
  }))

  mock.module('@earendil-works/pi-coding-agent', () => ({
    ...sdk,
    SettingsManager: { create: createSettings },
    ModelRuntime: {
      create: async () => ({
        getModel: (provider: string, id: string) =>
          models.find((item) => item.provider === provider && item.id === id),
        // Intentionally async like the real SDK: indexing getAvailable()[0] yields undefined.
        getAvailable: async () => available,
        getAvailableSnapshot: () => available,
        getProvider: (provider: string) => ({ name: provider === 'anthropic' ? 'Anthropic' : 'Google' })
      })
    }
  }))

  // Mock createSessionRuntime so we can simulate Pi picking a provider-recommended model & 'medium'
  // (or restoring from a real persisted SessionManager) while asserting the exact model & thinking
  // level observed by session.prompt().
  mock.module(fileURLToPath(new URL('../src/main/pi/session-runtime.ts', import.meta.url)), () => ({
    SessionResourceError: class SessionResourceError extends Error { readonly code = 'ERR_SESSION_RESOURCES_UNAVAILABLE' },
    assertExtensionResources: () => {},
    createSessionRuntime: async (
      _cwd: string,
      sessionManager: {
        getSessionId: () => string
        buildSessionContext?: () => { model: { provider: string; modelId: string } | null; thinkingLevel: string }
        getBranch?: () => Array<{ type: string }>
        getEntries?: () => Array<{ type: string }>
        appendThinkingLevelChange?: (level: string) => void
      },
      _plugins: string[],
      _appendPrompt: unknown,
      options?: { extraExtensions?: Array<{ name: string; factory: (pi: unknown) => void }> }
    ) => {
      createdSessions += 1
      let sendTool: { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> } | undefined
      const fakePi = {
        registerTool: (def: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }) => {
          if (def.name === 'send_message') sendTool = def
        },
        on: () => {}
      }
      for (const ext of options?.extraExtensions ?? []) {
        ext.factory(fakePi)
      }

      const persistedContext = sessionManager.buildSessionContext?.()
      const restoredModel = persistedContext?.model
        ? models.find((m) => m.provider === persistedContext.model!.provider && m.id === persistedContext.model!.modelId)
        : undefined
      const hasExistingSession = (sessionManager.getEntries?.().length ?? 0) > 0
      const hasPersistedThinking = sessionManager.getBranch?.().some((entry) => entry.type === 'thinking_level_change') ?? false
      let currentModel: FakeModel | undefined = restoredModel ?? initialSdkModel
      let currentThinking: ThinkingLevel = hasPersistedThinking
        ? (persistedContext!.thinkingLevel as ThinkingLevel)
        : initialSdkThinking

      // Mirror Pi SDK core/sdk.js: when resuming an existing session that lacks a thinking_level_change entry,
      // the SDK appends its default thinking level ('medium') to the JSONL during runtime creation.
      if (hasExistingSession && !hasPersistedThinking && currentModel) {
        currentThinking = 'medium'
        sessionManager.appendThinkingLevelChange?.('medium')
      }

      return {
        sessionId: sessionManager.getSessionId(),
        sessionManager,
        get model() { return currentModel },
        get thinkingLevel() { return currentThinking },
        setModel: async (next: FakeModel) => {
          if (failNextSetModel) {
            const err = failNextSetModel
            failNextSetModel = null
            throw err
          }
          currentModel = next
        },
        setThinkingLevel: (level: ThinkingLevel) => {
          currentThinking = level
        },
        bindExtensions: async () => {},
        subscribe: () => () => {},
        abort: async () => {},
        dispose: () => { disposedSessions += 1 },
        prompt: async (text: string) => {
          promptCalls.push({
            text,
            model: currentModel ? { provider: currentModel.provider, id: currentModel.id } : undefined,
            thinkingLevel: currentThinking
          })
          if (!currentModel) {
            throw new Error('No model selected for Bot session')
          }
          await sendTool?.execute('call-1', { type: 'text', content: `reply:${currentModel.id}:${currentThinking}` })
        }
      }
    }
  }))

  const { onDefaultSettingsChanged, updateDefaultSettings } = await import('../src/main/pi/model-settings')
  const { onModelCatalogChanged, synchronizeModelCatalog } = await import('../src/main/pi/model-catalog')
  const { BotService } = await import('../src/main/bot/service')

  async function waitUntil(check: () => boolean, label: string, timeoutMs = 1500): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  // Capture console.error to verify sync listener failures and async refresh rejections are never swallowed.
  const consoleErrors: unknown[][] = []
  const originalConsoleError = console.error
  console.error = (...args: unknown[]) => { consoleErrors.push(args) }

  try {
    // 1. Preview and first actual prompt share the exact same model & thinking level even when SDK default differs.
    {
      const dir = mkdtempSync(join(process.env.PIG_DIR!, 'bot-first-send-'))
      const service = new BotService(dir)
      const events: BotEvent[] = []
      const unsub = service.subscribe((event) => events.push(event))
      try {
        stored = JSON.stringify({})
        available = [...models]
        // Simulate Pi SDK picking provider-recommended 'beta' + 'medium' while preview picks 'alpha' + 'low'.
        initialSdkModel = models[1]
        initialSdkThinking = 'medium'

        const snap = await service.getSnapshot()
        assert.ok(snap.controls?.model, 'preview selects an available default model')
        assert.equal(snap.controls.model.provider, 'anthropic')
        assert.equal(snap.controls.model.id, 'alpha')
        assert.equal(snap.controls.thinkingLevel, 'low')
        assert.deepEqual(snap.controls.thinkingLevels, ['low', 'medium', 'high'])

        await service.sendMessage({ text: 'hello first turn' })
        await waitUntil(() => promptCalls.length >= 1 && events.some((e) => e.type === 'timeline_item' && e.item.kind === 'assistant'), 'first prompt reply')

        assert.deepEqual(promptCalls[0]?.model, { provider: 'anthropic', id: 'alpha' }, 'first prompt uses preview model')
        assert.equal(promptCalls[0]?.thinkingLevel, 'low', 'first prompt uses preview thinking level')
      } finally {
        unsub()
        await service.shutdown()
        rmSync(dir, { recursive: true, force: true })
      }
    }

    // 2. Send with zero models -> login single-model provider -> retry succeeds on cached session without setModel.
    {
      const dir = mkdtempSync(join(process.env.PIG_DIR!, 'bot-retry-after-login-'))
      const service = new BotService(dir)
      const events: BotEvent[] = []
      const unsub = service.subscribe((event) => events.push(event))
      try {
        promptCalls.length = 0
        stored = JSON.stringify({})
        available = []
        initialSdkModel = undefined
        initialSdkThinking = 'off'

        const emptySnap = await service.getSnapshot()
        assert.equal(emptySnap.controls, null)

        await service.sendMessage({ text: 'send before login' })
        await waitUntil(
          () => events.some((e) => e.type === 'timeline_item' && e.item.kind === 'system_fallback'),
          'model-less turn fallback'
        )
        assert.equal(promptCalls.length, 1)
        assert.equal(promptCalls[0]?.model, undefined)

        // User logs into a provider exposing only one model ('beta'); UI never needs to call setModel.
        events.length = 0
        available = [models[1]!]
        synchronizeModelCatalog()
        await waitUntil(
          () => events.some((e) => e.type === 'controls_changed' && e.controls?.model?.id === 'beta'),
          'catalog login populates single available model'
        )

        await service.retryLastMessage()
        await waitUntil(
          () => events.some((e) => e.type === 'timeline_item' && e.item.kind === 'assistant'),
          'retry succeeds after login'
        )
        assert.equal(promptCalls.length, 2)
        assert.deepEqual(promptCalls[1]?.model, { provider: 'google', id: 'beta' }, 'cached session applies newly available single model on retry')
        assert.equal(promptCalls[1]?.thinkingLevel, 'low')

        // 7. Display-name change for the same provider/id is not dropped by controlsKey deduplication.
        events.length = 0
        models[1] = { ...models[1]!, name: 'Beta Renamed' }
        available = [models[1]!]
        synchronizeModelCatalog()
        await waitUntil(
          () => events.some((e) => e.type === 'controls_changed' && e.controls?.model?.name === 'Beta Renamed'),
          'display name update emits controls_changed'
        )

        // 3. Last available model disappearing emits controls_changed(null) so renderer clears model & thinking.
        events.length = 0
        available = []
        synchronizeModelCatalog()
        await waitUntil(
          () => events.some((e) => e.type === 'controls_changed' && e.controls === null),
          'last model removal emits null controls'
        )
      } finally {
        models[1] = { ...models[1]!, name: 'Beta' }
        unsub()
        await service.shutdown()
        rmSync(dir, { recursive: true, force: true })
      }
    }

    // 4. Settings read/parse failure and setModel failure propagate explicitly; failed init is never cached.
    {
      const dir = mkdtempSync(join(process.env.PIG_DIR!, 'bot-errors-'))
      const service = new BotService(dir)
      const events: BotEvent[] = []
      const unsub = service.subscribe((event) => events.push(event))
      try {
        stored = JSON.stringify({})
        available = [...models]
        initialSdkModel = models[1]
        initialSdkThinking = 'medium'

        // Corrupt settings.json rejects getSnapshot & readBotControls explicitly instead of falling back.
        failSettingsRead = true
        await assert.rejects(() => service.getSnapshot(), /Corrupt settings\.json|Could not read default settings/)
        await assert.rejects(() => service.readBotControls(), /Corrupt settings\.json|Could not read default settings/)

        // 8. Async refresh rejection from catalog change is caught and logged via console.error, not swallowed.
        consoleErrors.length = 0
        available = [models[0]!]
        synchronizeModelCatalog()
        await waitUntil(() => consoleErrors.length > 0, 'async syncControls rejection logged')

        // Restore readable settings and test setModel failure during session init: error surfaces and session is disposed, not cached.
        failSettingsRead = false
        available = [...models]
        const beforeCreate = createdSessions
        const beforeDispose = disposedSessions
        failNextSetModel = new Error('Provider rejected setModel')

        await assert.rejects(() => service.setModel('google', 'beta'), /Provider rejected setModel/)
        assert.equal(createdSessions, beforeCreate + 1, 'session was constructed during failed init')
        assert.equal(disposedSessions, beforeDispose + 1, 'failed session was disposed instead of cached')

        // Subsequent initialization retries cleanly and succeeds once setModel works.
        const controls = await service.setModel('google', 'beta')
        assert.equal(createdSessions, beforeCreate + 2, 'subsequent call creates a fresh session instead of reusing failed init')
        assert.equal(controls?.model?.id, 'beta')
      } finally {
        failSettingsRead = false
        failNextSetModel = null
        unsub()
        await service.shutdown()
        rmSync(dir, { recursive: true, force: true })
      }
    }

    // 8. Sync listener exceptions in model-settings & model-catalog are logged and do not block other listeners.
    {
      consoleErrors.length = 0
      available = [...models]
      stored = JSON.stringify({})
      let settingsFollowupCalled = false
      const offBadSettings = onDefaultSettingsChanged(() => { throw new Error('boom-settings') })
      const offGoodSettings = onDefaultSettingsChanged(() => { settingsFollowupCalled = true })
      try {
        await updateDefaultSettings({ model: { provider: 'google', id: 'beta' }, thinkingLevel: 'high' })
        assert.equal(settingsFollowupCalled, true, 'subsequent default-settings listener still runs')
        assert.ok(
          consoleErrors.some((args) => args.some((a) => a instanceof Error && a.message === 'boom-settings')),
          'default-settings listener sync error is logged'
        )
      } finally {
        offBadSettings()
        offGoodSettings()
      }

      consoleErrors.length = 0
      let catalogFollowupCalled = false
      const offBadCatalog = onModelCatalogChanged(() => { throw new Error('boom-catalog') })
      const offGoodCatalog = onModelCatalogChanged(() => { catalogFollowupCalled = true })
      try {
        available = [models[1]!]
        synchronizeModelCatalog()
        assert.equal(catalogFollowupCalled, true, 'subsequent catalog listener still runs')
        assert.ok(
          consoleErrors.some((args) => args.some((a) => a instanceof Error && a.message === 'boom-catalog')),
          'catalog listener sync error is logged'
        )
      } finally {
        offBadCatalog()
        offGoodCatalog()
      }
    }
    // 9. Restart with a real persisted SessionManager JSONL: preview (without starting full session)
    //    matches the first prompt's actual model & thinking level, while explicit Bot preferences still win.
    {
      const dir = mkdtempSync(join(process.env.PIG_DIR!, 'bot-jsonl-resume-'))
      const workspaceDir = join(dir, 'workspace')
      const sessionsDir = join(dir, 'sessions')
      mkdirSync(workspaceDir, { recursive: true })
      mkdirSync(sessionsDir, { recursive: true })

      // Seed state.json (no explicit state.model / state.thinkingLevel) and a real persisted JSONL with beta/medium.
      const seedService = new BotService(dir)
      const seededState = await seedService.store.ensureState()
      await seedService.shutdown()

      const sm = sdk.SessionManager.create(workspaceDir, sessionsDir, { id: seededState.sessionId })
      sm.appendModelChange('google', 'beta')
      sm.appendThinkingLevelChange('medium')
      sm.appendMessage({ role: 'user', content: 'earlier turn', timestamp: 1000 })
      sm.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'earlier reply' }],
        api: 'google-generative-ai',
        provider: 'google',
        model: 'beta',
        usage: {
          input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: 'stop',
        timestamp: 2000
      })
      assert.ok(
        sdk.SessionManager.findById(workspaceDir, seededState.sessionId, sessionsDir),
        'real SessionManager history JSONL must exist on disk'
      )

      // Subcase A: no explicit state.model -> default preview would be alpha/low, but persisted history is beta/medium.
      const resumed = new BotService(dir)
      const events: BotEvent[] = []
      const unsub = resumed.subscribe((event) => events.push(event))
      try {
        promptCalls.length = 0
        stored = JSON.stringify({})
        available = [...models]
        initialSdkModel = models[0]
        initialSdkThinking = 'low'

        const sessionsBeforePreview = createdSessions
        const snap = await resumed.getSnapshot()
        assert.equal(createdSessions, sessionsBeforePreview, 'preview must not materialize full AgentSession')
        assert.equal(snap.controls?.model?.provider, 'google')
        assert.equal(snap.controls?.model?.id, 'beta', 'cold-start preview reflects persisted JSONL model')
        assert.equal(snap.controls?.thinkingLevel, 'medium', 'cold-start preview reflects persisted JSONL thinking level')

        await resumed.sendMessage({ text: 'after restart' })
        await waitUntil(
          () => promptCalls.length >= 1 && events.some((e) => e.type === 'timeline_item' && e.item.kind === 'assistant'),
          'resumed session first prompt'
        )
        assert.deepEqual(promptCalls[0]?.model, { provider: 'google', id: 'beta' }, 'first prompt after restart matches preview model')
        assert.equal(promptCalls[0]?.thinkingLevel, 'medium', 'first prompt after restart matches preview thinking level')
      } finally {
        unsub()
        await resumed.shutdown()
      }

      // Subcase B: explicit Bot preference in state.json overrides persisted JSONL for both preview and first prompt.
      const overridden = new BotService(dir)
      const overrideEvents: BotEvent[] = []
      const unsubOverride = overridden.subscribe((event) => overrideEvents.push(event))
      try {
        await overridden.store.updateState((s) => ({
          ...s,
          model: { provider: 'anthropic', id: 'alpha' },
          thinkingLevel: 'high'
        }))
        promptCalls.length = 0
        const sessionsBeforePreview = createdSessions
        const snap = await overridden.getSnapshot()
        assert.equal(createdSessions, sessionsBeforePreview, 'override preview must not materialize full AgentSession')
        assert.equal(snap.controls?.model?.id, 'alpha', 'explicit state.model overrides JSONL history')
        assert.equal(snap.controls?.thinkingLevel, 'high', 'explicit state.thinkingLevel overrides JSONL history')

        await overridden.sendMessage({ text: 'after override restart' })
        await waitUntil(
          () => promptCalls.length >= 1 && overrideEvents.some((e) => e.type === 'timeline_item' && e.item.kind === 'assistant'),
          'overridden resumed session first prompt'
        )
        assert.deepEqual(promptCalls[0]?.model, { provider: 'anthropic', id: 'alpha' })
        assert.equal(promptCalls[0]?.thinkingLevel, 'high')
      } finally {
        unsubOverride()
        await overridden.shutdown()
        rmSync(dir, { recursive: true, force: true })
      }
      // Subcase C: legacy persisted JSONL WITHOUT thinking_level_change.
      // Simulated SDK appends 'medium' to the JSONL during createSessionRuntime(),
      // yet both cold-start preview and the first prompt must stay on 'low' (frozen before SDK mutation).
      const legacyDir = mkdtempSync(join(process.env.PIG_DIR!, 'bot-jsonl-no-thinking-'))
      const legacyWorkspaceDir = join(legacyDir, 'workspace')
      const legacySessionsDir = join(legacyDir, 'sessions')
      mkdirSync(legacyWorkspaceDir, { recursive: true })
      mkdirSync(legacySessionsDir, { recursive: true })

      const legacySeed = new BotService(legacyDir)
      const legacyState = await legacySeed.store.ensureState()
      await legacySeed.shutdown()

      const legacySm = sdk.SessionManager.create(legacyWorkspaceDir, legacySessionsDir, { id: legacyState.sessionId })
      legacySm.appendModelChange('google', 'beta')
      legacySm.appendMessage({ role: 'user', content: 'legacy turn without thinking', timestamp: 1000 })
      legacySm.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'legacy reply' }],
        api: 'google-generative-ai',
        provider: 'google',
        model: 'beta',
        usage: {
          input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: 'stop',
        timestamp: 2000
      })
      const legacyFile = sdk.SessionManager.findById(legacyWorkspaceDir, legacyState.sessionId, legacySessionsDir)
      assert.ok(legacyFile, 'legacy history JSONL without thinking_level_change must exist on disk')

      const legacyResumed = new BotService(legacyDir)
      const legacyEvents: BotEvent[] = []
      const unsubLegacy = legacyResumed.subscribe((event) => legacyEvents.push(event))
      try {
        promptCalls.length = 0
        stored = JSON.stringify({})
        available = [...models]
        initialSdkModel = models[0]
        initialSdkThinking = 'medium'

        const sessionsBeforePreview = createdSessions
        const snap = await legacyResumed.getSnapshot()
        assert.equal(createdSessions, sessionsBeforePreview, 'legacy preview must not materialize full AgentSession')
        assert.equal(snap.controls?.model?.provider, 'google')
        assert.equal(snap.controls?.model?.id, 'beta')
        assert.equal(snap.controls?.thinkingLevel, 'low', 'preview without thinking_level_change picks first visible level (low)')

        await legacyResumed.sendMessage({ text: 'first prompt after legacy restart' })
        await waitUntil(
          () => promptCalls.length >= 1 && legacyEvents.some((e) => e.type === 'timeline_item' && e.item.kind === 'assistant'),
          'legacy resumed session first prompt'
        )

        // Confirm the simulated SDK really appended a synthetic thinking_level_change='medium' to the JSONL.
        const reopened = sdk.SessionManager.open(legacyFile, legacySessionsDir, legacyWorkspaceDir)
        assert.ok(
          reopened.getBranch().some((entry) => entry.type === 'thinking_level_change' && entry.thinkingLevel === 'medium'),
          'simulated SDK appended synthetic medium thinking_level_change during runtime creation'
        )
        assert.deepEqual(promptCalls[0]?.model, { provider: 'google', id: 'beta' })
        assert.equal(promptCalls[0]?.thinkingLevel, 'low', 'first prompt keeps pre-creation frozen low instead of synthetic SDK medium')
      } finally {
        unsubLegacy()
        await legacyResumed.shutdown()
        rmSync(legacyDir, { recursive: true, force: true })
      }
    }

    // 10. Multi-window broadcast: Window B calling getSnapshot() after catalog changes but before notification
    //     must NOT suppress the controls_changed broadcast needed by Window A.
    {
      const dir = mkdtempSync(join(process.env.PIG_DIR!, 'bot-multi-window-'))
      const service = new BotService(dir)
      const broadcastEvents: BotEvent[] = []
      const unsub = service.subscribe((event) => broadcastEvents.push(event))
      try {
        stored = JSON.stringify({})
        available = [models[0]!]
        synchronizeModelCatalog()

        // Window A reads old value ('alpha').
        const windowA = await service.getSnapshot()
        assert.equal(windowA.controls?.model?.id, 'alpha')

        // Catalog updates underneath to 'beta', and Window B fetches snapshot before synchronizeModelCatalog() notifies.
        broadcastEvents.length = 0
        available = [models[1]!]
        const windowB = await service.getSnapshot()
        assert.equal(windowB.controls?.model?.id, 'beta')

        // Now catalog notification fires: must still broadcast 'beta' so Window A updates.
        synchronizeModelCatalog()
        await waitUntil(
          () => broadcastEvents.some((e) => e.type === 'controls_changed' && e.controls?.model?.id === 'beta'),
          'broadcast controls_changed to Window A despite Window B getSnapshot'
        )
      } finally {
        unsub()
        await service.shutdown()
        rmSync(dir, { recursive: true, force: true })
      }
    }
  } finally {
    console.error = originalConsoleError
  }
}

if (process.argv.includes('--fixture')) {
  await fixture()
  process.exit(0)
}

test('Bot default model resolution, retry after login, null controls, error propagation, and listener isolation', async () => {
  const tempPigDir = mkdtempSync(join(tmpdir(), 'pig-bot-model-test-'))
  try {
    const { exitCode, stdout, stderr } = await runSelf(import.meta.path, ['--fixture'], {
      env: { PIG_DIR: tempPigDir }
    })
    assert.equal(exitCode, 0, stderr || stdout)
  } finally {
    rmSync(tempPigDir, { recursive: true, force: true })
  }
})
