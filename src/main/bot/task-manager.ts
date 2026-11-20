/**
 * Bot task orchestration ledger, <50ms Fast Ack async delegation pipeline,
 * generational protection, stop/takeover propagation, and workspace safety checks.
 */
import { randomUUID } from 'node:crypto'
import type { ThinkingLevel } from '../../shared/api'
import type { PermissionMode } from '../../shared/permissions'
import type {
  BotDelegateTaskAck,
  BotDelegateTaskInput,
  BotManagedSessionInfo,
  BotModelOverride,
  BotRun,
  BotStopOrigin,
  BotTask,
  BotTaskCapabilities,
  BotTaskReceipt
} from '../../shared/bot'
import type { SessionAgentTask, SessionStopOrigin } from '../../shared/session-agent'
import { isGitProject, normalizeWorktreePath as resolve, type CreateWorktreeOptions, type GitWorktree } from '../worktrees'
import { BotStore } from './store'
import { BotNoticeQueue } from './notice-queue'
import { collectWorkspaceReceipt, inspectWorktreeSafety, NonGitWriteMutex, prepareGitWriteWorkspace } from './worktree-policy'

export interface BotBackendLaunchParams {
  task: BotTask
  run: BotRun
  cwd: string
  prompt: string
  permissionMode: PermissionMode
  capabilities?: BotTaskCapabilities
  modelOverride?: BotModelOverride
  thinkingOverride?: ThinkingLevel
}

export interface BotBackendLaunchResult {
  sessionId: string
  sessionTaskId?: string
}

export interface BotTaskManagerDeps {
  store: BotStore
  noticeQueue: BotNoticeQueue
  listOpenedProjects: () => Promise<string[]>
  isGitRepo?: (cwd: string) => Promise<boolean>
  createWorktree: (projectCwd: string, options: CreateWorktreeOptions) => Promise<GitWorktree>
  verifyBotWorktree: (projectCwd: string, cwd: string, taskId: string) => Promise<GitWorktree>
  removeWorktree: (projectCwd: string, cwd: string, authorization: { taskId: string; confirmation?: string; check?: () => void }) => Promise<void>
  worktreeDeletionInfo: (projectCwd: string, cwd: string) => Promise<{ worktree: GitWorktree; dirty: boolean; unmerged: boolean; snapshot?: string }>
  launchBackendSession: (params: BotBackendLaunchParams) => Promise<BotBackendLaunchResult>
  stopSession: (sessionId: string, origin: SessionStopOrigin) => Promise<void>
  cleanupSessionProcesses?: (sessionId: string) => Promise<void> | void
  restoreSessionCapabilities?: (sessionId: string) => Promise<void> | void
  collectReceipt?: (cwd: string, summary: string, options?: { errorCode?: string; errorMessage?: string; collectChanges?: boolean }) => Promise<BotTaskReceipt>
  onTaskUpdated?: (task: BotTask) => void
  onTasksReplaced?: (tasks: BotTask[]) => void
}

function mapStopOrigin(origin?: SessionStopOrigin): BotStopOrigin {
  switch (origin) {
    case 'user':
    case 'bot':
    case 'takeover':
    case 'project_removed':
    case 'worktree_deleted':
    case 'session_closed':
    case 'app_shutdown':
      return origin
    case 'agent':
    default:
      return 'bot'
  }
}

interface BotSessionStop {
  origin: BotStopOrigin
  finished?: SessionAgentTask
  coordinator?: { remaining: number; promise: Promise<void>; resolve: () => void }
}

interface BotStopResult {
  task: BotTask
  runId?: string
  receipt?: BotTaskReceipt
}

interface BotStopRequest {
  promise: Promise<BotStopResult>
  finished?: SessionAgentTask
}

export class BotTaskManager {
  private readonly nonGitMutex = new NonGitWriteMutex()
  private readonly stopRequests = new Map<string, BotStopRequest>()
  private readonly sessionStops = new Map<string, BotSessionStop>()
  private readonly finalizations = new Map<string, Promise<BotTask | null>>()
  /** In-flight background launch promises keyed by runId so tests and shutdown can observe settlement. */
  private readonly launchPromises = new Map<string, Promise<void>>()
  private readonly isGitRepo: (cwd: string) => Promise<boolean>
  private readonly collectReceipt: NonNullable<BotTaskManagerDeps['collectReceipt']>

  constructor(private readonly deps: BotTaskManagerDeps) {
    this.isGitRepo = deps.isGitRepo ?? isGitProject
    this.collectReceipt = deps.collectReceipt ?? collectWorkspaceReceipt
  }

