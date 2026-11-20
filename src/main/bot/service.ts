/**
 * Pig Bot host service: owns the single Bot main session (built via createSessionRuntime),
 * persistent task ledger, notice queue, non-blocking dispatcher, approval mirroring,
 * single-timeline reset/archive, and background Managed Overlay session launcher.
 */
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { BrowserWindow } from 'electron'
import { SessionManager, type AgentSession } from '@earendil-works/pi-coding-agent'
import type { SessionControls, ThinkingLevel } from '../../shared/api'
import type { PermissionMode } from '../../shared/permissions'
import type { SessionAgentTask } from '../../shared/session-agent'
import {
  isBotTaskActive,
  type BotEvent,
  type BotImageAttachment,
  type BotManagedSessionInfo,
  type BotMirroredApproval,
  type BotPeekMessage,
  type BotSnapshot,
  type BotState,
  type BotSurface,
  type BotTask,
  type BotTextAttachment,
  type BotTimelineItem
} from '../../shared/bot'
import { pigPath } from '../pig-dir'
import { listOpenedCwds } from '../opened-projects'
import { openProjectDirectory } from '../project-open'
import { isGitProject } from '../worktrees'
import { worktrees as projectWorktrees } from '../project-worktrees'
import { createSessionRuntime } from '../pi/session-runtime'
import { botMainPluginPaths } from '../pi/plugins'
import {
  createPendingSession,
  getLive,
  prepareSession,
  renameSession,
  restoreManagedOverlay,
  setSessionModel,
  setSessionThinking
} from '../pi/session-registry'
import { promptSession } from '../pi/session-prompt'
import { isSessionRunActive } from '../pi/event-bridge'
import { managedOverlays } from '../pi/managed-overlay'
import { SessionTaskTracker } from '../pi/session-agent-tasks'
import { manager as subagents } from '../subagents/service'
import { restrictPermissionMode } from '../permissions/mode'
import { getSessionAgentController } from '../pi/session-agent'
import { sessionStopCoordinator, stopSessionExecution } from '../pi/session-stop'
import { closeSessionProcesses } from '../processes'
import { onPermissionsChanged, saveSessionPermission, sessionPermission } from '../permissions/store'
import { delegateApprovals } from '../permissions/delegation'
import { createExtensionUI, listPendingApprovals, onApprovalLifecycle } from '../extension-ui'
import { startModelRuntime, toModelInfo, thinkingLevelsFor, modelThinkingFromSettings, defaultThinkingFromSettings, defaultModelFromSettings, clampThinking } from '../pi/model-settings'
import { registerBotShutdown } from './lifecycle'
import { BotStore } from './store'
import { BotNoticeQueue } from './notice-queue'
import { BotTaskManager, type BotBackendLaunchParams, type BotBackendLaunchResult } from './task-manager'
import { BotDispatcher, type BotPromptRequest } from './dispatcher'
import { createBotExtension } from './tools'
import { projectTimelineItemToPeek } from './projection'

export class BotService {
  readonly store: BotStore
  readonly noticeQueue: BotNoticeQueue
  readonly taskManager: BotTaskManager
  readonly dispatcher: BotDispatcher

  private agentSession: AgentSession | null = null
  private sessionUnsub: (() => void) | null = null
  private sessionInitPromise: Promise<AgentSession> | null = null
  private initialization: Promise<void> | null = null
  private sessionWindow: BrowserWindow | null = null
  private currentSurface: BotSurface = 'workspace'
  private unreadCount = 0
  private listeners = new Set<(event: BotEvent) => void>()
  private cleanups: Array<() => void> = []
  private approvalRoutes = new Map<string, () => void>()
  private restoringOverlays = new Map<string, Promise<void>>()
  private readonly fallbackTasks = new SessionTaskTracker({
    current: id => getLive(id)?.agentSession,
    children: id => subagents.snapshot(id),
    pendingChildren: id => subagents.hasPendingWork(id),
    busy: id => {
      const agent = getLive(id)?.agentSession
      return !!agent && (isSessionRunActive(agent) || !agent.isIdle || agent.isBashRunning)
    }
  })
  private backendTracker = this.fallbackTasks
  private launchingSessions = new Set<string>()
  private lastUserMessage: { text: string; images?: BotImageAttachment[]; textAttachments?: BotTextAttachment[]; projectMentions?: string[] } | null = null

