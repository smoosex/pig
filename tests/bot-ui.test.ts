/**
 * Simulated DOM & store tests for Phase 5 Bot UI:
 * - Cold-start lastSurface restoration & radial reveal reduced-motion fallback
 * - Anti-stacking BotPeekBubble (2-line clamp, +N unread coalescing, approval pinning, data-bot-overlay)
 * - BotLiveTaskBar priority ordering (blocked_approval > starting > running) and 3-slot overflow folding
 * - BotManagedBanner visibility for active Bot-managed sessions
 * - Reset context clears timeline while preserving background task ledger
 */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { runSelf } from './helpers/subprocess.ts'
import type { BotSnapshot, BotTask } from '../src/shared/bot'

function makeTask(overrides: Partial<BotTask> & { taskId: string; status: BotTask['status'] }): BotTask {
  return {
    title: `Task ${overrides.taskId}`,
    summary: `Summary ${overrides.taskId}`,
    intent: 'test intent',
    projectCwd: '/repo/pig',
    mode: 'write',
    workspace: { kind: 'worktree', cwd: `/wt/${overrides.taskId}`, branch: `bot/fix-${overrides.taskId}` },
    activeRunId: overrides.status === 'running' || overrides.status === 'starting' || overrides.status === 'blocked_approval' ? `run-${overrides.taskId}` : undefined,
    runs: [{
      runId: `run-${overrides.taskId}`,
      taskId: overrides.taskId,
      sessionId: overrides.status === 'starting' ? undefined : `session-${overrides.taskId}`,
      cwd: `/wt/${overrides.taskId}`,
      status: overrides.status === 'completed' ? 'completed' : 'running',
      startedAt: 1_000
    }],
    delivery: { state: 'pending' },
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides
  }
}