  async initialize(): Promise<BotTask[]> {
    await this.deps.noticeQueue.load()
    const recovered = await this.deps.store.recoverInterruptedRuns()
    for (const task of recovered) {
      const lastRun = task.runs[task.runs.length - 1]
      if (!lastRun) continue
      await this.deps.noticeQueue.enqueue({
        noticeId: `interrupted-${task.taskId}-${lastRun.runId}`,
        kind: 'task_interrupted',
        taskId: task.taskId,
        runId: lastRun.runId,
        sessionId: lastRun.sessionId,
        projectCwd: task.projectCwd,
        branch: task.workspace.branch,
        worktreePath: task.workspace.kind === 'worktree' ? task.workspace.cwd : undefined,
        summary: 'Task was interrupted when Pig exited unexpectedly.',
        receipt: task.latestReceipt
      })
    }
    const all = await this.deps.store.readTasks()
    this.deps.onTasksReplaced?.(all)
    return all
  }

  async listTasks(): Promise<BotTask[]> {
    return this.deps.store.readTasks()
  }

  async getTask(taskId: string): Promise<BotTask | null> {
    const tasks = await this.deps.store.readTasks()
    return tasks.find((t) => t.taskId === taskId) ?? null
  }

  async getManagedSessionInfo(sessionId: string): Promise<BotManagedSessionInfo | null> {
    const tasks = await this.deps.store.readTasks()
    for (const task of tasks) {
      if (!task.activeRunId) continue
      const run = task.runs.find((r) => r.runId === task.activeRunId)
      if (run?.sessionId === sessionId) {
        return {
          taskId: task.taskId,
          runId: run.runId,
          title: task.title,
          projectCwd: task.projectCwd,
          branch: task.workspace.branch,
          status: task.status,
          runStatus: run.status
        }
      }
    }
    return null
  }

  async findTaskBySessionId(sessionId: string): Promise<BotTask | null> {
    const tasks = await this.deps.store.readTasks()
    return tasks.find((t) => t.runs.some((r) => r.sessionId === sessionId)) ?? null
  }

  /**
   * <50ms Fast Ack delegation: validates permissions and project membership, persists
   * `starting` task + run atomically, returns immediately, and launches worktree + session asynchronously.
   */
  async delegateTask(input: BotDelegateTaskInput, callerPermissionMode: PermissionMode, check?: () => void): Promise<BotDelegateTaskAck> {
    const title = input.title.trim()
    const intent = input.intent.trim()
    if (!title) throw new Error('Task title is required')
    if (!intent) throw new Error('Task intent is required')
    if (input.mode !== 'read' && input.mode !== 'write') throw new Error('Invalid task mode')

    // Never escalate permissions: read-only Bot cannot delegate write tasks.
    if (input.mode === 'write' && callerPermissionMode === 'read-only') {
      throw new Error('Read-only mode cannot delegate write tasks')
    }
    const effectivePermission: PermissionMode = input.mode === 'read' ? 'read-only' : callerPermissionMode

    const normalizedProject = resolve(input.projectCwd)
    const opened = (await this.deps.listOpenedProjects()).map((p) => resolve(p))
    if (!opened.includes(normalizedProject)) {
      throw new Error(`Project is not open in Pig: ${normalizedProject}`)
    }

    const taskId = randomUUID()
    const runId = randomUUID()
    const now = Date.now()

    const run: BotRun = {
      runId,
      taskId,
      cwd: normalizedProject,
      status: 'starting',
      startedAt: now,
      ...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
      ...(input.thinkingOverride ? { thinkingOverride: input.thinkingOverride } : {})
    }
    const task: BotTask = {
      taskId,
      title,
      summary: intent.slice(0, 280),
      intent,
      projectCwd: normalizedProject,
      mode: input.mode,
      workspace: { kind: 'project', cwd: normalizedProject },
      status: 'starting',
      activeRunId: runId,
      runs: [run],
      delivery: { state: 'pending' },
      ...(input.capabilities ? { capabilities: input.capabilities } : {}),
      createdAt: now,
      updatedAt: now
    }

    await this.deps.store.updateTasks((tasks) => {
      check?.()
      tasks.unshift(task)
      return { tasks, result: undefined }
    })
    this.deps.onTaskUpdated?.(structuredClone(task))

    const launch = this.launchRunAsync(taskId, runId, {
      prompt: intent,
      slug: input.slug ?? title,
      permissionMode: effectivePermission,
      capabilities: input.capabilities,
      modelOverride: input.modelOverride,
      thinkingOverride: input.thinkingOverride,
      confirmSharedNonGitWrite: input.confirmSharedNonGitWrite
    }).finally(() => {
      this.launchPromises.delete(runId)
    })
    this.launchPromises.set(runId, launch)

    return {
      taskId,
      runId,
      projectCwd: normalizedProject,
      mode: input.mode,
      status: 'starting'
    }
  }