  constructor(private readonly botDir = pigPath('bot')) {
    this.store = new BotStore(this.botDir)
    this.noticeQueue = new BotNoticeQueue(this.store.noticesFilePath)
    this.taskManager = new BotTaskManager({
      store: this.store,
      noticeQueue: this.noticeQueue,
      listOpenedProjects: listOpenedCwds,
      createWorktree: (projectCwd, options) => projectWorktrees.create(projectCwd, options),
      verifyBotWorktree: (projectCwd, cwd, taskId) => projectWorktrees.verifyBotWorktree(projectCwd, cwd, taskId),
      removeWorktree: async (projectCwd, cwd, { check, ...bot }) => {
        const { closeSessionsForCwd } = await import('../pi/session-registry')
        const { removeProjectSessions } = await import('../pi/session-removal')
        const { removeOpenProjectWorkspaces } = await import('../open-project-sessions')
        await projectWorktrees.remove(
          projectCwd,
          cwd,
          () => closeSessionsForCwd(cwd, 'worktree_deleted'),
          () => removeProjectSessions(cwd),
          { bot, check }
        )
        await removeOpenProjectWorkspaces([cwd]).catch(() => {})
      },
      worktreeDeletionInfo: (projectCwd, cwd) => projectWorktrees.deletionInfo(projectCwd, cwd),
      launchBackendSession: (params) => this.launchBackendSession(params),
      stopSession: (sessionId, origin) => stopSessionExecution(sessionId, origin),
      cleanupSessionProcesses: (sessionId) => closeSessionProcesses(sessionId),
      restoreSessionCapabilities: (sessionId) => this.restoreManagedSession(sessionId),
      onTaskUpdated: (task) => {
        this.emit({ type: 'task_updated', task })
      },
      onTasksReplaced: (tasks) => {
        this.emit({ type: 'tasks_replaced', tasks })
      }
    })

    this.dispatcher = new BotDispatcher({
      sendPrompt: (req) => this.sendToBotSession(req),
      abortCurrent: async () => {
        await this.agentSession?.abort()
      },
      appendTimeline: (item) => this.appendTimelineAndBroadcast(item),
      onStreamingChanged: (streaming) => {
        this.emit({ type: 'streaming_changed', streaming })
      },
      onUserIdle: () => {
        this.noticeQueue.notifyUserIdle()
      },
      onDeliveryState: (taskId, runId, state, noticeId, error) =>
        this.taskManager.markDeliveryState(taskId, runId, state, { noticeId, error })
    })

    this.noticeQueue.setDeliverer({
      isUserBusy: () => this.dispatcher.isUserBusy(),
      deliverBatch: (notices) => this.dispatcher.deliverNotices(notices)
    })
  }

  private get workspaceDir(): string {
    return join(this.botDir, 'workspace')
  }

  private get sessionsDir(): string {
    return join(this.botDir, 'sessions')
  }

