/**
 * Regression tests for Bot single-source notifications, unfocused OS desktop notifications,
 * and ownership transfer upon manual takeover:
 * - Bot replies & task deliveries send OS desktop notifications when Pig is unfocused or covered by Settings,
 *   and suppress OS notifications when Pig is focused in Bot or Workspace (where BotPeekBubble shows).
 * - Clicking a Bot OS notification routes `notification:click` with Bot's sessionId.
 * - While a delegated session is Bot-managed, `managedOverlays` suppresses its own completion notification
 *   and `approvalDelegation` routes approvals to Bot with a human-readable `<project> · <task>` sourceTitle.
 * - Manual takeover (`takeOverTask` while running or `handleUserPromptInSession` when idle) clears
 *   `managedOverlays` and `approvalDelegation` without firing a handover OS notification, restoring
 *   ordinary workspace session notifications and approval ownership.
 */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrowserWindow } from 'electron'
import type { BotEvent, BotTimelineItem } from '../src/shared/bot'
import { runSelf } from './helpers/subprocess.ts'

async function fixture() {
  assert.ok(process.env.PIG_DIR, 'fixture subprocess must receive an isolated PIG_DIR')
  const projectCwd = join(process.env.PIG_DIR!, 'repo')
  mkdirSync(projectCwd, { recursive: true })

  class FakeNotification extends EventEmitter {
    static instances: FakeNotification[] = []
    static isSupported() { return true }
    shown = false
    constructor(readonly options: { title: string; body: string }) {
      super()
      FakeNotification.instances.push(this)
    }
    show() { this.shown = true }
    close() {}
  }

  let focused = false
  const clicks: string[] = []
  const fakeWin = Object.assign(new EventEmitter(), {
    isFocused: () => focused,
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: () => {},
    show: () => {},
    focus: () => {},
    webContents: Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => {
        if (channel === 'notification:click' && typeof payload === 'string') {
          clicks.push(payload)
        }
      }
    })
  }) as unknown as BrowserWindow

  mock.module('electron', () => ({
    app: { getPath: () => process.env.PIG_DIR!, isPackaged: false, getAppPath: () => process.cwd() },
    BrowserWindow: {
      getAllWindows: () => [fakeWin],
      getFocusedWindow: () => (focused ? fakeWin : null)
    },
    Notification: FakeNotification,
    ipcMain: { handle: () => {}, removeHandler: () => {} },
    dialog: {},
    nativeTheme: { shouldUseDarkColors: false },
    utilityProcess: {}
  }))

  let seq = 0
  const liveSessions = new Map<string, {
    sessionId: string
    cwd: string
    agentSession: {
      sessionId: string
      sessionName?: string
      isIdle: boolean
      isBashRunning: boolean
      model: { provider: string; id: string }
      setThinkingLevel: () => void
      abort: () => Promise<void>
      subscribe: (fn: (event: unknown) => void) => () => void
      sessionManager: { getEntries: () => unknown[] }
      emit: (event: unknown) => void
    }
  }>()
  const restoredOverlays: string[] = []

  const realWorktrees = await import('../src/main/worktrees')
  mock.module(fileURLToPath(new URL('../src/main/worktrees.ts', import.meta.url)), () => ({
    ...realWorktrees,
    isGitProject: async () => true,
    normalizeWorktreePath: (p: string) => p
  }))

  const realProjectWorktrees = await import('../src/main/project-worktrees')
  mock.module(fileURLToPath(new URL('../src/main/project-worktrees.ts', import.meta.url)), () => ({
    ...realProjectWorktrees,
    worktrees: {
      create: async (_proj: string, opts: { owner?: { kind: 'bot'; taskId: string } }) => ({
        cwd: join(process.env.PIG_DIR!, 'wt', `bot-${opts.owner?.taskId.slice(0, 6) ?? 'x'}`),
        branch: `bot/fix-${opts.owner?.taskId.slice(0, 6) ?? 'x'}`,
        isPrimary: false,
        locked: false,
        missing: false,
        managed: true,
        owner: opts.owner
      }),
      verifyBotWorktree: async (_proj: string, cwd: string, taskId: string) => ({
        cwd,
        branch: `bot/fix-${taskId.slice(0, 6)}`,
        isPrimary: false,
        locked: false,
        missing: false,
        managed: true,
        owner: { kind: 'bot' as const, taskId }
      }),
      remove: async () => {},
      deletionInfo: async (_proj: string, cwd: string) => ({
        worktree: { cwd, isPrimary: false, locked: false, missing: false, managed: true },
        dirty: false,
        unmerged: false
      }),
      assertAvailable: () => {}
    }
  }))

  const { managedOverlays } = await import('../src/main/pi/managed-overlay-state')
  const realRegistry = await import('../src/main/pi/session-registry')

  mock.module(fileURLToPath(new URL('../src/main/pi/session-registry.ts', import.meta.url)), () => ({
    ...realRegistry,
    createPendingSession: (cwd: string) => {
      seq += 1
      const sessionId = `delegated-session-${seq}`
      const listeners = new Set<(event: unknown) => void>()
      const entries: unknown[] = []
      const agentSession = {
        sessionId,
        sessionName: undefined as string | undefined,
        isIdle: true,
        isBashRunning: false,
        model: { provider: 'anthropic', id: 'alpha' },
        setThinkingLevel: () => {},
        abort: async () => {
          agentSession.isIdle = true
          agentSession.emit({ type: 'agent_settled', aborted: true })
        },
        subscribe: (fn: (event: unknown) => void) => {
          listeners.add(fn)
          return () => { listeners.delete(fn) }
        },
        sessionManager: { getEntries: () => entries },
        emit: (event: unknown) => {
          const ev = event as { type?: string; message?: unknown }
          if (ev?.type === 'message_end' && ev.message) {
            entries.push({ type: 'message', message: ev.message })
          }
          for (const fn of [...listeners]) fn(event)
        }
      }
      liveSessions.set(sessionId, { sessionId, cwd, agentSession })
      return { sessionId, cwd }
    },
    getLive: (id: string) => liveSessions.get(id),
    prepareSession: async (id: string) => liveSessions.get(id)!,
    renameSession: async (id: string, title: string) => {
      const live = liveSessions.get(id)
      if (live) live.agentSession.sessionName = title
    },
    restoreManagedOverlay: async (id: string) => {
      restoredOverlays.push(id)
      managedOverlays.delete(id)
    },
    setSessionModel: async () => {},
    closeSessionsForCwd: async () => {}
  }))

  mock.module(fileURLToPath(new URL('../src/main/pi/session-prompt.ts', import.meta.url)), () => ({
    promptSession: async (sessionId: string, _input: unknown, opts?: { beforeSubmit?: () => void }) => {
      opts?.beforeSubmit?.()
      const live = liveSessions.get(sessionId)
      if (live) {
        live.agentSession.isIdle = false
        live.agentSession.emit({ type: 'agent_start' })
      }
    }
  }))

  mock.module(fileURLToPath(new URL('../src/main/pi/session-stop.ts', import.meta.url)), () => ({
    sessionStopCoordinator: { registerParticipant: () => () => {} },
    stopSessionExecution: async (sessionId: string) => {
      const live = liveSessions.get(sessionId)
      if (live) await live.agentSession.abort()
    }
  }))

  const { addOpenedProject } = await import('../src/main/opened-projects')
  await addOpenedProject(projectCwd)
  const { setVisibleNotificationSessions } = await import('../src/main/completion-visibility')
  const { approvalDelegation } = await import('../src/main/permissions/delegation')
  const { BotService } = await import('../src/main/bot/service')
  const { t } = await import('../src/main/i18n')

  const service = new BotService(join(process.env.PIG_DIR!, 'bot'))
  try {
    await service.initialize()
    const snapshot = await service.getSnapshot()
    const botSessionId = snapshot.state.sessionId
    const events: BotEvent[] = []
    service.subscribe((event) => events.push(event))

    const flushNotifications = async (expectedCount: number) => {
      const deadline = performance.now() + 1_500
      while (FakeNotification.instances.length < expectedCount && performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10))
      }
    }

    const appendTimeline = (item: BotTimelineItem) =>
      (service as unknown as { appendTimelineAndBroadcast: (item: BotTimelineItem) => Promise<void> })
        .appendTimelineAndBroadcast(item)

    ;(service as unknown as { sendToBotSession: (req: { text: string }) => Promise<void> }).sendToBotSession = async (req) => {
      if (req.text.includes('task_taken_over')) {
        service.dispatcher.markSideEffect('send_message')
        // Intentionally omit taskIds (`type: 'text'`) to verify takeover-only notice turns still suppress OS notifications.
        await appendTimeline({
          id: `auto-takeover-${Date.now()}`,
          kind: 'assistant',
          messageType: 'text',
          content: '已移交给你继续处理',
          createdAt: Date.now()
        })
      } else if (req.text.includes('task_completed')) {
        service.dispatcher.markSideEffect('send_message')
        await appendTimeline({
          id: `auto-completed-${Date.now()}`,
          kind: 'assistant',
          messageType: 'text',
          content: '缓存排查完了，命中率一切正常！',
          createdAt: Date.now()
        })
      }
    }

    // 1. Focused in Workspace (botSessionId visible via BotPeekBubble): in-app peek emits, NO duplicate OS notification.
    focused = true
    setVisibleNotificationSessions(fakeWin, ['workspace-tab-1', botSessionId])
    await appendTimeline({
      id: 'msg-focused',
      kind: 'assistant',
      messageType: 'text',
      content: '窗口聚焦时只弹顶部气泡，不重复弹系统通知',
      createdAt: Date.now()
    })
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(FakeNotification.instances.length, 0, 'focused window must not double-notify via OS Notification')
    assert.equal(events.some((e) => e.type === 'peek' && e.message.text.includes('窗口聚焦时')), true)

    // 2. Unfocused window: Bot sends OS desktop notification and clicking it routes to botSessionId.
    focused = false
    await appendTimeline({
      id: 'msg-unfocused',
      kind: 'assistant',
      messageType: 'text',
      content: '第一行进度汇报\n第二行测试全绿\n第三行截断',
      createdAt: Date.now()
    })
    await flushNotifications(1)
    assert.equal(FakeNotification.instances.length, 1)
    assert.deepEqual(FakeNotification.instances[0].options, {
      title: t('bot.title'),
      body: '第一行进度汇报\n第二行测试全绿'
    })
    FakeNotification.instances[0].emit('click')
    assert.deepEqual(clicks, [botSessionId])

    // 3. Focused but covered by Settings (visible sessions = []): Bot still sends OS notification.
    focused = true
    setVisibleNotificationSessions(fakeWin, [])
    await appendTimeline({
      id: 'msg-settings',
      kind: 'assistant',
      messageType: 'text',
      content: '设置页遮挡时走系统通知',
      createdAt: Date.now()
    })
    await flushNotifications(2)
    assert.equal(FakeNotification.instances.length, 2)

    // 4. Delegated task ownership & manual takeover while running:
    focused = false
    const ack = await service.taskManager.delegateTask(
      { projectCwd, title: '修复重复通知', intent: 'fix notifications', mode: 'write' },
      'full-access'
    )
    const waitTaskRunning = async (taskId: string) => {
      const deadline = performance.now() + 2_000
      while (performance.now() < deadline) {
        const current = await service.getTask(taskId)
        const sessionId = current?.runs[0]?.sessionId
        if (current?.status === 'running' && sessionId && liveSessions.has(sessionId)) {
          return { task: current, sessionId }
        }
        await new Promise((r) => setTimeout(r, 10))
      }
      throw new Error('Timed out waiting for delegated session launch')
    }
    const { sessionId: runningSessionId } = await waitTaskRunning(ack.taskId)
    assert.equal(managedOverlays.has(runningSessionId), true, 'delegated session has ManagedOverlay while Bot-owned')
    assert.equal(approvalDelegation(runningSessionId)?.controllerId, botSessionId)
    assert.equal(approvalDelegation(runningSessionId)?.sourceTitle, 'repo · 修复重复通知')

    // Take over while running: overlay & approval delegation are cleared, and handover receipt does NOT spam OS notifications.
    const takenOver = await service.takeOverTask(ack.taskId)
    assert.equal(takenOver.status, 'taken_over')
    assert.equal(managedOverlays.has(runningSessionId), false, 'takeover removes ManagedOverlay so session notifies for itself')
    assert.equal(approvalDelegation(runningSessionId), undefined, 'takeover releases Bot approval delegation')
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(FakeNotification.instances.length, 2, 'taken_over handover note does not fire an extra OS notification')

    // 5. Completed Bot task: stays Bot-managed until user manually prompts in that session (idle takeover).
    const ack2 = await service.taskManager.delegateTask(
      { projectCwd, title: '排查缓存', intent: 'check cache', mode: 'read' },
      'full-access'
    )
    const { sessionId: idleSessionId } = await waitTaskRunning(ack2.taskId)

    const live2 = liveSessions.get(idleSessionId)!
    live2.agentSession.isIdle = true
    live2.agentSession.emit({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] }
    })
    live2.agentSession.emit({ type: 'agent_settled', aborted: false })

    // NoticeQueue -> Dispatcher -> Bot send_message delivers ONE OS notification (`Bot · repo`) while unfocused!
    await flushNotifications(3)
    const completedTask = await service.getTask(ack2.taskId)
    assert.equal(completedTask?.status, 'completed')
    assert.equal(managedOverlays.has(idleSessionId), true, 'completed Bot session keeps ManagedOverlay until taken over')
    assert.deepEqual(FakeNotification.instances[2].options, {
      title: `${t('bot.title')} · repo`,
      body: '缓存排查完了，命中率一切正常！'
    })

    // User manually types into the completed session in Workspace -> automatic takeover detaches ManagedOverlay!
    await service.handleUserPromptInSession(idleSessionId)
    const afterPromptTask = await service.getTask(ack2.taskId)
    assert.equal(afterPromptTask?.status, 'taken_over')
    assert.equal(managedOverlays.has(idleSessionId), false, 'typing into an idle Bot session detaches ManagedOverlay before user turn')
    assert.equal(approvalDelegation(idleSessionId), undefined)
  } finally {
    await service.shutdown()
  }
}

if (process.argv[2] === '--bot-notifications-fixture') {
  await fixture()
} else {
  test('Bot single-source notifications, unfocused OS notifications, and manual takeover ownership', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pig-bot-notif-'))
    try {
      const { exitCode, stdout, stderr } = await runSelf(
        import.meta.path,
        ['--bot-notifications-fixture'],
        { env: { PIG_DIR: dir }, timeoutMs: 15_000 }
      )
      assert.equal(exitCode, 0, stderr || stdout)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