  /** Wait for an async background launch promise (useful for tests). */
  async waitForLaunch(runId: string): Promise<void> {
    await this.launchPromises.get(runId)
  }

  private readonly cleaningTasks = new Set<string>()

  async followupTask(
    taskId: string,
    instruction: string,
    callerPermissionMode: PermissionMode,
    options?: { modelOverride?: BotModelOverride; thinkingOverride?: ThinkingLevel }
  ): Promise<BotDelegateTaskAck> {
    const cleanInstruction = instruction.trim()
    if (!cleanInstruction) throw new Error('Follow-up instruction is required')
    const existing = await this.getTask(taskId)
    if (!existing) throw new Error(`Bot task not found: ${taskId}`)
    if (existing.status === 'starting' || existing.status === 'running' || existing.status === 'blocked_approval') {
      throw new Error('Cannot follow up while a run is already active; stop it first')
    }
    if (existing.mode === 'write' && callerPermissionMode === 'read-only') {
      throw new Error('Read-only mode cannot continue a write task')
    }
    if (existing.workspace.kind === 'worktree' && existing.workspace.cleanedUpAt) {
      throw new Error('Cannot follow up because this task’s worktree has already been cleaned up')
    }
    const effectivePermission: PermissionMode = existing.mode === 'read' ? 'read-only' : callerPermissionMode

    const runId = randomUUID()
    const now = Date.now()
    const newRun: BotRun = {
      runId,
      taskId,
      cwd: existing.workspace.cwd,
      status: 'starting',
      startedAt: now,
      ...(options?.modelOverride ? { modelOverride: options.modelOverride } : {}),
      ...(options?.thinkingOverride ? { thinkingOverride: options.thinkingOverride } : {})
    }

    const updated = await this.deps.store.updateTasks((tasks) => {
      const target = tasks.find((t) => t.taskId === taskId)
      if (!target) throw new Error(`Bot task not found: ${taskId}`)
      if (target.activeRunId) throw new Error('Cannot follow up while a run is already active; stop it first')
      if (this.cleaningTasks.has(taskId) || target.workspace.cleanedUpAt) throw new Error('Task worktree is being cleaned up or has already been removed')
      target.runs.push(newRun)
      target.activeRunId = runId
      target.status = 'starting'
      target.delivery = { state: 'pending' }
      target.updatedAt = now
      return { tasks, result: structuredClone(target) }
    })
    this.deps.onTaskUpdated?.(updated)

    const launch = this.launchRunAsync(taskId, runId, {
      prompt: cleanInstruction,
      slug: existing.title,
      permissionMode: effectivePermission,
      capabilities: existing.capabilities,
      modelOverride: options?.modelOverride,
      thinkingOverride: options?.thinkingOverride,
      reuseExistingWorkspace: true,
      confirmSharedNonGitWrite: true
    }).finally(() => {
      this.launchPromises.delete(runId)
    })
    this.launchPromises.set(runId, launch)

    return {
      taskId,
      runId,
      projectCwd: existing.projectCwd,
      mode: existing.mode,
      status: 'starting'
    }
  }