  subscribe(listener: (event: BotEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private eventCursor = 0

  private emit(event: BotEvent): void {
    event = { ...event, cursor: ++this.eventCursor }
    for (const listener of [...this.listeners]) {
      try { listener(event) } catch (error) { console.error('BotService listener error:', error) }
    }
  }

  initialize(): Promise<void> {
    return this.initialization ??= this.initializeOnce().catch((error) => {
      this.initialization = null
      throw error
    })
  }

  private async initializeOnce(): Promise<void> {
    await mkdir(this.workspaceDir, { recursive: true, mode: 0o700 })
    const state = await this.store.ensureState()
    this.currentSurface = state.lastSurface

    // Ensure Bot main session defaults to full-access on first initialization (only if not yet explicitly set).
    const perm = sessionPermission(state.sessionId)
    if (!perm.overridden) {
      await saveSessionPermission(state.sessionId, 'full-access')
    }

    await this.taskManager.initialize()

    // Hook into unified stop coordinator for live Bot-managed sessions.
    this.cleanups.push(
      sessionStopCoordinator.registerParticipant({
        onBeforeStop: async (sessionId, origin) => {
          await Promise.all([
            this.fallbackTasks.markStopping(sessionId, origin),
            this.taskManager.handleBeforeSessionStop(sessionId, origin)
          ])
        },
        onAfterStop: (sessionId) => this.taskManager.handleAfterSessionStop(sessionId)
      })
    )

    // Hook into approval lifecycle to mirror background task approvals into Bot page and peek bubble.
    this.cleanups.push(
      onApprovalLifecycle((event) => {
        void this.handleApprovalLifecycle(event)
      })
    )

    // Hook into permission changes so Bot page updates its mode selector live.
    this.cleanups.push(
      onPermissionsChanged(() => {
        void this.store.readState().then((st) => {
          if (!st) return
          this.emit({ type: 'permission_changed', mode: sessionPermission(st.sessionId).mode })
        }).catch(() => {})
      })
    )

    this.backendTracker = getSessionAgentController()?.tasks ?? this.fallbackTasks
    this.cleanups.push(this.backendTracker.subscribeFinished(task => this.onManagedTaskFinished(task)))
  }

  private async ensureBotSession(): Promise<AgentSession> {
    await this.initialize()
    if (this.agentSession) return this.agentSession
    if (this.sessionInitPromise) return this.sessionInitPromise

    this.sessionInitPromise = (async () => {
      const state = await this.store.ensureState()
      await mkdir(this.workspaceDir, { recursive: true, mode: 0o700 })
      await mkdir(this.sessionsDir, { recursive: true, mode: 0o700 })
      // Resume the persisted Bot session by exact ID when present, otherwise mint a new one with
      // state.sessionId so SessionManager.getSessionId() matches permissions, memory, and persona.
      const existingFile = SessionManager.findById(this.workspaceDir, state.sessionId, this.sessionsDir)
      const sessionManager = existingFile
        ? SessionManager.open(existingFile, this.sessionsDir, this.workspaceDir)
        : SessionManager.create(this.workspaceDir, this.sessionsDir, { id: state.sessionId })

      const botExtension = createBotExtension({
        taskManager: this.taskManager,
        getPermissionMode: () => sessionPermission(state.sessionId).mode,
        onPermissionsChanged,
        listOpenedProjects: async () => {
          const cwds = await listOpenedCwds()
          return Promise.all(cwds.map(async (cwd) => ({
            cwd,
            name: basename(cwd),
            hasGit: await isGitProject(cwd).catch(() => false)
          })))
        },
        openProject: async (path, check) => {
          const project = await openProjectDirectory(path, check)
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
              win.webContents.send('projects:changed', project.cwd)
            }
          }
          return { cwd: project.cwd, name: project.name }
        },
        inspectTaskSession: (task) => this.inspectTaskSession(task),
        confirmAction: async (title, message, ctx, signal) => {
          const win = this.settingsWindow(state.sessionId, ctx?.sessionManager)
          if (!win || !ctx?.hasUI) return false
          const mode = sessionPermission(state.sessionId).mode
          const invalidated = new AbortController()
          const approvalSignal = AbortSignal.any([invalidated.signal, ...(signal ? [signal] : [])])
          const check = () => {
            approvalSignal.throwIfAborted()
            if (this.settingsWindow(state.sessionId, ctx.sessionManager) !== win ||
                restrictPermissionMode(mode, sessionPermission(state.sessionId).mode) !== mode) {
              throw new Error('Bot session or permission mode changed; request the operation again')
            }
          }
          const unwatch = onPermissionsChanged(() => {
            try { check() } catch (error) { invalidated.abort(error) }
          })
          try {
            check()
            const choice = await ctx.ui.select(title, ['Approve', 'Deny'], {
              signal: approvalSignal,
              approval: { message }
            } as unknown as Parameters<typeof ctx.ui.select>[2])
            check()
            return choice === 'Approve'
          } finally {
            unwatch()
          }
        },
        onSendMessage: async (item) => {
          await this.appendTimelineAndBroadcast(item)
        },
        onSideEffect: (toolName) => {
          this.dispatcher.markSideEffect(toolName)
        }
      })

      const session = await createSessionRuntime(
        this.workspaceDir,
        sessionManager,
        botMainPluginPaths(),
        undefined,
        {
          identity: true,
          extraExtensions: [{ name: 'pig-bot', factory: botExtension }]
        }
      )

      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        const ui = await createExtensionUI(win, state.sessionId, 'extension')
        await session.bindExtensions({ uiContext: ui })
      }
      this.sessionWindow = win ?? null

      // Apply persisted Bot-specific model & thinking preferences when resuming or starting fresh.
      if (state.model) {
        const savedModel = (await startModelRuntime()).getModel(state.model.provider, state.model.id)
        if (savedModel && (session.model?.provider !== savedModel.provider || session.model?.id !== savedModel.id)) {
          await session.setModel(savedModel).catch(() => {})
        }
      }
      if (state.thinkingLevel && session.thinkingLevel !== state.thinkingLevel) {
        const allowed = thinkingLevelsFor(session.model ?? null)
        session.setThinkingLevel(clampThinking(state.thinkingLevel, allowed))
      }

      this.sessionUnsub?.()
      this.sessionUnsub = session.subscribe((event) => {
        if (event.type === 'tool_execution_start') {
          this.dispatcher.markToolActivity(event.toolName)
        }
      })

      this.agentSession = session
      const controls = await this.readBotControls(session)
      if (controls) this.emit({ type: 'controls_changed', controls })
      return session
    })().finally(() => {
      this.sessionInitPromise = null
    })

