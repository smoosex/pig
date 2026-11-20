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
  const setModelCalls: Array<{ provider: string; id: string }> = []
  const setThinkingCalls: string[] = []
  const sends: Array<{ text: string; projectMentions?: string[] }> = []
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
    sendMessage: async (input: { text: string; projectMentions?: string[] }) => {
      sends.push(input)
      if (deferSend) await new Promise<void>((_resolve, reject) => { rejectSend = reject })
      return { id: `u-${Date.now()}`, kind: 'user' as const, text: input.text, createdAt: Date.now() }
    },
    retryLastMessage: async () => null,
    abortCurrentTurn: async () => {},
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
  const { BotPage } = await import('../src/renderer/src/components/bot/BotPage')
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
        { id: 'm-1', kind: 'assistant', messageType: 'delivery', content: '卡在审批上', taskIds: ['perm-1'], createdAt: 1000 },
        { id: 'm-2', kind: 'assistant', messageType: 'delivery', content: '审批说明补充', taskIds: ['perm-1'], createdAt: 2000 }
      ]
    })
  })
  const pageHost = document.createElement('div')
  document.body.append(pageHost)
  const pageRoot = createRoot(pageHost)
  await act(async () => {
    pageRoot.render(h(TooltipProvider, null, h(BotPage, { onJumpToWorkspace: () => {} })))
  })
  assert.equal(
    pageHost.querySelectorAll('[data-bot-task-card="perm-1"]').length,
    1,
    'renders only one task card in the timeline under the latest referencing bubble'
  )

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

  await act(async () => {
    cardRoot.unmount()
    pageRoot.unmount()
  })
}

if (process.argv[2] === '--bot-ui-fixture') {
  await fixture()
} else {
  test('Bot UI store, live task bar, peek bubble, managed banner, and reset context preserve invariants', async () => {
    const { exitCode, stdout, stderr } = await runSelf(
      import.meta.path,
      ['--bot-ui-fixture'],
      { cwd: new URL('..', import.meta.url).pathname, timeoutMs: 15_000 }
    )
    assert.equal(exitCode, 0, stderr || stdout)
  })
}