  private async launchRunAsync(
    taskId: string,
    runId: string,
    options: {
      prompt: string
      slug: string
      permissionMode: PermissionMode
      capabilities?: BotTaskCapabilities
      modelOverride?: BotModelOverride
      thinkingOverride?: ThinkingLevel
      reuseExistingWorkspace?: boolean
      confirmSharedNonGitWrite?: boolean
    }
  ): Promise<void> {
    let heldNonGitCwd: string | null = null
    try {
      const task = await this.getTask(taskId)
      if (!task || task.activeRunId !== runId) return
      if (this.stopRequests.has(runId)) return

      let workspace = structuredClone(task.workspace)
      if (task.mode === 'read') {
        workspace = { kind: 'project', cwd: task.projectCwd }
      } else if (await this.isGitRepo(task.projectCwd)) {
        workspace = await prepareGitWriteWorkspace({
          create: this.deps.createWorktree,
          verifyBotWorktree: this.deps.verifyBotWorktree
        }, task, options.slug, options.reuseExistingWorkspace === true)
      } else {
        if (!options.confirmSharedNonGitWrite || workspace.kind === 'worktree') {
          throw new Error('Write tasks in a non-Git directory require explicit user confirmation to share the directory')
        }
        this.nonGitMutex.acquire(task.projectCwd, taskId)
        heldNonGitCwd = task.projectCwd
        workspace = { kind: 'project', cwd: task.projectCwd }
      }

      // Persist resolved workspace before starting the session.
      const preparedTask = await this.deps.store.updateTasks((tasks) => {
        const target = tasks.find((t) => t.taskId === taskId)
        if (!target || target.activeRunId !== runId) return { tasks, result: null }
        target.workspace = workspace
        const run = target.runs.find((r) => r.runId === runId)
        if (run) run.cwd = workspace.cwd
        target.updatedAt = Date.now()
        return { tasks, result: structuredClone(target) }
      })
      if (!preparedTask) {
        if (heldNonGitCwd) this.nonGitMutex.release(heldNonGitCwd, taskId)
        return
      }
      this.deps.onTaskUpdated?.(preparedTask)
      if (this.stopRequests.has(runId)) return

      const runSnapshot = preparedTask.runs.find((r) => r.runId === runId)!
      const launched = await this.deps.launchBackendSession({
        task: preparedTask,
        run: runSnapshot,
        cwd: workspace.cwd,
        prompt: options.prompt,
        permissionMode: options.permissionMode,
        capabilities: options.capabilities,
        modelOverride: options.modelOverride,
        thinkingOverride: options.thinkingOverride
      })

      const runningTask = await this.deps.store.updateTasks((tasks) => {
        const target = tasks.find((t) => t.taskId === taskId)
        if (!target || target.activeRunId !== runId) return { tasks, result: null }
        const run = target.runs.find((r) => r.runId === runId)
        if (!run) return { tasks, result: null }
        run.sessionId = launched.sessionId
        run.sessionTaskId = launched.sessionTaskId
        if (!this.stopRequests.has(runId) && run.status === 'starting') {
          run.status = 'running'
          target.status = 'running'
        }
        target.updatedAt = Date.now()
        return { tasks, result: structuredClone(target) }
      })
      if (runningTask) this.deps.onTaskUpdated?.(runningTask)
    } catch (error) {
      if (this.stopRequests.has(runId)) return
      const message = error instanceof Error ? error.message : String(error)
      const now = Date.now()
      const receipt: BotTaskReceipt = {
        summary: `Failed to start task: ${message}`,
        changedFiles: [],
        totalAdded: 0,
        totalRemoved: 0,
        errorCode: 'START_FAILED',
        errorMessage: message,
        collectedAt: now
      }
      const failedTask = await this.deps.store.updateTasks((tasks) => {
        const target = tasks.find((t) => t.taskId === taskId)
        if (!target || target.activeRunId !== runId || this.stopRequests.has(runId)) return { tasks, result: null }
        if (heldNonGitCwd) this.nonGitMutex.release(heldNonGitCwd, taskId)
        const run = target.runs.find((r) => r.runId === runId)
        if (run) {
          run.status = 'failed'
          run.endedAt = now
          run.durationMs = Math.max(0, now - run.startedAt)
        }
        target.status = 'failed'
        target.activeRunId = undefined
        target.latestReceipt = receipt
        target.updatedAt = now
        return { tasks, result: structuredClone(target) }
      })
      if (failedTask) {
        this.deps.onTaskUpdated?.(failedTask)
        await this.deps.noticeQueue.enqueue({
          noticeId: `start-failed-${taskId}-${runId}`,
          kind: 'task_start_failed',
          taskId,
          runId,
          projectCwd: failedTask.projectCwd,
          branch: failedTask.workspace.branch,
          summary: receipt.summary,
          receipt
        })
      }
    }
  }

  /**
   * Opens a stop barrier before the coordinator aborts the agent. Its task-finished
   * event can arrive before submissions and subagents have finished stopping.
   */
  async handleBeforeSessionStop(sessionId: string, origin: SessionStopOrigin): Promise<void> {
    let stop = this.sessionStops.get(sessionId)
    if (!stop) {
      let resolve!: () => void
      const promise = new Promise<void>((done) => { resolve = done })
      stop = { origin: mapStopOrigin(origin), coordinator: { remaining: 0, promise, resolve } }
      this.sessionStops.set(sessionId, stop)
    }
    if (stop.coordinator) stop.coordinator.remaining++
    await this.markRunStopping((run) => run.sessionId === sessionId, stop.origin)
  }