    return this.sessionInitPromise
  }

  private async sendToBotSession(req: BotPromptRequest): Promise<void> {
    const session = await this.ensureBotSession()
    const images = req.images?.map((img) => ({
      type: 'image' as const,
      data: img.data,
      mimeType: img.mimeType
    }))
    let text = req.text
    if (req.textAttachments?.length) {
      const extra = req.textAttachments.map((att) => `\n\n[Attached text]\n${att.text}`).join('')
      text = `${text}${extra}`
    }
    await session.prompt(text, {
      ...(images?.length ? { images } : {}),
      ...(req.streamingBehavior ? { streamingBehavior: req.streamingBehavior } : {})
    })
  }

  private async appendTimelineAndBroadcast(item: BotTimelineItem): Promise<void> {
    await this.store.appendTimelineItem(item)
    this.emit({ type: 'timeline_item', item })

    if (item.kind === 'assistant' || item.kind === 'system_fallback') {
      if (this.currentSurface !== 'bot') {
        this.unreadCount++
      }
      let meta: { statusBadge?: string; projectName?: string; taskId?: string } | undefined
      const firstTaskId = item.taskIds?.[0]
      if (firstTaskId) {
        const task = await this.taskManager.getTask(firstTaskId)
        if (task) {
          meta = {
            taskId: task.taskId,
            projectName: basename(task.projectCwd),
            statusBadge: task.status
          }
        }
      }
      const peek = projectTimelineItemToPeek(item, meta)
      this.emit({ type: 'peek', message: peek })
    }
  }

  private onManagedTaskFinished(task: SessionAgentTask): void {
    void this.taskManager.handleSessionTaskFinished(task).catch((error) => {
      console.error('Bot task finalization error:', error)
    })
  }

  private async launchBackendSession(params: BotBackendLaunchParams): Promise<BotBackendLaunchResult> {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win || win.isDestroyed()) {
      throw new Error('An open Pig window is required to run background project sessions')
    }
    const state = await this.store.ensureState()
    const pending = createPendingSession(params.cwd, win, { draft: false })
    const sessionId = pending.sessionId
    this.launchingSessions.add(sessionId)
    try {
      return await this.startManagedSession(sessionId, win, state.sessionId, params)
    } catch (error) {
      await this.restoreManagedSession(sessionId)
      throw error
    } finally {
      this.launchingSessions.delete(sessionId)
    }
  }

  private async startManagedSession(sessionId: string, win: BrowserWindow, controllerId: string, params: BotBackendLaunchParams): Promise<BotBackendLaunchResult> {
    // Enforce permission ceiling (never escalate above Bot's current mode; read tasks locked to read-only).
    const mode = restrictPermissionMode(params.permissionMode, sessionPermission(controllerId).mode)
    if (params.task.mode === 'write' && mode === 'read-only') throw new Error('Bot is no longer authorized to launch a write task')
    await saveSessionPermission(sessionId, mode)

    managedOverlays.set(sessionId, { mode: params.task.mode, browser: params.capabilities?.browser })

    const live = await prepareSession(sessionId)
    const attempt = params.task.runs.findIndex((run) => run.runId === params.run.runId) + 1
    const title = attempt > 1 ? `[Bot #${attempt}] ${params.task.title}` : `[Bot] ${params.task.title}`
    await renameSession(sessionId, title).catch(() => {})

    // Model inheritance: default follows Pig's global default model/thinking; allow per-task overrides.
    if (params.modelOverride) {
      await setSessionModel(sessionId, params.modelOverride.provider, params.modelOverride.id)
    }
    if (params.thinkingOverride) {
      await setSessionThinking(sessionId, params.thinkingOverride)
    }

    // Notify renderer project tree so new Bot worktree / session appears immediately.
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('projects:changed', params.task.projectCwd)
    }

    // Set up approval delegation so missing permissions mirror cleanly to Bot page.
    this.approvalRoutes.get(sessionId)?.()
    const releaseApprovalRoute = delegateApprovals(sessionId, {
      controllerId,
      check: () => {
        if (!getLive(sessionId)) throw new Error('Managed session closed')
      },
      allows: () => false
    })
    this.approvalRoutes.set(sessionId, releaseApprovalRoute)

    const tracker = this.backendTracker
    let sessionTaskId: string
    try {
      sessionTaskId = tracker.start(controllerId, sessionId, live.agentSession, () => {
        const release = this.approvalRoutes.get(sessionId)
        this.approvalRoutes.delete(sessionId)
        release?.()
      })
    } catch (error) {
      this.approvalRoutes.delete(sessionId)
      releaseApprovalRoute()
      throw error
    }
    const submission = promptSession(sessionId, { text: params.prompt }, {
      literal: true,
      beforeSubmit: () => {
        tracker.assertSubmissionActive(sessionTaskId)
        if (restrictPermissionMode(mode, sessionPermission(controllerId).mode) !== mode) {
          throw new Error('Bot permissions changed before the managed task started')
        }
      }
    })
    tracker.submitted(sessionTaskId, submission)
    return { sessionId, sessionTaskId }
  }

  private async restoreManagedSession(sessionId: string): Promise<void> {
    const existing = this.restoringOverlays.get(sessionId)
    if (existing) return existing
    if (!managedOverlays.has(sessionId)) return
    const restoring = restoreManagedOverlay(sessionId).finally(() => this.restoringOverlays.delete(sessionId))
    this.restoringOverlays.set(sessionId, restoring)
    await restoring
  }

  private async inspectTaskSession(task: BotTask): Promise<{ recentMessages: Array<{ role: string; text: string }>; diffSummary?: string }> {
    const current = await this.taskManager.getTask(task.taskId)
    const activeRun = current && isBotTaskActive(current.status)
      ? current.runs.find(run => run.runId === current.activeRunId)
      : undefined
    const recentMessages: Array<{ role: string; text: string }> = []
    if (activeRun?.sessionId && managedOverlays.has(activeRun.sessionId)) {
      const live = getLive(activeRun.sessionId)
      if (live) {
        const entries = live.agentSession.sessionManager.getEntries()
          .filter((e): e is Extract<typeof e, { type: 'message' }> => e.type === 'message')
          .slice(-8)
        for (const entry of entries) {
          const msg = entry.message
          const rawContent = 'content' in msg ? msg.content : undefined
          const text = Array.isArray(rawContent)
            ? rawContent.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text).join('\n').slice(0, 1500)
            : typeof rawContent === 'string' ? rawContent.slice(0, 1500) : ''
          if (text) recentMessages.push({ role: msg.role, text })
        }
      }
    }
    return {
      recentMessages,
      diffSummary: current?.latestReceipt
        ? `${current.latestReceipt.changedFiles.length} files (+${current.latestReceipt.totalAdded}/-${current.latestReceipt.totalRemoved})`
        : undefined
    }
  }

  private async handleApprovalLifecycle(event: { type: 'created'; record: ReturnType<typeof listPendingApprovals>[number] } | { type: 'resolved'; id: string; owner: string }): Promise<void> {
    const state = await this.store.readState().catch(() => null)
    if (!state) return

    if (event.type === 'created') {
      const managed = await this.taskManager.getManagedSessionInfo(event.record.owner)
      if (managed) {
        await this.taskManager.markApprovalBlocked(event.record.owner, event.record.id, event.record.title)
      }
      if (managed || event.record.owner === state.sessionId || event.record.controller === state.sessionId) {
        const approvals = await this.listMirroredApprovals()
        this.emit({ type: 'approvals_changed', approvals })
        const peek: BotPeekMessage = {
          id: `approval-${event.record.id}`,
          kind: 'approval',
          text: event.record.message || event.record.title,
          statusBadge: 'blocked_approval',
          projectName: managed ? basename(managed.projectCwd) : undefined,
          taskId: managed?.taskId,
          requestId: event.record.id,
          createdAt: event.record.createdAt
        }
        this.emit({ type: 'peek', message: peek })
      }
    } else {
      const managed = await this.taskManager.getManagedSessionInfo(event.owner)
      if (managed) {
        await this.taskManager.markApprovalResolved(event.owner)
      }
      const approvals = await this.listMirroredApprovals()
      this.emit({ type: 'approvals_changed', approvals })
    }
  }

  async listMirroredApprovals(): Promise<BotMirroredApproval[]> {
    const state = await this.store.readState().catch(() => null)
    if (!state) return []
    const tasks = await this.taskManager.listTasks()
    const activeBySession = new Map<string, BotTask>()
    for (const task of tasks) {
      if (!task.activeRunId) continue
      const run = task.runs.find((r) => r.runId === task.activeRunId)
      if (run?.sessionId) activeBySession.set(run.sessionId, task)
    }

    const pending = listPendingApprovals()
    const mirrored: BotMirroredApproval[] = []
    for (const item of pending) {
      const task = activeBySession.get(item.owner)
      if (task || item.owner === state.sessionId || item.controller === state.sessionId) {
        mirrored.push({
          requestId: item.id,
          sessionId: item.owner,
          taskId: task?.taskId,
          taskTitle: task?.title,
          projectCwd: task?.projectCwd,
          projectName: task ? basename(task.projectCwd) : undefined,
          summary: item.message || item.title,
          kind: item.title,
          createdAt: item.createdAt
        })
      }
    }
    return mirrored
  }

  private async readBotControls(session?: AgentSession | null): Promise<SessionControls | null> {
    try {
      const runtime = await startModelRuntime()
      const current = session ?? this.agentSession
      const state = await this.store.readState().catch(() => null)
      const savedModel = state?.model ? runtime.getModel(state.model.provider, state.model.id) : undefined
      const defaultRef = defaultModelFromSettings()
      const defaultModel = defaultRef ? runtime.getModel(defaultRef.provider, defaultRef.id) : undefined
      const model = current?.model ?? savedModel ?? defaultModel ?? runtime.getAvailable()[0]
      if (!model) return null
      const modelInfo = toModelInfo(model)
      const modelThinkingLevel = modelThinkingFromSettings(model)
      const thinkingLevels = thinkingLevelsFor(model)
      const rawThinking = (current?.thinkingLevel ?? state?.thinkingLevel ?? modelThinkingLevel ?? defaultThinkingFromSettings(model) ?? 'medium') as ThinkingLevel
      const thinkingLevel = clampThinking(rawThinking, thinkingLevels)
      return {
        model: modelInfo,
        thinkingLevel,
        modelThinkingLevel,
        thinkingLevels,
        contextUsage: null,
        steeringMessages: [],
        followUpMessages: []
      }
    } catch {
      return null
    }
  }

  async getSnapshot(): Promise<BotSnapshot> {
    await this.initialize()
    for (;;) {
      const eventCursor = this.eventCursor
      const [state, timeline, tasks, approvals, controls] = await Promise.all([
        this.store.ensureState(),
        this.store.readTimeline(),
        this.taskManager.listTasks(),
        this.listMirroredApprovals(),
        this.readBotControls()
      ])
      // These reads may straddle a push. Never advertise a mixed snapshot as covering that push.
      if (eventCursor !== this.eventCursor) continue
      return {
        eventCursor,
        state,
        timeline,
        tasks,
        streaming: this.dispatcher.isStreaming(),
        unreadCount: this.unreadCount,
        approvals,
        controls,
        permissionMode: sessionPermission(state.sessionId).mode
      }
    }
  }

  async setSurface(surface: BotSurface): Promise<BotState> {
    await this.initialize()
    this.currentSurface = surface
    if (surface === 'bot') {
      this.unreadCount = 0
    }
    const next = await this.store.updateState((s) => ({ ...s, lastSurface: surface }))
    this.emit({ type: 'state_changed', state: next })
    return next
  }

  async sendMessage(input: {
    text: string
    images?: BotImageAttachment[]
    textAttachments?: BotTextAttachment[]
    projectMentions?: string[]
  }): Promise<BotTimelineItem> {
    await this.initialize()
    this.lastUserMessage = input
    return this.dispatcher.handleUserMessage(input)
  }

  async retryLastMessage(): Promise<BotTimelineItem | null> {
    if (!this.lastUserMessage) return null
    return this.dispatcher.handleUserMessage(this.lastUserMessage)
  }

  async abortCurrentTurn(): Promise<void> {
    await this.dispatcher.abortActiveTurn()
  }

  async setPermissionMode(mode: PermissionMode): Promise<PermissionMode> {
    const state = await this.store.ensureState()
    await saveSessionPermission(state.sessionId, mode)
    this.emit({ type: 'permission_changed', mode })
    return mode
  }

  async setModel(provider: string, id: string): Promise<SessionControls | null> {
    const session = await this.ensureBotSession()
    const model = (await startModelRuntime()).getModel(provider, id)
    if (!model) throw new Error(`Model not found: ${provider}/${id}`)
    await session.setModel(model)
    const allowed = thinkingLevelsFor(model)
    const clampedThinking = clampThinking(session.thinkingLevel as ThinkingLevel, allowed)
    if (session.thinkingLevel !== clampedThinking) session.setThinkingLevel(clampedThinking)
    await this.store.updateState((s) => ({
      ...s,
      model: { provider: model.provider, id: model.id },
      thinkingLevel: clampedThinking
    }))
    const controls = await this.readBotControls(session)
    if (controls) this.emit({ type: 'controls_changed', controls })
    return controls
  }

  async setThinking(level: ThinkingLevel): Promise<SessionControls | null> {
    const session = await this.ensureBotSession()
    session.setThinkingLevel(level)
    await this.store.updateState((s) => ({ ...s, thinkingLevel: level }))
    const controls = await this.readBotControls(session)
    if (controls) this.emit({ type: 'controls_changed', controls })
    return controls
  }

  /**
   * Emergency "Start fresh / Reset current context":
   * Archives the old JSONL & timeline, opens a fresh Bot session ID, preserves the full task ledger
   * and long-term memory, and does NOT interrupt running background tasks.
   */
  async resetContext(): Promise<BotSnapshot> {
    await this.initialize()
    this.sessionWindow = null
    await this.dispatcher.abortActiveTurn()
    await this.sessionInitPromise?.catch(() => undefined)
    this.sessionWindow = null
    const oldState = await this.store.ensureState()
    const oldMode = sessionPermission(oldState.sessionId).mode

    this.sessionUnsub?.()
    this.sessionUnsub = null
    if (this.agentSession) {
      try { await this.agentSession.abort() } catch {}
      try { this.agentSession.dispose() } catch {}
      this.agentSession = null
    }

    await this.store.archiveAndResetTimeline(oldState.sessionId)
    const newSessionId = `bot-${randomUUID()}`
    await saveSessionPermission(newSessionId, oldMode)

    const nextState = await this.store.updateState((s) => ({
      ...s,
      sessionId: newSessionId,
      archivedSessions: [
        ...s.archivedSessions,
        { sessionId: oldState.sessionId, archivedAt: Date.now(), reason: 'reset' as const }
      ]
    }))

    // Re-route approval delegations for running background tasks without dismissing any live prompt.
    const pendingOwners = new Set(listPendingApprovals().map((item) => item.owner))
    for (const [targetSessionId, release] of [...this.approvalRoutes.entries()]) {
      if (pendingOwners.has(targetSessionId)) continue
      if (!getLive(targetSessionId)) {
        this.approvalRoutes.delete(targetSessionId)
        release()
        continue
      }
      release()
      const nextRelease = delegateApprovals(targetSessionId, {
        controllerId: newSessionId,
        check: () => {
          if (!getLive(targetSessionId)) throw new Error('Managed session closed')
        },
        allows: () => false
      })
      this.approvalRoutes.set(targetSessionId, nextRelease)
    }

    this.unreadCount = 0
    this.emit({ type: 'state_changed', state: nextState })
    this.emit({ type: 'timeline_replaced', timeline: [] })
    return this.getSnapshot()
  }

  async listTasks(filter?: { status?: 'active' | 'all' | 'completed' | 'failed' | 'stopped' }): Promise<BotTask[]> {
    await this.initialize()
    const all = await this.taskManager.listTasks()
    const status = filter?.status
    if (!status || status === 'all') return all
    if (status === 'active') return all.filter((t) => isBotTaskActive(t.status))
    return all.filter((t) => t.status === status)
  }

  async getTask(taskId: string): Promise<BotTask | null> {
    await this.initialize()
    return this.taskManager.getTask(taskId)
  }

  async stopTask(taskId: string): Promise<BotTask> {
    await this.initialize()
    return this.taskManager.stopTask(taskId, 'user')
  }

  async takeOverTask(taskId: string): Promise<BotTask> {
    await this.initialize()
    return this.taskManager.takeoverTask(taskId)
  }

  async followupTask(taskId: string, instruction: string) {
    await this.initialize()
    const state = await this.store.ensureState()
    const mode = sessionPermission(state.sessionId).mode
    return this.taskManager.followupTask(taskId, instruction, mode)
  }

  async checkWorktreeCleanupSafety(taskId: string) {
    await this.initialize()
    return this.taskManager.checkWorktreeCleanupSafety(taskId)
  }

  async cleanupWorktree(taskId: string, confirmation?: string) {
    await this.initialize()
    return this.taskManager.cleanupWorktree(taskId, confirmation)
  }

  async getManagedSessionInfo(sessionId: string): Promise<BotManagedSessionInfo | null> {
    await this.initialize()
    return this.taskManager.getManagedSessionInfo(sessionId)
  }

  async assertUserInputAvailable(sessionId: string): Promise<void> {
    await this.restoringOverlays.get(sessionId)
    if (!managedOverlays.has(sessionId) && !this.launchingSessions.has(sessionId)) return
    const managed = await this.taskManager.getManagedSessionInfo(sessionId)
    const agent = getLive(sessionId)?.agentSession
    if (managed || this.launchingSessions.has(sessionId) || (agent && isSessionRunActive(agent))) {
      throw new Error('Stop or take over the Bot task before sending input to this session.')
    }
  }

  async handleUserPromptInSession(sessionId: string): Promise<void> {
    await this.assertUserInputAvailable(sessionId)
    if (managedOverlays.has(sessionId)) await this.taskManager.markSessionTakenOverOnUserPrompt(sessionId)
  }

  settingsWindow(sessionId: string, manager?: object): BrowserWindow | undefined {
    const win = this.sessionWindow
    if (!manager || this.agentSession?.sessionId !== sessionId || this.agentSession.sessionManager !== manager ||
        !win || win.isDestroyed() || win.webContents.isDestroyed()) return undefined
    return win
  }

  async shutdown(): Promise<void> {
    await this.initialization?.catch(() => undefined)
    await this.sessionInitPromise?.catch(() => undefined)
    this.sessionWindow = null
    this.noticeQueue.dispose()
    this.fallbackTasks.dispose()
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    for (const release of this.approvalRoutes.values()) release()
    this.approvalRoutes.clear()
    this.sessionUnsub?.()
    this.sessionUnsub = null
    if (this.agentSession) {
      try { await this.agentSession.abort() } catch {}
      try { this.agentSession.dispose() } catch {}
      this.agentSession = null
    }
  }
}

let singleton: BotService | null = null

export function botService(): BotService {
  if (!singleton) {
    singleton = new BotService()
    registerBotShutdown(shutdownBotService)
  }
  return singleton
}

export function liveBotSettingsWindow(sessionId: string, manager?: object): BrowserWindow | undefined {
  return singleton?.settingsWindow(sessionId, manager)
}

export async function assertBotUserInputAvailable(sessionId: string): Promise<void> {
  await singleton?.assertUserInputAvailable(sessionId)
}

export async function notifyBotUserPromptInSessionIfActive(sessionId: string): Promise<void> {
  if (!singleton) return
  await singleton.handleUserPromptInSession(sessionId)
}

export async function shutdownBotService(): Promise<void> {
  if (!singleton) return
  await singleton.shutdown()
  singleton = null
}