async function fixture() {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

  let surfacePersisted: string | null = null
  const preferencePatches: Array<import('../src/shared/bot').BotPreferencesPatch> = []
  let failPreferenceSave: Error | null = null
  let deferPreferenceSave = false
  let resolvePreferenceSave: (() => void) | undefined
  const setModelCalls: Array<{ provider: string; id: string }> = []
  const setThinkingCalls: string[] = []
  const sends: Array<{ text: string; projectMentions?: string[] }> = []
  let abortTurnCalls = 0
  let exportCalls = 0
  let deferExport = false
  let resolveExport: (() => void) | undefined
  let push: ((event: import('../src/shared/bot').BotEvent) => void) | undefined
  let rejectSend: ((error: Error) => void) | undefined
  let deferSend = false
  const claudeModel = {
    provider: 'anthropic',
    id: 'claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    providerName: 'Anthropic',
    contextWindow: 200_000,
    reasoning: true,
    thinkingLevels: ['off', 'low', 'medium', 'high'] as const
  }
  const geminiModel = {
    provider: 'google',
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    providerName: 'Google',
    contextWindow: 1_000_000,
    reasoning: true,
    thinkingLevels: ['off', 'low', 'medium', 'high'] as const
  }
  const mockBotApi = {
    getSnapshot: async (): Promise<BotSnapshot> => {
      push?.({ cursor: 2, type: 'timeline_item', item: { id: 'live-init', kind: 'user', text: 'live', createdAt: 2000 } })
      return {
      eventCursor: 1,
      state: {
        version: 1,
        sessionId: 'bot-session-1',
        cwd: '/pig/bot/workspace',
        lastSurface: 'bot',
        archivedSessions: [],
        createdAt: 1000,
        updatedAt: 1000
      },
      timeline: [],
      tasks: [],
      streaming: false,
      unreadCount: 0,
      approvals: [],
      controls: null,
      permissionMode: 'full-access'
      }
    },
    setSurface: async (surface: 'workspace' | 'bot') => {
      surfacePersisted = surface
      return {
        version: 1 as const,
        sessionId: 'bot-session-1',
        cwd: '/pig/bot/workspace',
        lastSurface: surface,
        archivedSessions: [],
        createdAt: 1000,
        updatedAt: 2000
      }
    },
    updatePreferences: async (patch: import('../src/shared/bot').BotPreferencesPatch) => {
      preferencePatches.push(patch)
      if (deferPreferenceSave) {
        await new Promise<void>((resolve) => { resolvePreferenceSave = resolve })
      }
      if (failPreferenceSave) {
        const err = failPreferenceSave
        failPreferenceSave = null
        throw err
      }
      const prev = useBotStore.getState().state ?? {
        version: 1 as const,
        sessionId: 'bot-session-1',
        cwd: '/pig/bot/workspace',
        lastSurface: 'bot' as const,
        archivedSessions: [],
        createdAt: 1000,
        updatedAt: 1000
      }
      const next = {
        ...prev,
        ...(patch.avatar !== undefined ? { avatar: patch.avatar } : {}),
        updatedAt: Date.now()
      }
      if (patch.delegateModel === null) {
        delete next.delegateModel
        delete next.delegateThinkingLevel
      } else if (patch.delegateModel !== undefined) {
        next.delegateModel = patch.delegateModel
      }
      if (patch.delegateThinkingLevel === null) delete next.delegateThinkingLevel
      else if (patch.delegateThinkingLevel !== undefined) next.delegateThinkingLevel = patch.delegateThinkingLevel
      return next
    },
    sendMessage: async (input: { text: string; projectMentions?: string[] }) => {
      sends.push(input)
      if (deferSend) await new Promise<void>((_resolve, reject) => { rejectSend = reject })
      return { id: `u-${Date.now()}`, kind: 'user' as const, text: input.text, createdAt: Date.now() }
    },
    retryLastMessage: async () => null,
    abortCurrentTurn: async () => { abortTurnCalls++ },
    setPermissionMode: async (mode: 'read-only' | 'default' | 'full-access') => mode,
    setModel: async (provider: string, id: string) => {
      setModelCalls.push({ provider, id })
      const picked = id === geminiModel.id ? geminiModel : claudeModel
      return {
        model: { ...picked, thinkingLevels: [...picked.thinkingLevels] },
        thinkingLevel: 'medium' as const,
        modelThinkingLevel: null,
        thinkingLevels: [...picked.thinkingLevels],
        contextUsage: null,
        steeringMessages: [],
        followUpMessages: []
      }
    },
    setThinking: async (level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max') => {
      setThinkingCalls.push(level)
      const current = useBotStore.getState().controls
      return current ? { ...current, thinkingLevel: level } : null
    },
    exportSession: async () => {
      exportCalls += 1
      if (deferExport) {
        await new Promise<void>((resolve) => { resolveExport = resolve })
      }
      return { path: '/tmp/bot-session.html' }
    },
    resetContext: async (): Promise<BotSnapshot> => ({
      state: {
        version: 1,
        sessionId: 'bot-session-2',
        cwd: '/pig/bot/workspace',
        lastSurface: 'bot',
        archivedSessions: [{ sessionId: 'bot-session-1', archivedAt: 3000, reason: 'reset' }],
        createdAt: 1000,
        updatedAt: 3000
      },
      timeline: [],
      tasks: useBotStore.getState().tasks,
      streaming: false,
      unreadCount: 0,
      approvals: [],
      controls: null,
      permissionMode: 'full-access'
    }),
    listTasks: async () => [],
    getTask: async () => null,
    stopTask: async (taskId: string) => makeTask({ taskId, status: 'stopped' }),
    takeOverTask: async (taskId: string) => makeTask({ taskId, status: 'taken_over' }),
    followupTask: async (taskId: string) => ({
      taskId, runId: 'r-2', projectCwd: '/repo/pig', mode: 'write' as const, status: 'starting' as const
    }),
    checkWorktreeCleanup: async () => ({ branch: 'bot/fix-1', dirty: false, unmerged: false, needsForceConfirm: false }),
    cleanupWorktree: async () => ({ cleaned: true, branch: 'bot/fix-1' }),
    getManagedSessionInfo: async () => null,
    onEvent: (listener: NonNullable<typeof push>) => {
      push = listener
      return () => { push = undefined }
    }
  }

  Object.assign(window, {
    api: {
      bot: mockBotApi,
      getScopedModels: async () => ({
        patterns: [],
        selections: [],
        missingProviderPatterns: [],
        models: [],
        warnings: []
      }),
      onScopedModelsChanged: () => () => {}
    }
  })

  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { MotionGlobalConfig } = await import('motion/react')
  MotionGlobalConfig.skipAnimations = true
  const { sortLiveBotTasks, useBotStore } = await import('../src/renderer/src/stores/bot')
  const { BotLiveTaskBar } = await import('../src/renderer/src/components/bot/BotLiveTaskBar')
  const { BotPeekBubble } = await import('../src/renderer/src/components/bot/BotPeekBubble')
  const { BotManagedBanner } = await import('../src/renderer/src/components/bot/BotManagedBanner')

  // 1. Cold-start lastSurface restoration & default full-access permission
  await useBotStore.getState().init()
  assert.deepEqual(useBotStore.getState().timeline.map((item) => item.id), ['live-init'])
  useBotStore.setState({ timeline: [] })
  assert.equal(useBotStore.getState().open, true, 'restores lastSurface=bot on boot')
  assert.equal(useBotStore.getState().permissionMode, 'full-access', 'defaults to full-access')

  // 2. Closing Bot persists workspace surface and allows peek bubbles with anti-stacking
  useBotStore.getState().closeBot()
  assert.equal(useBotStore.getState().open, false)
  assert.equal(surfacePersisted, 'workspace')

  useBotStore.getState().applyEvent({
    type: 'peek',
    message: { id: 'p1', kind: 'message', text: '第一条消息', createdAt: 100 }
  })
  useBotStore.getState().applyEvent({
    type: 'peek',
    message: { id: 'p2', kind: 'message', text: '第二条消息', createdAt: 200 }
  })
  assert.equal(useBotStore.getState().peek?.message.id, 'p2')
  assert.equal(useBotStore.getState().peek?.extraCount, 1, 'coalesces rapid peeks without stacking')

  // Render BotPeekBubble and verify data-bot-overlay + line-clamp-2
  const peekHost = document.createElement('div')
  document.body.append(peekHost)
  const peekRoot = createRoot(peekHost)
  await act(async () => { peekRoot.render(h(BotPeekBubble)) })
  const bubble = document.body.querySelector<HTMLElement>('[data-bot-peek-bubble]')
  assert.ok(bubble, 'BotPeekBubble portals to body when workspace is active')
  assert.ok(bubble.hasAttribute('data-bot-overlay'), 'BotPeekBubble registers native browser occlusion')
  assert.ok(bubble.innerHTML.includes('line-clamp-2'), 'BotPeekBubble enforces 2-line clamp')
  assert.ok(bubble.textContent?.includes('第二条消息'))

  // Approval peek stays until approvals_changed removes its requestId
  await act(async () => {
    useBotStore.getState().applyEvent({
      type: 'peek',
      message: { id: 'pa', kind: 'approval', requestId: 'req-9', text: 'Approve rm?', createdAt: 300 }
    })
  })
  assert.equal(useBotStore.getState().peek?.message.kind, 'approval')
  await act(async () => {
    useBotStore.getState().applyEvent({ type: 'approvals_changed', approvals: [] })
  })
  assert.equal(useBotStore.getState().peek, null, 'resolved approval clears pinned approval peek')
  await act(async () => { peekRoot.unmount() })

  // 3. Priority sorting and 3-slot overflow folding in BotLiveTaskBar
  const tasks: BotTask[] = [
    makeTask({ taskId: 'done', status: 'completed', updatedAt: 9000 }),
    makeTask({ taskId: 'run-old', status: 'running', updatedAt: 1000 }),
    makeTask({ taskId: 'run-new', status: 'running', updatedAt: 5000 }),
    makeTask({ taskId: 'start-1', status: 'starting', updatedAt: 2000 }),
    makeTask({ taskId: 'appr-1', status: 'blocked_approval', updatedAt: 500 })
  ]
  const sorted = sortLiveBotTasks(tasks)
  assert.deepEqual(
    sorted.map((item) => item.taskId),
    ['appr-1', 'start-1', 'run-new', 'run-old'],
    'orders blocked_approval > starting > running (newest first) and excludes terminal tasks'
  )

  useBotStore.setState({ tasks })
  const barHost = document.createElement('div')
  document.body.append(barHost)
  const barRoot = createRoot(barHost)
  await act(async () => { barRoot.render(h(BotLiveTaskBar, { onOpenSession: () => {} })) })
  const capsules = barHost.querySelectorAll('[data-live-task-capsule]')
  const overflow = barHost.querySelector('[data-live-task-overflow]')
  assert.equal(capsules.length, 2, 'renders 2 capsules when >3 active tasks exist')
  assert.ok(overflow, 'renders +M overflow capsule in the 3rd slot')
  assert.ok(overflow.textContent?.includes('2'), 'overflow capsule counts remaining 2 tasks')

  // 4. BotManagedBanner shows for active managed session and hides for unrelated session
  const bannerHost = document.createElement('div')
  document.body.append(bannerHost)
  const bannerRoot = createRoot(bannerHost)
  await act(async () => { bannerRoot.render(h(BotManagedBanner, { sessionId: 'session-run-new' })) })
  assert.ok(bannerHost.querySelector('[data-bot-managed-banner="run-new"]'), 'shows managed banner for Bot-managed session')
  await act(async () => { bannerRoot.render(h(BotManagedBanner, { sessionId: 'unrelated-session' })) })
  assert.equal(bannerHost.querySelector('[data-bot-managed-banner]'), null, 'hides banner for normal session')

  // 5. Reset context clears timeline while keeping running background tasks intact
  await act(async () => {
    useBotStore.setState({
      timeline: [{ id: 'u1', kind: 'user', text: 'hello', createdAt: 100 }]
    })
    await useBotStore.getState().resetContext()
  })
  assert.equal(useBotStore.getState().timeline.length, 0, 'resetContext clears timeline')
  assert.equal(useBotStore.getState().tasks.length, 5, 'resetContext preserves task ledger')

  // 6. Radial reveal drives both view-transition pseudo-elements symmetrically from 0px to full corner radius
  const { runBotRadialReveal } = await import('../src/renderer/src/lib/radial-reveal')
  const { readFileSync } = await import('node:fs')
  const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
  assert.match(
    css,
    /html\[data-bot-reveal='expand'\]::view-transition-old\(root\),\s*html\[data-bot-reveal='collapse'\]::view-transition-new\(root\)\s*\{\s*mask-image:\s*radial-gradient\(/,
    'applies complementary radial mask to the underlying snapshot so glass mode never double-exposes'
  )

  const root = document.documentElement
  const motions: { frames: PropertyIndexedKeyframes; options: KeyframeAnimationOptions }[] = []
  root.animate = ((frames: PropertyIndexedKeyframes, options: KeyframeAnimationOptions) => {
    motions.push({ frames, options })
    return {} as Animation
  }) as typeof root.animate
  let finishReveal!: () => void
  Object.assign(document, {
    startViewTransition: (update: () => void) => {
      update()
      return {
        ready: Promise.resolve(),
        finished: new Promise<void>((done) => { finishReveal = done }),
        skipTransition: () => finishReveal()
      }
    }
  })

  for (const direction of ['expand', 'collapse'] as const) {
    motions.length = 0
    let applied = false
    runBotRadialReveal(direction, { x: 112, y: 20 }, () => { applied = true })
    assert.equal(applied, true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(root.dataset.botReveal, direction)
    assert.equal(root.style.getPropertyValue('--bot-reveal-x'), '112px')
    assert.equal(root.style.getPropertyValue('--bot-reveal-y'), '20px')
    assert.deepEqual(
      motions.map(({ options }) => options.pseudoElement),
      ['::view-transition-old(root)', '::view-transition-new(root)'],
      'animates both old and new root snapshots so clip-path and complementary mask stay locked in sync'
    )
    for (const { frames } of motions) {
      const [start, end] = (frames['--bot-reveal-radius'] as string[]).map(parseFloat)
      if (direction === 'expand') {
        assert.equal(start, 0)
        assert.ok(end > Math.hypot(window.innerWidth - 112, window.innerHeight - 20))
      } else {
        assert.ok(start > Math.hypot(window.innerWidth - 112, window.innerHeight - 20))
        assert.equal(end, 0)
      }
    }
    finishReveal()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(root.dataset.botReveal, undefined)
  }

  // 7. BotComposer reuses workspace ModelPicker & ThinkingPicker controls without session-only pin
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.assign(globalThis, { ResizeObserver: NoopResizeObserver })
  const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
  const { useModelCatalogStore } = await import('../src/renderer/src/stores/model-catalog')
  const { BotComposer } = await import('../src/renderer/src/components/bot/BotComposer')
  const { useSessionsStore } = await import('../src/renderer/src/stores/sessions')
  useSessionsStore.setState({ projects: [
    { cwd: '/repo/pig', name: 'Pig', sessions: [] },
    { cwd: '/repo/other', name: 'Other', sessions: [] }
  ] })
  useModelCatalogStore.setState({
    models: [
      { ...claudeModel, thinkingLevels: [...claudeModel.thinkingLevels] },
      { ...geminiModel, thinkingLevels: [...geminiModel.thinkingLevels] }
    ],
    revision: 1,
    refreshing: false
  })
  useBotStore.setState({
    controls: {
      model: { ...claudeModel, thinkingLevels: [...claudeModel.thinkingLevels] },
      thinkingLevel: 'medium',
      modelThinkingLevel: null,
      thinkingLevels: [...claudeModel.thinkingLevels],
      contextUsage: null,
      steeringMessages: [],
      followUpMessages: []
    }
  })
  const composerHost = document.createElement('div')
  document.body.append(composerHost)
  const composerRoot = createRoot(composerHost)
  await act(async () => {
    composerRoot.render(h(TooltipProvider, null, h(BotComposer)))
  })
  assert.ok(
    composerHost.querySelector('.\\@container\\/composer-tools'),
    'wraps BotComposer toolbar controls in @container/composer-tools so labels match workspace ComposerToolbar'
  )
  const modelTrigger = composerHost.querySelector<HTMLButtonElement>('button[aria-label="Claude Sonnet 4.5"]')
  assert.ok(modelTrigger, 'renders workspace ModelPicker trigger with active Bot model')
  assert.equal(modelTrigger.dataset.variant, 'ghost')
  await act(async () => { modelTrigger.click() })
  const geminiOption = document.querySelector<HTMLButtonElement>('button[data-model="google::gemini-2.5-pro"]')
  assert.ok(geminiOption, 'opens workspace searchable model popover')
  await act(async () => { geminiOption.click() })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  assert.deepEqual(setModelCalls, [{ provider: 'google', id: 'gemini-2.5-pro' }])

  const thinkingTrigger = composerHost.querySelector<HTMLButtonElement>('button[aria-label="Medium"]')
  assert.ok(thinkingTrigger, 'renders workspace ThinkingPicker trigger with active thinking level')
  await act(async () => { thinkingTrigger.click() })
  assert.equal(
    document.querySelector('button[aria-label="Remember thinking level for this model"]'),
    null,
    'omits session-only remember-thinking pin in BotComposer'
  )
  const highOption = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-hover-highlight-row]'))
    .find((btn) => btn.textContent?.includes('High'))
  assert.ok(highOption, 'lists thinking levels in workspace ThinkingPicker popover')
  await act(async () => { highOption.click() })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  assert.deepEqual(setThinkingCalls, ['high'])

  // Receiving controls_changed(null) clears BotComposer's selected model and resets/disables thinking.
  await act(async () => {
    useBotStore.getState().applyEvent({ type: 'controls_changed', controls: null })
  })
  assert.equal(composerHost.querySelector('button[aria-label="Claude Sonnet 4.5"]'), null, 'clears previous model button when controls become null')
  const clearedModelTrigger = composerHost.querySelector<HTMLButtonElement>('button[aria-label="Model"]')
  assert.ok(clearedModelTrigger, 'renders fallback model label when controls become null')
  const clearedThinkingTrigger = composerHost.querySelector<HTMLButtonElement>('button[aria-label="Off"]')
  assert.ok(clearedThinkingTrigger, 'resets thinking picker to Off when controls become null')
  assert.equal(clearedThinkingTrigger.disabled, true, 'disables thinking picker when controls become null')

  const input = composerHost.querySelector('textarea')!
  const surface = input.closest('[data-slot="input-group"]')
  assert.ok(surface, 'Bot uses the workspace prompt surface')
  assert.ok(surface.classList.contains('solid:bg-composer-input-background'))
  assert.equal(input.dataset.slot, 'input-group-control')
  assert.ok(surface.querySelector('[data-slot="input-group-addon"][data-align="block-end"] button[data-size="icon-xs"]'))
  const press = (key: string, isComposing = false) => input.dispatchEvent(new KeyboardEvent('keydown', {
    key, isComposing, bubbles: true, cancelable: true
  }))
  await act(async () => {
    input.focus()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '看看 @pi 吧')
    input.setSelectionRange(6, 6)
    input.dispatchEvent(new InputEvent('input', { bubbles: true }))
  })
  const options = () => [...document.querySelectorAll('[role="listbox"] [role="option"]')]
  assert.equal(options().length, 1, 'typed @ filters the composer-wide project panel')
  assert.ok(options()[0].textContent?.includes('Pig'))
  await act(async () => { press('Enter', true) })
  assert.equal(options().length, 1)
  await act(async () => { press('Enter') })
  assert.equal(options().length, 0)
  assert.equal(input.value, '看看  吧')
  assert.equal(sends.length, 0, 'accepting a mention does not send')
  const mentionButton = composerHost.querySelector<HTMLButtonElement>('button[aria-expanded="false"][aria-label*="project" i]')!
  assert.ok(mentionButton)
  await act(async () => mentionButton.click())
  assert.equal(options().length, 2, 'toolbar opens the same unfiltered list')
  await act(async () => { press('Escape') })
  assert.equal(options().length, 0)
  await act(async () => { press('Enter') })
  assert.deepEqual(sends.at(-1), { text: '看看  吧', projectMentions: ['/repo/pig'] })

  deferSend = true
  await act(async () => { useBotStore.getState().setDraftInput('first draft') })
  await act(async () => { press('Enter') })
  await act(async () => { useBotStore.getState().setDraftInput('next draft') })
  await act(async () => { rejectSend!(new Error('send failed')) })
  assert.equal(input.value, 'next draft')
  deferSend = false

  // Single-slot send/stop replacement matching workspace ComposerToolbar:
  // streaming + empty draft -> stop button; streaming + non-empty draft -> send button; idle + empty -> disabled send button.
  const trailingButtons = () => surface.querySelectorAll<HTMLButtonElement>('[data-slot="input-group-addon"][data-align="block-end"] button[data-size="icon-xs"]')
  await act(async () => {
    useBotStore.setState({ streaming: false, draftInput: '' })
  })
  assert.equal(trailingButtons().length, 1, 'renders a single trailing action slot when idle')
  assert.equal(trailingButtons()[0].dataset.variant, 'default')
  assert.equal(trailingButtons()[0].disabled, true)

  await act(async () => {
    useBotStore.setState({ streaming: true, draftInput: '' })
  })
  assert.equal(trailingButtons().length, 1, 'replaces send with stop instead of rendering both buttons side by side')
  assert.equal(trailingButtons()[0].dataset.variant, 'secondary')
  assert.equal(trailingButtons()[0].disabled, false)
  await act(async () => { trailingButtons()[0].click() })
  assert.equal(abortTurnCalls, 1, 'clicking stop slot aborts current Bot turn')

  await act(async () => {
    useBotStore.setState({ streaming: true, draftInput: '追问一句' })
  })
  assert.equal(trailingButtons().length, 1, 'keeps a single trailing action slot while typing during streaming')
  assert.equal(trailingButtons()[0].dataset.variant, 'default', 'switches back to send button once draft has text')
  assert.equal(trailingButtons()[0].disabled, false)

  await act(async () => {
    barRoot.unmount()
    bannerRoot.unmount()
    composerRoot.unmount()
  })

  // 8. BotTaskCard distinguishes bot-stopped vs user-stopped, hides cleanup/diff after worktree cleanup & on read-only tasks
  const { BotTaskCard } = await import('../src/renderer/src/components/bot/BotTaskCard')
  const cardHost = document.createElement('div')
  document.body.append(cardHost)
  const cardRoot = createRoot(cardHost)
  const botStoppedTask = makeTask({
    taskId: 'bot-stop-1',
    status: 'stopped',
    workspace: { kind: 'worktree', cwd: '/wt/bot-stop-1', branch: 'bot/clean-1', cleanedUpAt: 5000 },
    runs: [{
      runId: 'r-bs1',
      taskId: 'bot-stop-1',
      sessionId: 'sess-bs1',
      cwd: '/wt/bot-stop-1',
      status: 'stopped',
      stopOrigin: 'bot',
      startedAt: 1000,
      endedAt: 2000
    }]
  })
  const readTaskWithDirtyReceipt = makeTask({
    taskId: 'read-dirty-1',
    status: 'completed',
    mode: 'read',
    workspace: { kind: 'project', cwd: '/repo/pig' },
    latestReceipt: {
      summary: 'read ok',
      changedFiles: [{ path: 'preexisting.md', status: 'added' }],
      totalAdded: 10,
      totalRemoved: 0,
      collectedAt: 3000
    }
  })
  const noopNav = { onOpenSession: () => {}, onViewChanges: () => {} }
  await act(async () => {
    cardRoot.render(
      h('div', null,
        h(BotTaskCard, { task: botStoppedTask, navigation: noopNav }),
        h(BotTaskCard, { task: readTaskWithDirtyReceipt, navigation: noopNav })
      )
    )
  })
  const stoppedCard = cardHost.querySelector('[data-bot-task-card="bot-stop-1"]')!
  assert.ok(stoppedCard.textContent?.includes('Stopped'), 'renders generic Stopped for bot-initiated stop')
  assert.ok(!stoppedCard.textContent?.includes('Stopped by you'), 'does not misattribute bot stop to user')
  assert.ok(!stoppedCard.textContent?.includes('Clean up worktree'), 'hides cleanup button once cleanedUpAt is set')
  assert.ok(!stoppedCard.textContent?.includes('View changes'), 'hides view-changes button once worktree is cleaned up')

  const readCard = cardHost.querySelector('[data-bot-task-card="read-dirty-1"]')!
  assert.ok(!readCard.textContent?.includes('1 files'), 'hides spurious changed-file count on read-only task')
  assert.ok(!readCard.textContent?.includes('View changes'), 'hides view-changes button on read-only task')

  // 9. BotPage deduplicates stacked task cards across multiple timeline bubbles & shows post-approval continuation hint
  const { BotOrbButton } = await import('../src/renderer/src/components/bot/BotOrbButton')
  const { getBotOrbAnchor } = await import('../src/renderer/src/stores/bot')
  const orbHost = document.createElement('div')
  document.body.append(orbHost)
  const orbRoot = createRoot(orbHost)
  await act(async () => {
    useBotStore.setState({ open: false, tasks: [], approvals: [], unreadCount: 0, streaming: false })
    orbRoot.render(h(TooltipProvider, null, h(BotOrbButton, { registerAnchor: true })))
  })
  const orbBtn = orbHost.querySelector<HTMLButtonElement>('[data-bot-orb-button]')
  assert.ok(orbBtn, 'renders BotOrbButton trigger')
  assert.ok(orbBtn.classList.contains('size-7'), 'preserves 28px (size-7) click target')
  assert.equal(orbBtn.getAttribute('aria-expanded'), 'false')
  assert.equal(getBotOrbAnchor(), orbBtn, 'registers BotOrbButton as radial-reveal anchor')
  const orbAvatar = orbBtn.querySelector<HTMLCanvasElement>('[data-bot-avatar="clover"]')
  assert.ok(orbAvatar, 'renders bot-avatars clover canvas inside BotOrbButton')
  assert.equal(orbAvatar.dataset.state, 'default')
  assert.equal(orbAvatar.getAttribute('aria-hidden'), 'true', 'hides decorative canvas from screen readers')
  assert.ok(orbAvatar.classList.contains('pointer-events-none'), 'prevents 1.5x overscan canvas from expanding hit area')
  assert.equal(orbBtn.querySelector('svg'), null, 'no longer renders pixel-pig SVG icon')
  assert.equal(orbBtn.querySelector('[data-bot-orb-badge]'), null, 'omits corner badge when idle')

  await act(async () => {
    useBotStore.setState({ streaming: true, unreadCount: 2 })
  })
  assert.equal(orbBtn.querySelector<HTMLCanvasElement>('[data-bot-avatar="clover"]')?.dataset.state, 'working', 'switches clover avatar to working state while streaming')
  assert.equal(orbBtn.querySelector('[data-bot-orb-badge]')?.getAttribute('data-bot-orb-badge'), 'unread')

  await act(async () => {
    useBotStore.setState({
      streaming: false,
      approvals: [{ requestId: 'req-orb', sessionId: 's-orb', summary: 'Approve?', createdAt: 1000 }]
    })
  })
  assert.equal(orbBtn.querySelector('[data-bot-orb-badge]')?.getAttribute('data-bot-orb-badge'), 'approval', 'approval badge takes priority over unread')
  await act(async () => { orbBtn.click() })
  assert.equal(useBotStore.getState().open, true, 'clicking BotOrbButton toggles Bot open')
  assert.equal(orbBtn.getAttribute('aria-expanded'), 'true')
  await act(async () => {
    useBotStore.setState({ tasks: [], approvals: [], unreadCount: 0, streaming: false })
  })
  assert.equal(orbBtn.innerHTML.includes('ring-bot-orb-ring'), false, 'BotOrbButton does not draw a ring around itself in Bot mode')
  await act(async () => { orbRoot.unmount() })

  const { BotPage, resolveWorkspaceFileTarget } = await import('../src/renderer/src/components/bot/BotPage')
  const jumpCalls: Array<import('../src/renderer/src/components/bot/BotPage').BotWorkspaceJumpOptions> = []
  let copiedClipboard = ''
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        copiedClipboard = value
      }
    }
  })
  useSessionsStore.setState({
    projects: [{
      cwd: '/repo/pig',
      name: 'Pig',
      sessions: [],
      worktrees: [
        { cwd: '/wt/perm-1', branch: 'bot/fix-perm-1', head: 'abc', isPrimary: false, locked: false, missing: false, managed: true, sessions: [] },
        { cwd: '/wt/gone', branch: 'bot/gone', head: 'def', isPrimary: false, locked: false, missing: true, managed: true, sessions: [] }
      ]
    }]
  })
  const runningPermTask = makeTask({ taskId: 'perm-1', status: 'blocked_approval', title: 'Perm check' })
  await act(async () => {
    useBotStore.setState({
      open: true,
      streaming: false,
      tasks: [runningPermTask],
      approvals: [{
        requestId: 'req-perm-1',
        sessionId: 'session-perm-1',
        taskId: 'perm-1',
        taskTitle: 'Perm check',
        projectCwd: '/repo/pig',
        projectName: 'pig',
        summary: 'Allow write?',
        createdAt: 1000
      }],
      timeline: [
        { id: 'u-0', kind: 'user', text: '这个项目做了什么工作', projectMentions: ['/repo/lumina'], createdAt: 500 },
        { id: 'm-1', kind: 'assistant', messageType: 'delivery', content: '卡在审批上', taskIds: ['perm-1'], createdAt: 1000 },
        {
          id: 'm-2',
          kind: 'assistant',
          messageType: 'delivery',
          content: '审批说明 **重点**',
          taskIds: ['perm-1'],
          attachments: [
            { path: '/wt/perm-1/src/export.ts', name: 'export.ts', exists: true, size: 2048 },
            { path: '/tmp/external.md', name: 'external.md', exists: true, size: 512 },
            { path: '/repo/pig/deleted.ts', name: 'deleted.ts', exists: false }
          ],
          createdAt: 2000
        }
      ]
    })
  })
  const pageHost = document.createElement('div')
  document.body.append(pageHost)
  const pageRoot = createRoot(pageHost)
  await act(async () => {
    pageRoot.render(h(TooltipProvider, null, h(BotPage, { onJumpToWorkspace: (opts) => jumpCalls.push(opts) })))
  })
  assert.equal(
    pageHost.querySelectorAll('[data-bot-task-card="perm-1"]').length,
    1,
    'renders only one task card in the timeline under the latest referencing bubble'
  )

  // Header tasks orb button sits immediately to the left of BotOrbButton, uses glass-orb styling, and opens the left-anchored drawer.
  const tasksTrigger = pageHost.querySelector<HTMLButtonElement>('[data-bot-tasks-trigger]')!
  const pageOrbBtn = pageHost.querySelector<HTMLButtonElement>('[data-bot-orb-button]')!
  assert.ok(tasksTrigger && pageOrbBtn, 'renders both tasks trigger and BotOrbButton in BotPage header')
  assert.equal(
    Boolean(tasksTrigger.compareDocumentPosition(pageOrbBtn) & Node.DOCUMENT_POSITION_FOLLOWING),
    true,
    'places tasks trigger button to the left of BotOrbButton'
  )
  assert.equal(tasksTrigger.textContent?.trim(), '', 'renders compact icon-only tasks trigger button')
  assert.ok(tasksTrigger.className.includes('shadow-glass-orb') && tasksTrigger.className.includes('rounded-full'), 'uses glass-orb style matching SurfaceStyleToggle')
  assert.ok(tasksTrigger.getAttribute('aria-label'), 'exposes accessible label for tasks trigger')
  assert.equal(tasksTrigger.querySelector('[data-bot-tasks-badge]')?.getAttribute('data-bot-tasks-badge'), 'approval')
  assert.equal(tasksTrigger.getAttribute('aria-expanded'), 'false')
  await act(async () => { tasksTrigger.click() })
  assert.equal(useBotStore.getState().drawerOpen, true, 'clicking tasks trigger opens task drawer')
  assert.equal(tasksTrigger.getAttribute('aria-expanded'), 'true')
  const taskDrawer = pageHost.querySelector<HTMLElement>('[data-bot-task-drawer]')
  assert.ok(taskDrawer, 'renders task drawer when opened')
  assert.ok(taskDrawer.className.includes('left-2') && !taskDrawer.className.includes('right-2'), 'anchors task drawer on the left side')
  await act(async () => { tasksTrigger.click() })
  assert.equal(useBotStore.getState().drawerOpen, false, 'clicking tasks trigger again closes task drawer')

  // Resolving the mirrored approval while task keeps running shows post-approval continuation hint
  await act(async () => {
    useBotStore.setState({
      tasks: [makeTask({ taskId: 'perm-1', status: 'running', title: 'Perm check' })],
      approvals: []
    })
  })
  const postApprovalHint = pageHost.querySelector('[data-bot-post-approval-hint="perm-1"]')
  assert.ok(postApprovalHint, 'shows post-approval continuation hint while background task resumes')
  assert.ok(postApprovalHint.textContent?.includes('Perm check'))

  // Arriving reply clears the post-approval continuation hint
  await act(async () => {
    useBotStore.getState().applyEvent({
      type: 'timeline_item',
      item: { id: 'm-3', kind: 'assistant', messageType: 'delivery', content: '跑完了', taskIds: ['perm-1'], createdAt: 3000 }
    })
  })
  assert.equal(pageHost.querySelector('[data-bot-post-approval-hint="perm-1"]'), null, 'clears post-approval hint once Bot replies')

  const { botColumn } = await import('../src/renderer/src/chat/layout')
  const scrollerRoot = pageHost.querySelector<HTMLElement>('[data-slot="message-scroller"]')!
  const scrollerViewport = pageHost.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')!
  const scrollerContent = pageHost.querySelector<HTMLElement>('[data-slot="message-scroller-content"]')!
  const liveTaskBar = pageHost.querySelector<HTMLElement>('[data-bot-live-task-bar]')!
  const composerColumn = pageHost.querySelector<HTMLElement>('[data-bot-composer]')?.parentElement
  assert.ok(scrollerRoot && scrollerViewport && scrollerContent && liveTaskBar && composerColumn, 'renders live task bar, message column, and composer column')
  assert.ok(scrollerRoot.classList.contains('py-2'), 'matches workspace vertical scroller breathing room')
  assert.equal(scrollerViewport.classList.contains('px-4'), false, 'keeps horizontal padding off the full-width viewport so border-box max-w matches')
  assert.ok(scrollerViewport.className.includes('[--chat-edge-fade:1rem]'), 'applies workspace edge-fade mask')
  assert.ok(scrollerContent.classList.contains('py-(--chat-edge-fade)'), 'binds top/bottom content inset to --chat-edge-fade')
  assert.ok(composerColumn.classList.contains('pb-3.5'), 'matches workspace composer bottom spacing')
  for (const token of botColumn.split(' ')) {
    assert.ok(liveTaskBar.classList.contains(token), `live task bar includes ${token}`)
    assert.ok(scrollerContent.classList.contains(token), `message scroller content includes ${token}`)
    assert.ok(composerColumn.classList.contains(token), `composer column includes ${token}`)
  }

  // User bubble reuses workspace Bubble glass/solid surface; assistant stacks avatar above full-width reply card and deduplicates grouped headers.
  const userBubble = pageHost.querySelector<HTMLElement>('[data-bot-user-bubble]')!
  assert.ok(userBubble, 'renders workspace-style user bubble')
  assert.equal(userBubble.getAttribute('data-slot'), 'bubble')
  assert.ok(userBubble.classList.contains('*:data-[slot=bubble-content]:bg-glass-popover-background'))
  assert.ok(userBubble.classList.contains('*:data-[slot=bubble-content]:shadow-glass-bubble'))
  assert.ok(userBubble.classList.contains('solid:*:data-[slot=bubble-content]:bg-user-message-background'))
  assert.ok(userBubble.textContent?.includes('@lumina') && userBubble.textContent?.includes('这个项目做了什么工作'))

  const assistantBubbles = pageHost.querySelectorAll<HTMLElement>('[data-bot-assistant-bubble]')
  assert.equal(assistantBubbles.length, 3, 'renders all three consecutive assistant bubbles')
  assert.equal(
    pageHost.querySelectorAll('[data-bot-assistant-header]').length,
    1,
    'renders avatar above only the first assistant message in a consecutive run'
  )
  for (const bubbleEl of assistantBubbles) {
    assert.ok(bubbleEl.classList.contains('w-full'), 'assistant reply stretches full column width beneath avatar')
    assert.ok(bubbleEl.parentElement?.classList.contains('flex-col'), 'stacks avatar above assistant reply instead of left-indenting')
    const bodyEl = bubbleEl.querySelector<HTMLElement>('[data-bot-assistant-body]')!
    assert.ok(bodyEl, 'renders frameless assistant Markdown body')
    assert.equal(bodyEl.className.includes('border-glass-card-border'), false, 'omits heavy outer card border around assistant text')
  }

  // Message hover toolbars expose copy + timestamp on both user and assistant messages.
  const userActions = pageHost.querySelector<HTMLElement>('[data-bot-message-actions="end"]')!
  const assistantActions = pageHost.querySelectorAll<HTMLElement>('[data-bot-message-actions="start"]')
  assert.ok(userActions && assistantActions.length === 3, 'renders message action bars with timestamps for user and assistant rows')
  assert.ok(userActions.querySelector('time'), 'renders formatted timestamp on user message')
  const secondReplyCopyBtn = assistantActions[1].querySelector<HTMLButtonElement>('[data-bot-copy-button]')!
  await act(async () => { secondReplyCopyBtn.click() })
  assert.equal(copiedClipboard, '审批说明 **重点**', 'copies assistant reply Markdown on click')

  // Interactive attachment chips: longest-prefix workspace file jump, external path copy fallback, and missing file state.
  assert.deepEqual(
    resolveWorkspaceFileTarget('/repo/pig/.worktrees/sub/a.ts', ['/repo/pig/.worktrees/sub'], useSessionsStore.getState().projects, []),
    { cwd: '/repo/pig/.worktrees/sub', relativePath: 'a.ts' },
    'prefers longest matching worktree root over parent project root'
  )
  assert.equal(
    resolveWorkspaceFileTarget('/wt/gone/x.ts', [], useSessionsStore.getState().projects, []),
    null,
    'skips missing worktrees when resolving attachment targets'
  )

  const worktreeAttBtn = pageHost.querySelector<HTMLButtonElement>('[data-bot-attachment="/wt/perm-1/src/export.ts"]')!
  const externalAttBtn = pageHost.querySelector<HTMLButtonElement>('[data-bot-attachment="/tmp/external.md"]')!
  const missingAttBtn = pageHost.querySelector<HTMLButtonElement>('[data-bot-attachment="/repo/pig/deleted.ts"]')!
  assert.ok(worktreeAttBtn && externalAttBtn && missingAttBtn, 'renders interactive attachment chips')
  assert.ok(worktreeAttBtn.textContent?.includes('2 KB'), 'formats attachment byte size')
  assert.equal(missingAttBtn.getAttribute('aria-disabled'), 'true', 'marks missing attachment aria-disabled')
  assert.ok(missingAttBtn.innerHTML.includes('line-through'), 'strikes through missing attachment filename')

  await act(async () => { missingAttBtn.click() })
  assert.equal(jumpCalls.length, 0, 'clicking missing attachment does not navigate')

  await act(async () => { externalAttBtn.click() })
  assert.equal(copiedClipboard, '/tmp/external.md', 'clicking attachment outside workspace copies its path')
  assert.equal(jumpCalls.length, 0)

  await act(async () => { worktreeAttBtn.click() })
  assert.equal(useBotStore.getState().open, false, 'clicking workspace attachment closes Bot overlay')
  assert.deepEqual(jumpCalls, [{ cwd: '/wt/perm-1', openFilePath: 'src/export.ts' }], 'jumps to workspace and opens target file tab')

  // Top-right export session button sits to the left of MoreHorizontal, guards against duplicate clicks, and disables when timeline is empty.
  const exportBtn = pageHost.querySelector<HTMLButtonElement>('[data-bot-export-session]')!
  const headerTrailingButtons = pageHost.querySelectorAll<HTMLButtonElement>('[data-bot-header] > .no-drag button')
  assert.equal(headerTrailingButtons.length, 2, 'renders export button and more-actions menu button in top-right header')
  assert.equal(headerTrailingButtons[0], exportBtn, 'places export session button to the left of MoreHorizontal menu')
  assert.equal(exportBtn.disabled, false, 'enables export button when timeline has items')
  deferExport = true
  await act(async () => { exportBtn.click() })
  assert.equal(exportCalls, 1, 'invokes api.bot.exportSession on click')
  assert.equal(exportBtn.disabled, true, 'disables export button while save dialog / export is in progress')
  await act(async () => { exportBtn.click() })
  assert.equal(exportCalls, 1, 'prevents duplicate export invocations while pending')
  deferExport = false
  await act(async () => {
    resolveExport?.()
    resolveExport = undefined
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  assert.equal(exportBtn.disabled, false, 're-enables export button once export finishes')

  await act(async () => {
    useBotStore.setState({ timeline: [] })
  })
  assert.equal(exportBtn.disabled, true, 'disables export button when Bot timeline is empty')

  await act(async () => {
    cardRoot.unmount()
    pageRoot.unmount()
  })

  // 10. BotPane saves avatar & delegateModel (without thinking picker), propagates avatar across header & BotPage, and surfaces errors.
  const { botAvatarTypes } = await import('bot-avatars')
  const { BotPane } = await import('../src/renderer/src/components/settings/BotPane')
  const settingsHost = document.createElement('div')
  document.body.append(settingsHost)
  const settingsRoot = createRoot(settingsHost)
  const syncOrbHost = document.createElement('div')
  document.body.append(syncOrbHost)
  const syncOrbRoot = createRoot(syncOrbHost)
  const syncPageHost = document.createElement('div')
  document.body.append(syncPageHost)
  const syncPageRoot = createRoot(syncPageHost)

  await act(async () => {
    useBotStore.setState({
      loaded: true,
      loading: false,
      error: null,
      open: true,
      streaming: true,
      approvals: [],
      tasks: [],
      timeline: [{ id: 'a-avatar', kind: 'assistant', messageType: 'text', content: 'hi', createdAt: 1000 }],
      state: {
        version: 1,
        sessionId: 'bot-session-1',
        cwd: '/pig/bot/workspace',
        lastSurface: 'bot',
        archivedSessions: [],
        createdAt: 1000,
        updatedAt: 1000
      }
    })
    settingsRoot.render(h(TooltipProvider, null, h(BotPane, { active: true })))
    syncOrbRoot.render(h(TooltipProvider, null, h(BotOrbButton, { registerAnchor: true })))
    syncPageRoot.render(h(TooltipProvider, null, h(BotPage, { onJumpToWorkspace: () => {} })))
  })

  const avatarOptions = settingsHost.querySelectorAll<HTMLButtonElement>('[data-bot-avatar-option]')
  assert.equal(avatarOptions.length, botAvatarTypes.length, 'lists every avatar supported by bot-avatars')
  assert.equal(
    settingsHost.querySelector('[data-bot-avatar-option="clover"]')?.getAttribute('aria-checked'),
    'true',
    'defaults Bot avatar to clover'
  )
  // Standard radiogroup keyboard semantics: single Tab stop, arrow key move+select, focus preserved and duplicate writes prevented during async save.
  const tabbableAvatars = Array.from(avatarOptions).filter((btn) => btn.tabIndex === 0)
  assert.equal(tabbableAvatars.length, 1, 'avatar radiogroup exposes a single Tab stop')
  assert.equal(tabbableAvatars[0].dataset.botAvatarOption, 'clover', 'selected avatar holds tabIndex=0')
  assert.ok(
    Array.from(avatarOptions).filter((btn) => btn.tabIndex === -1).length === avatarOptions.length - 1,
    'non-selected avatars use roving tabIndex=-1'
  )

  const cloverOption = settingsHost.querySelector<HTMLButtonElement>('[data-bot-avatar-option="clover"]')!
  const secondAvatarId = avatarOptions[1].dataset.botAvatarOption!
  const thirdAvatarId = avatarOptions[2].dataset.botAvatarOption!
  deferPreferenceSave = true
  const patchesBeforeArrow = preferencePatches.length
  cloverOption.focus()
  await act(async () => {
    cloverOption.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
  })
  assert.equal(preferencePatches.length, patchesBeforeArrow + 1, 'ArrowRight selects and saves next avatar')
  assert.deepEqual(preferencePatches.at(-1), { avatar: secondAvatarId })
  assert.equal(
    document.activeElement,
    avatarOptions[1],
    'ArrowRight moves focus to the next avatar and keeps focus during async save'
  )
  assert.equal(avatarOptions[1].getAttribute('aria-disabled'), 'true', 'marks options aria-disabled instead of dropping focus')

  // While async save is pending, additional arrow keys or clicks must not trigger duplicate writes or lose focus.
  await act(async () => {
    avatarOptions[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    settingsHost.querySelector<HTMLButtonElement>(`[data-bot-avatar-option="${thirdAvatarId}"]`)!.click()
  })
  assert.equal(preferencePatches.length, patchesBeforeArrow + 1, 'blocks duplicate writes while async avatar save is pending')
  assert.equal(document.activeElement, avatarOptions[1], 'preserves focus on active radio option during async save')

  deferPreferenceSave = false
  await act(async () => {
    resolvePreferenceSave?.()
    resolvePreferenceSave = undefined
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  assert.equal(avatarOptions[1].getAttribute('aria-checked'), 'true', 'updates checked state after async save settles')
  assert.equal(avatarOptions[1].tabIndex, 0, 'moves roving tabIndex=0 to newly selected avatar')
  assert.equal(cloverOption.tabIndex, -1, 'sets previous avatar back to tabIndex=-1')
  assert.equal(document.activeElement, avatarOptions[1], 'keeps focus on the selected avatar after save completes')

  assert.ok(
    settingsHost.textContent?.includes('Use <model> for this task') || settingsHost.textContent?.includes('这次用某某模型执行'),
    'documents per-turn model override hint in Bot settings UI'
  )

  // Switch avatar to 'cat' -> saves and updates header BotOrbButton & BotPage (both paused history and working row).
  const catOption = settingsHost.querySelector<HTMLButtonElement>('[data-bot-avatar-option="cat"]')!
  await act(async () => { catOption.click() })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  assert.deepEqual(preferencePatches.at(-1), { avatar: 'cat' })
  assert.equal(catOption.getAttribute('aria-checked'), 'true')
  assert.ok(syncOrbHost.querySelector('[data-bot-avatar="cat"]'), 'header BotOrbButton follows saved avatar')
  const pageCatAvatars = syncPageHost.querySelectorAll<HTMLCanvasElement>('[data-bot-avatar="cat"]')
  assert.ok(pageCatAvatars.length >= 2, 'BotPage history & working rows follow saved avatar')
  assert.ok(
    Array.from(pageCatAvatars).some((el) => el.dataset.state === 'working'),
    'preserves working animation state on BotPage status row'
  )

  // Open default execution model picker: unlocks default switch, saves model and thinking level, then resets to default.
  const modelPickerBtn = Array.from(settingsHost.querySelectorAll<HTMLButtonElement>('button'))
    .find((btn) => btn.textContent?.includes('Default'))!
  assert.ok(modelPickerBtn, 'renders model picker defaulting to Pig global default')
  await act(async () => { modelPickerBtn.click() })
  const defaultSwitch = document.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Default"]')!
  assert.ok(defaultSwitch, 'exposes Default toggle inside model picker')
  await act(async () => { defaultSwitch.click() })
  const geminiChoice = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-hover-highlight-row]'))
    .find((btn) => btn.textContent?.includes('Gemini 2.5 Pro'))!
  assert.ok(geminiChoice, 'unlocks available models after turning off Default toggle')
  await act(async () => { geminiChoice.click() })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  assert.deepEqual(preferencePatches.at(-1), {
    delegateModel: { provider: 'google', id: 'gemini-2.5-pro' },
    delegateThinkingLevel: null
  })

  // Step thinking level up inside ModelThinkingPicker and verify delegateThinkingLevel persists.
  const thinkingUpBtn = document.querySelector<HTMLButtonElement>('button[aria-label="Raise thinking effort"]')!
  assert.ok(thinkingUpBtn, 'renders thinking-level controls for Bot default execution model')
  await act(async () => { thinkingUpBtn.click() })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  assert.deepEqual(preferencePatches.at(-1), { delegateThinkingLevel: 'off' })

  // Turning Default switch back on clears both delegateModel and delegateThinkingLevel.
  await act(async () => { defaultSwitch.click() })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  assert.deepEqual(preferencePatches.at(-1), { delegateModel: null, delegateThinkingLevel: null })

  // Save failure preserves store error and surfaces alert in BotPane.
  failPreferenceSave = new Error('Disk full while saving Bot state')
  const starOption = settingsHost.querySelector<HTMLButtonElement>('[data-bot-avatar-option="star"]')!
  await act(async () => { starOption.click() })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  assert.ok(useBotStore.getState().error?.includes('Disk full'), 'preserves failure message in store error')
  assert.ok(settingsHost.querySelector('[role="alert"]')?.textContent?.includes('Disk full'), 'displays save error alert in BotPane')

  await act(async () => {
    settingsRoot.unmount()
    syncOrbRoot.unmount()
    syncPageRoot.unmount()
  })
}

async function staleSnapshotFixture() {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })

  let snapshotCalls = 0
  let resolveSecond!: (snapshot: BotSnapshot) => void
  const staleWorkspaceSnapshot = (cursor: number): BotSnapshot => ({
    eventCursor: cursor,
    state: {
      version: 1,
      sessionId: 'bot-session-race',
      cwd: '/pig/bot/workspace',
      lastSurface: 'workspace',
      archivedSessions: [],
      createdAt: 1000,
      updatedAt: 1000
    },
    timeline: [],
    tasks: [],
    streaming: false,
    unreadCount: 0,
    approvals: [],
    controls: null,
    permissionMode: 'full-access'
  })

  Object.assign(window, {
    api: {
      bot: {
        getSnapshot: async () => {
          snapshotCalls += 1
          if (snapshotCalls === 1) throw new Error('Initial snapshot failed')
          return new Promise<BotSnapshot>((resolve) => { resolveSecond = resolve })
        },
        setSurface: async (surface: 'workspace' | 'bot') => ({
          version: 1 as const,
          sessionId: 'bot-session-race',
          cwd: '/pig/bot/workspace',
          lastSurface: surface,
          archivedSessions: [],
          createdAt: 1000,
          updatedAt: 2000
        }),
        onEvent: () => () => {}
      }
    }
  })

  const { useBotStore } = await import('../src/renderer/src/stores/bot')

  // 1. Initial boot snapshot fails; store stays unloaded & closed.
  await useBotStore.getState().init()
  assert.equal(useBotStore.getState().loaded, false)
  assert.equal(useBotStore.getState().open, false)
  assert.ok(useBotStore.getState().error)

  // 2. User manually opens Bot, triggering a retry init() whose stale snapshot still says lastSurface='workspace'.
  useBotStore.getState().openBot()
  assert.equal(useBotStore.getState().open, true)
  assert.equal(snapshotCalls, 2)

  resolveSecond(staleWorkspaceSnapshot(1))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(useBotStore.getState().loaded, true)
  assert.equal(useBotStore.getState().open, true, 'stale workspace snapshot must not close Bot after user opened it')
}

async function botPaneLoadRetryFixture() {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

  let snapshotCalls = 0
  const savedSnapshot: BotSnapshot = {
    eventCursor: 3,
    state: {
      version: 1,
      sessionId: 'bot-session-saved',
      cwd: '/pig/bot/workspace',
      lastSurface: 'bot',
      avatar: 'cat',
      delegateModel: { provider: 'google', id: 'gemini-2.5-pro' },
      delegateThinkingLevel: 'high',
      archivedSessions: [],
      createdAt: 1000,
      updatedAt: 2000
    },
    timeline: [],
    tasks: [],
    streaming: false,
    unreadCount: 0,
    approvals: [],
    controls: null,
    permissionMode: 'full-access'
  }

  Object.assign(window, {
    api: {
      bot: {
        getSnapshot: async () => {
          snapshotCalls += 1
          if (snapshotCalls === 1) throw new Error('Snapshot store unavailable')
          return savedSnapshot
        },
        onEvent: () => () => {}
      },
      getScopedModels: async () => ({
        patterns: [],
        selections: [],
        missingProviderPatterns: [],
        models: [],
        warnings: []
      }),
      onScopedModelsChanged: () => () => {}
    }
  })

  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
  const { useBotStore } = await import('../src/renderer/src/stores/bot')
  const { useModelCatalogStore } = await import('../src/renderer/src/stores/model-catalog')
  const { BotPane } = await import('../src/renderer/src/components/settings/BotPane')

  useModelCatalogStore.setState({
    models: [{
      provider: 'google',
      id: 'gemini-2.5-pro',
      name: 'Gemini 2.5 Pro',
      providerName: 'Google',
      contextWindow: 1_000_000,
      reasoning: true,
      thinkingLevels: ['off', 'low', 'medium', 'high']
    }]
  })

  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)

  await act(async () => {
    root.render(h(TooltipProvider, null, h(BotPane, { active: true })))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

  // 1. Initial load failure surfaces alert + visible retry action, hides default editable controls, and does not auto-retry loop.
  assert.equal(snapshotCalls, 1, 'initial BotPane load does not enter an automatic retry loop on failure')
  assert.equal(useBotStore.getState().loaded, false)
  assert.ok(host.querySelector('[role="alert"]')?.textContent?.includes('Snapshot store unavailable'))
  assert.equal(host.querySelectorAll('[data-bot-avatar-option]').length, 0, 'does not render default avatar options before load succeeds')
  assert.equal(host.querySelector('[role="radiogroup"]'), null, 'hides avatar editor while snapshot is unloaded')

  const retryBtn = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
    .find((btn) => btn.textContent?.includes('Retry') || btn.textContent?.includes('重试'))
  assert.ok(retryBtn, 'exposes a visible retry button when initial snapshot fails')

  // 2. Manual retry loads saved settings without restoring lastSurface='bot' to navigate away from Settings.
  await act(async () => { retryBtn.click() })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  assert.equal(snapshotCalls, 2, 'manual retry calls getSnapshot once')
  assert.equal(useBotStore.getState().loaded, true)
  assert.equal(useBotStore.getState().open, false, 'retrying from BotPane must not restore lastSurface=bot and navigate away')
  assert.equal(host.querySelector('[role="alert"]'), null, 'clears load error alert after retry succeeds')
  assert.equal(
    host.querySelector('[data-bot-avatar-option="cat"]')?.getAttribute('aria-checked'),
    'true',
    'renders saved avatar after retry succeeds'
  )
  assert.ok(host.textContent?.includes('Gemini 2.5 Pro'), 'renders saved delegateModel after retry succeeds')
  assert.ok(
    host.textContent?.includes('High') || host.textContent?.includes('高'),
    'renders saved delegateThinkingLevel after retry succeeds'
  )

  await act(async () => { root.unmount() })
}

if (process.argv[2] === '--bot-ui-fixture') {
  await fixture()
} else if (process.argv[2] === '--bot-stale-snapshot-fixture') {
  await staleSnapshotFixture()
} else if (process.argv[2] === '--bot-pane-load-retry-fixture') {
  await botPaneLoadRetryFixture()
} else {
  test('Bot UI store, live task bar, peek bubble, managed banner, and reset context preserve invariants', async () => {
    const { exitCode, stdout, stderr } = await runSelf(
      import.meta.path,
      ['--bot-ui-fixture'],
      { cwd: new URL('..', import.meta.url).pathname, timeoutMs: 15_000 }
    )
    assert.equal(exitCode, 0, stderr || stdout)
  })

  test('manual openBot after initial snapshot failure is not reverted by stale workspace snapshot', async () => {
    const { exitCode, stdout, stderr } = await runSelf(
      import.meta.path,
      ['--bot-stale-snapshot-fixture'],
      { cwd: new URL('..', import.meta.url).pathname, timeoutMs: 15_000 }
    )
    assert.equal(exitCode, 0, stderr || stdout)
  })

  test('BotPane hides defaults on initial load failure, retries without restoring surface, and shows saved settings', async () => {
    const { exitCode, stdout, stderr } = await runSelf(
      import.meta.path,
      ['--bot-pane-load-retry-fixture'],
      { cwd: new URL('..', import.meta.url).pathname, timeoutMs: 15_000 }
    )
    assert.equal(exitCode, 0, stderr || stdout)
  })
}