  async handleAfterSessionStop(sessionId: string): Promise<void> {
    const stop = this.sessionStops.get(sessionId)
    // A Bot stop request owns the barrier until stopSession itself returns.
    if (!stop?.coordinator || --stop.coordinator.remaining > 0) return
    try {
      if (stop.finished) await this.finishSessionTask(stop.finished, stop)
    } finally {
      if (stop.coordinator.remaining === 0) {
        this.sessionStops.delete(sessionId)
        stop.coordinator.resolve()
      }
    }
  }

  private async markRunStopping(matches: (run: BotRun) => boolean, origin: BotStopOrigin): Promise<void> {
    const updated = await this.deps.store.updateTasks((tasks) => {
      for (const task of tasks) {
        const run = task.runs.find((r) => r.runId === task.activeRunId)
        if (!run || !matches(run) || this.finalizations.has(run.runId) || run.status === 'stopping') continue
        run.status = 'stopping'
        run.stopOrigin ??= origin
        task.updatedAt = Date.now()
        return { tasks, result: structuredClone(task) }
      }
      return { tasks, result: null }
    })
    if (updated) this.deps.onTaskUpdated?.(updated)
  }

  async handleSessionTaskFinished(sessionTask: SessionAgentTask): Promise<void> {
    const stop = this.sessionStops.get(sessionTask.sessionId)
    if (stop) {
      stop.finished ??= sessionTask
    } else {
      await this.finishSessionTask(sessionTask)
    }
  }

  private async finishSessionTask(sessionTask: SessionAgentTask, settledStop?: BotSessionStop): Promise<void> {
    const tasks = await this.deps.store.readTasks()
    for (const task of tasks) {
      const run = task.runs.find((r) => r.runId === task.activeRunId)
      if (!run || run.sessionId !== sessionTask.sessionId ||
          (run.sessionTaskId && run.sessionTaskId !== sessionTask.taskId)) continue

      // A stop may have started while the ledger read was pending.
      const stop = this.sessionStops.get(sessionTask.sessionId)
      if (stop && (stop !== settledStop || (stop.coordinator?.remaining ?? 0) > 0)) {
        stop.finished ??= sessionTask
        return
      }
      const request = this.stopRequests.get(run.runId)
      if (request && !settledStop) {
        request.finished ??= sessionTask
        return
      }
      await this.finalizeRun(task, run, { sessionTask, origin: settledStop?.origin })
      return
    }
  }

  private finalizeRun(
    task: BotTask,
    run: BotRun,
    outcome: { sessionTask?: SessionAgentTask; origin?: BotStopOrigin; inline?: boolean }
  ): Promise<BotTask | null> {
    const existing = this.finalizations.get(run.runId)
    if (existing) return existing
    // Publish the promise before running cleanup, including synchronous hooks.
    const pending = Promise.resolve().then(async () => {
      const current = await this.getTask(task.taskId)
      const currentRun = current?.runs.find((candidate) => candidate.runId === current.activeRunId)
      if (!current || currentRun?.runId !== run.runId) return null
      return this.settleRun(current, currentRun, outcome)
    }).finally(() => this.finalizations.delete(run.runId))
    this.finalizations.set(run.runId, pending)
    return pending
  }

  private async settleRun(
    task: BotTask,
    run: BotRun,
    { sessionTask, origin, inline }: { sessionTask?: SessionAgentTask; origin?: BotStopOrigin; inline?: boolean }
  ): Promise<BotTask | null> {
    if (sessionTask && run.sessionTaskId && sessionTask.taskId !== run.sessionTaskId) sessionTask = undefined
    const stopOrigin = run.stopOrigin ?? origin ??
      (sessionTask?.stopOrigin ? mapStopOrigin(sessionTask.stopOrigin) : undefined)
    const isStopped = Boolean(stopOrigin) || run.status === 'stopping' || sessionTask?.status === 'aborted'
    const nextRunStatus = isStopped ? 'stopped' : sessionTask?.status === 'completed' ? 'completed' : 'failed'
    const nextTaskStatus = stopOrigin === 'takeover' ? 'taken_over' : nextRunStatus
    const summary = sessionTask?.reply?.trim() || sessionTask?.error?.trim() ||
      (isStopped
        ? `Stopped (${stopOrigin ?? 'user'})${run.sessionId ? '' : ' before background session started'}.`
        : nextTaskStatus === 'completed' ? 'Completed.' : 'Failed.')

    if (run.sessionId) {
      await this.deps.cleanupSessionProcesses?.(run.sessionId)
    }
    const receipt = await this.collectReceipt(run.cwd, summary, {
      // Before the backend starts, no changes can belong to this run.
      collectChanges: Boolean(run.sessionId) && task.mode === 'write',
      ...(nextTaskStatus === 'failed' ? { errorCode: 'RUN_FAILED', errorMessage: sessionTask?.error || summary } : {})
    })
    if (nextTaskStatus === 'taken_over' && run.sessionId) {
      await this.deps.restoreSessionCapabilities?.(run.sessionId)
    }

    const handledInline = inline && stopOrigin === 'bot'
    const now = Date.now()
    const finalized = await this.deps.store.updateTasks((tasks) => {
      const target = tasks.find((t) => t.taskId === task.taskId)
      const targetRun = target?.runs.find((r) => r.runId === target.activeRunId)
      if (!target || targetRun?.runId !== run.runId) return { tasks, result: null }
      this.nonGitMutex.release(task.projectCwd, task.taskId)
      targetRun.status = nextRunStatus
      targetRun.stopOrigin ??= stopOrigin
      targetRun.endedAt = now
      targetRun.durationMs = Math.max(0, now - targetRun.startedAt)
      target.status = nextTaskStatus
      target.activeRunId = undefined
      target.latestReceipt = receipt
      if (handledInline) target.delivery = { state: 'delivered', deliveredAt: now }
      target.updatedAt = now
      return { tasks, result: structuredClone(target) }
    })
    if (!finalized) return null
    this.deps.onTaskUpdated?.(finalized)

    if (!handledInline) {
      const kind = nextTaskStatus === 'completed' ? 'task_completed'
        : nextTaskStatus === 'taken_over' ? 'task_taken_over'
          : nextTaskStatus === 'stopped'
            ? (stopOrigin === 'user' || !stopOrigin ? 'task_stopped_by_user' : 'task_stopped')
            : 'task_failed'
      await this.deps.noticeQueue.enqueue({
        noticeId: `finish-${task.taskId}-${run.runId}-${kind}`,
        kind,
        taskId: task.taskId,
        runId: run.runId,
        sessionId: run.sessionId,
        projectCwd: task.projectCwd,
        branch: finalized.workspace.branch,
        worktreePath: finalized.workspace.kind === 'worktree' ? finalized.workspace.cwd : undefined,
        stopOrigin,
        summary: receipt.summary,
        receipt
      })
    }
    return finalized
  }

  async markApprovalBlocked(sessionId: string, requestId: string, summary: string): Promise<void> {
    const updated = await this.deps.store.updateTasks((tasks) => {
      for (const task of tasks) {
        if (!task.activeRunId) continue
        const run = task.runs.find((r) => r.runId === task.activeRunId)
        if (!run || run.sessionId !== sessionId) continue
        if (task.status === 'running') {
          task.status = 'blocked_approval'
          task.updatedAt = Date.now()
          return { tasks, result: { task: structuredClone(task), runId: run.runId } }
        }
      }
      return { tasks, result: null }
    })
    if (!updated) return
    this.deps.onTaskUpdated?.(updated.task)
    await this.deps.noticeQueue.enqueue({
      noticeId: `approval-${updated.task.taskId}-${requestId}`,
      kind: 'task_blocked_approval',
      taskId: updated.task.taskId,
      runId: updated.runId,
      sessionId,
      projectCwd: updated.task.projectCwd,
      branch: updated.task.workspace.branch,
      worktreePath: updated.task.workspace.kind === 'worktree' ? updated.task.workspace.cwd : undefined,
      approvalRequestId: requestId,
      summary
    })
  }

  async markApprovalResolved(sessionId: string): Promise<void> {
    const updated = await this.deps.store.updateTasks((tasks) => {
      for (const task of tasks) {
        if (!task.activeRunId || task.status !== 'blocked_approval') continue
        const run = task.runs.find((r) => r.runId === task.activeRunId)
        if (!run || run.sessionId !== sessionId) continue
        task.status = 'running'
        task.updatedAt = Date.now()
        return { tasks, result: structuredClone(task) }
      }
      return { tasks, result: null }
    })
    if (updated) this.deps.onTaskUpdated?.(updated)
  }

  async stopTask(taskId: string, origin: BotStopOrigin = 'user'): Promise<BotTask> {
    return (await this.requestStop(taskId, origin, false)).task
  }

  async stopTaskFromTool(taskId: string): Promise<BotStopResult> {
    return this.requestStop(taskId, 'bot', true)
  }

  private async requestStop(
    taskId: string,
    origin: BotStopOrigin,
    inline: boolean
  ): Promise<BotStopResult> {
    const task = await this.getTask(taskId)
    if (!task) throw new Error(`Bot task not found: ${taskId}`)
    const run = task.runs.find((r) => r.runId === task.activeRunId)
    if (!run) return { task }

    const finalizing = this.finalizations.get(run.runId)
    if (finalizing) return { task: await finalizing ?? task, runId: run.runId }
    const existing = this.stopRequests.get(run.runId)
    if (existing) return { task: (await existing.promise).task, runId: run.runId }

    const request: BotStopRequest = {
      promise: Promise.resolve().then(() => this.stopRun(task, run, origin, inline, request))
        .finally(() => this.stopRequests.delete(run.runId))
    }
    this.stopRequests.set(run.runId, request)
    return { ...await request.promise, runId: run.runId }
  }

  private async stopRun(
    task: BotTask,
    run: BotRun,
    origin: BotStopOrigin,
    inline: boolean,
    request: BotStopRequest
  ): Promise<BotStopResult> {
    if (run.stopOrigin) inline = false
    const settle = async (firstCause: BotStopOrigin, sessionTask?: SessionAgentTask): Promise<BotStopResult> => {
      const existing = this.finalizations.get(run.runId)
      if (existing) return { task: await existing ?? task }
      const handledInline = inline && firstCause === 'bot'
      const settled = await this.finalizeRun(task, run, { sessionTask, origin: firstCause, inline: handledInline })
      return {
        task: settled ?? task,
        receipt: handledInline && settled?.runs.find((r) => r.runId === run.runId)?.stopOrigin === 'bot'
          ? settled.latestReceipt : undefined
      }
    }
    if (!run.sessionId) {
      await this.markRunStopping((candidate) => candidate.runId === run.runId, origin)
      await this.launchPromises.get(run.runId)
      task = await this.getTask(task.taskId) ?? task
      if (task.activeRunId !== run.runId) return { task }
      run = task.runs.find((candidate) => candidate.runId === run.runId)!
    }

    const sessionId = run.sessionId
    if (!sessionId) return settle(run.stopOrigin ?? origin)

    // Honor a stop that was already initiated from the session, rather than
    // claiming its receipt for a later bot_stop_task call.
    let earlierStop = this.sessionStops.get(sessionId)
    while (earlierStop?.coordinator) {
      await earlierStop.coordinator.promise
      task = await this.getTask(task.taskId) ?? task
      if (task.activeRunId !== run.runId) return { task }
      run = task.runs.find((candidate) => candidate.runId === run.runId)!
      inline = false
      earlierStop = this.sessionStops.get(sessionId)
    }
    const stop: BotSessionStop = { origin: run.stopOrigin ?? origin }
    this.sessionStops.set(sessionId, stop)
    try {
      await this.markRunStopping((candidate) => candidate.runId === run.runId, stop.origin)
      const finalizing = this.finalizations.get(run.runId)
      if (finalizing) return { task: await finalizing ?? task }
      task = await this.getTask(task.taskId) ?? task
      if (task.activeRunId !== run.runId) return { task }

      try {
        await this.deps.stopSession(sessionId, stop.origin)
      } catch (error) {
        // If the tracker settled despite an error, retain the Notice path.
        inline = false
        const finished = stop.finished ?? request.finished
        if (finished) await settle(stop.origin, finished)
        throw error
      }
      return await settle(stop.origin, stop.finished ?? request.finished)
    } finally {
      this.sessionStops.delete(sessionId)
    }
  }

  async takeoverTask(taskId: string): Promise<BotTask> {
    const { task, runId } = await this.requestStop(taskId, 'takeover', false)
    if (task.status === 'taken_over' || task.activeRunId) return task

    // Idle takeover changes ownership only. A prior run keeps its receipt,
    // first stop cause, and Notice, and a newer generation is never detached.
    const lastRun = task.runs.at(-1)
    if (runId && lastRun?.runId !== runId) return task
    const lastSessionId = task.runs.findLast((r) => r.sessionId)?.sessionId
    if (lastSessionId) await this.deps.restoreSessionCapabilities?.(lastSessionId)
    const updated = await this.deps.store.updateTasks((tasks) => {
      const target = tasks.find((t) => t.taskId === taskId)!
      if (target.activeRunId || target.runs.at(-1)?.runId !== lastRun?.runId || target.status === 'taken_over') {
        return { tasks, result: null }
      }
      target.status = 'taken_over'
      target.updatedAt = Date.now()
      return { tasks, result: structuredClone(target) }
    })
    if (updated) this.deps.onTaskUpdated?.(updated)
    return updated ?? (await this.getTask(taskId)) ?? task
  }

  /**
   * When the user manually sends a prompt inside an idle Bot-created session,
   * automatically release Bot ownership so further manual turns never emit Bot receipts.
   */
  async markSessionTakenOverOnUserPrompt(sessionId: string): Promise<boolean> {
    const updated = await this.deps.store.updateTasks((tasks) => {
      const target = tasks.find((t) =>
        !t.activeRunId &&
        t.status !== 'taken_over' &&
        t.runs.some((r) => r.sessionId === sessionId)
      )
      if (!target) return { tasks, result: null }
      target.status = 'taken_over'
      target.updatedAt = Date.now()
      return { tasks, result: structuredClone(target) }
    })
    if (!updated) return false
    await Promise.resolve(this.deps.restoreSessionCapabilities?.(sessionId)).catch(() => {})
    this.deps.onTaskUpdated?.(updated)
    return true
  }

  async markDeliveryState(
    taskId: string,
    runId: string,
    state: BotTask['delivery']['state'],
    options?: { noticeId?: string; error?: string }
  ): Promise<void> {
    const updated = await this.deps.store.updateTasks((tasks) => {
      const target = tasks.find((t) => t.taskId === taskId)
      if (!target || target.runs.at(-1)?.runId !== runId) return { tasks, result: null }
      target.delivery = {
        state,
        lastNoticeId: options?.noticeId ?? target.delivery.lastNoticeId,
        deliveredAt: state === 'delivered' || state === 'fallback' ? Date.now() : target.delivery.deliveredAt,
        error: options?.error
      }
      target.updatedAt = Date.now()
      return { tasks, result: structuredClone(target) }
    })
    if (updated) this.deps.onTaskUpdated?.(updated)
  }

  async checkWorktreeCleanupSafety(taskId: string): Promise<{
    task: BotTask
    dirty: boolean
    unmerged: boolean
    branch: string
    needsForceConfirm: boolean
    snapshot?: string
  }> {
    const task = await this.getTask(taskId)
    if (!task) throw new Error(`Bot task not found: ${taskId}`)
    if (task.activeRunId) throw new Error('Cannot clean up a worktree while the task is still active')
    if (task.workspace.kind !== 'worktree') throw new Error('Task does not have a dedicated Bot worktree')
    if (task.workspace.cleanedUpAt) throw new Error('Bot worktree has already been cleaned up')
    const info = await inspectWorktreeSafety(
      { deletionInfo: this.deps.worktreeDeletionInfo },
      task.projectCwd,
      task.workspace.cwd
    )
    if (!info.isBotOwned || info.ownerTaskId !== taskId) {
      throw new Error('Target worktree is not owned by this Bot task')
    }
    return {
      task,
      dirty: info.dirty,
      unmerged: info.unmerged,
      branch: info.branch,
      snapshot: info.snapshot,
      needsForceConfirm: info.dirty || info.unmerged
    }
  }

  async cleanupWorktree(taskId: string, confirmation?: string, check?: () => void): Promise<{ taskId: string; cwd: string; branch?: string }> {
    if (this.cleaningTasks.has(taskId)) throw new Error('Task worktree cleanup is already in progress')
    this.cleaningTasks.add(taskId)
    try {
      const safety = await this.checkWorktreeCleanupSafety(taskId)
      if ((safety.needsForceConfirm && !confirmation) || (confirmation !== undefined && confirmation !== safety.snapshot)) {
        throw Object.assign(new Error('Worktree state changed or needs confirmation; inspect it again before deleting.'), { code: 'ERR_WORKTREE_DELETION_UNCONFIRMED_CHANGES' })
      }
      check?.()
      await this.deps.removeWorktree(safety.task.projectCwd, safety.task.workspace.cwd, { taskId, confirmation, check })
      const now = Date.now()
      const updated = await this.deps.store.updateTasks((tasks) => {
        const target = tasks.find((t) => t.taskId === taskId)
        if (!target) return { tasks, result: null }
        target.workspace.cleanedUpAt = now
        target.updatedAt = now
        return { tasks, result: structuredClone(target) }
      })
      if (updated) this.deps.onTaskUpdated?.(updated)
      return { taskId, cwd: safety.task.workspace.cwd, branch: safety.branch }
    } finally {
      this.cleaningTasks.delete(taskId)
    }
  }
}
