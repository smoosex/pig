import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotStore } from '../src/main/bot/store'
import { BotNoticeQueue } from '../src/main/bot/notice-queue'
import { BotTaskManager } from '../src/main/bot/task-manager'
import type { BotNotice, BotTaskReceipt } from '../src/shared/bot'
import type { SessionAgentTask } from '../src/shared/session-agent'

const temps: string[] = []
const queues: BotNoticeQueue[] = []

afterEach(async () => {
  for (const q of queues.splice(0)) q.dispose()
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function emptyReceipt(summary = 'done'): BotTaskReceipt {
  return { summary, changedFiles: [], totalAdded: 0, totalRemoved: 0, collectedAt: Date.now() }
}

async function makeFixture(overrides: Partial<ConstructorParameters<typeof BotTaskManager>[0]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pig-bot-tm-'))
  temps.push(dir)
  const store = new BotStore(join(dir, 'bot'))
  const noticeQueue = new BotNoticeQueue(store.noticesFilePath, 20)
  queues.push(noticeQueue)
  const projectCwd = join(dir, 'repo')

  const launched: Array<{ sessionId: string; permissionMode: string; cwd: string }> = []
  const cleanedProcesses: string[] = []
  const restoredCapabilities: string[] = []
  let seq = 0
  const allocated = new Map<string, import('../src/main/worktrees').GitWorktree>()

  const manager = new BotTaskManager({
    store,
    noticeQueue,
    listOpenedProjects: async () => [projectCwd],
    isGitRepo: async () => true,
    createWorktree: async (_proj, opts) => {
      const worktree = {
        cwd: join(dir, 'wt', `bot-${opts.owner!.taskId.slice(0, 6)}`),
        branch: `bot/task-${opts.owner!.taskId.slice(0, 6)}`,
        isPrimary: false, locked: false, missing: false, managed: true, owner: opts.owner
      }
      allocated.set(worktree.cwd, worktree)
      return worktree
    },
    verifyBotWorktree: async (_project, cwd, taskId) => {
      const tree = allocated.get(cwd)
      if (!tree || tree.owner?.taskId !== taskId) throw new Error('Unverified worktree')
      return tree
    },
    removeWorktree: async () => {},
    worktreeDeletionInfo: async (_proj, cwd) => ({
      worktree: allocated.get(cwd)!,
      dirty: false,
      unmerged: false
    }),
    launchBackendSession: async (params) => {
      seq++
      const sessionId = `sess-${seq}`
      launched.push({ sessionId, permissionMode: params.permissionMode, cwd: params.cwd })
      return { sessionId, sessionTaskId: `stask-${seq}` }
    },
    stopSession: async () => {},
    cleanupSessionProcesses: (sid) => { cleanedProcesses.push(sid) },
    restoreSessionCapabilities: (sid) => { restoredCapabilities.push(sid) },
    collectReceipt: async (_cwd, summary) => emptyReceipt(summary),
    ...overrides
  })

  return { dir, store, noticeQueue, projectCwd, manager, launched, cleanedProcesses, restoredCapabilities }
}

describe('BotTaskManager and BotNoticeQueue', () => {
  test('delegateTask returns Fast Ack immediately while worktree creation runs asynchronously', async () => {
    let releaseWorktree!: () => void
    let markWorktreeStarted!: () => void
    const worktreeStarted = new Promise<void>((r) => { markWorktreeStarted = r })
    const { manager, projectCwd, launched } = await makeFixture({
      createWorktree: async (_proj, opts) => {
        markWorktreeStarted()
        await new Promise<void>((r) => { releaseWorktree = r })
        return {
          cwd: `/tmp/wt-${opts.owner!.taskId.slice(0, 6)}`,
          branch: `bot/speed-${opts.owner!.taskId.slice(0, 6)}`,
          isPrimary: false,
          locked: false,
          missing: false,
          managed: true,
          owner: opts.owner
        }
      }
    })

    const start = performance.now()
    const ack = await manager.delegateTask({
      projectCwd,
      title: 'Fix export speed',
      intent: 'Optimize export pipeline',
      mode: 'write'
    }, 'full-access')
    const elapsed = performance.now() - start

    expect(ack.status).toBe('starting')
    expect(elapsed).toBeLessThan(150)
    expect(launched).toHaveLength(0)

    await worktreeStarted
    releaseWorktree()
    await manager.waitForLaunch(ack.runId)

    const task = await manager.getTask(ack.taskId)
    expect(task?.status).toBe('running')
    expect(task?.workspace.kind).toBe('worktree')
    expect(task?.workspace.branch).toStartWith('bot/speed-')
    expect(launched).toHaveLength(1)
    expect(launched[0].permissionMode).toBe('full-access')
  })

  test('never escalates permissions: read-only blocks write delegation and read tasks lock to read-only', async () => {
    const { manager, projectCwd, launched } = await makeFixture()
    await expect(manager.delegateTask({
      projectCwd,
      title: 'Edit file',
      intent: 'Write code',
      mode: 'write'
    }, 'read-only')).rejects.toThrow('Read-only')

    const readAck = await manager.delegateTask({
      projectCwd,
      title: 'Audit code',
      intent: 'Inspect files',
      mode: 'read'
    }, 'full-access')
    await manager.waitForLaunch(readAck.runId)

    expect(launched[0].permissionMode).toBe('read-only')
    const task = await manager.getTask(readAck.taskId)
    expect(task?.workspace.kind).toBe('project')
  })

  test('propagates user stopOrigin, cleans up lingering processes, and enqueues task_stopped_by_user notice', async () => {
    const { manager, projectCwd, noticeQueue, cleanedProcesses } = await makeFixture()
    const ack = await manager.delegateTask({
      projectCwd,
      title: 'Refactor parser',
      intent: 'Refactor',
      mode: 'write'
    }, 'full-access')
    await manager.waitForLaunch(ack.runId)

    const task = (await manager.getTask(ack.taskId))!
    const run = task.runs[0]

    await manager.handleBeforeSessionStop(run.sessionId!, 'user')
    const stoppingTask = (await manager.getTask(ack.taskId))!
    expect(stoppingTask.runs[0].status).toBe('stopping')
    expect(stoppingTask.runs[0].stopOrigin).toBe('user')

    const fakeSessionTask: SessionAgentTask = {
      taskId: run.sessionTaskId!,
      sessionId: run.sessionId!,
      status: 'aborted',
      stopOrigin: 'user',
      startedAt: Date.now() - 1000,
      endedAt: Date.now(),
      durationMs: 1000,
      reply: 'Partial refactor done',
      cost: 0,
      usageIncomplete: false,
      children: 0
    }
    await manager.handleSessionTaskFinished(fakeSessionTask)
    expect(cleanedProcesses).toEqual([])
    expect(noticeQueue.list()).toEqual([])
    await manager.handleAfterSessionStop(run.sessionId!)

    const finalTask = (await manager.getTask(ack.taskId))!
    expect(finalTask.status).toBe('stopped')
    expect(finalTask.activeRunId).toBeUndefined()
    expect(finalTask.runs[0].stopOrigin).toBe('user')
    expect(cleanedProcesses).toEqual([run.sessionId!])

    const notices = noticeQueue.list()
    expect(notices).toHaveLength(1)
    expect(notices[0].kind).toBe('task_stopped_by_user')
    expect(notices[0].stopOrigin).toBe('user')
  })

  test('generational protection prevents a stale run callback from overwriting a follow-up run', async () => {
    const { manager, projectCwd } = await makeFixture()
    const ack1 = await manager.delegateTask({
      projectCwd,
      title: 'Fix bug',
      intent: 'Try 1',
      mode: 'write'
    }, 'full-access')
    await manager.waitForLaunch(ack1.runId)
    const run1 = (await manager.getTask(ack1.taskId))!.runs[0]

    await manager.handleSessionTaskFinished({
      taskId: run1.sessionTaskId!,
      sessionId: run1.sessionId!,
      status: 'failed',
      error: 'flaky',
      startedAt: Date.now(),
      endedAt: Date.now(),
      durationMs: 10,
      reply: '',
      cost: 0,
      usageIncomplete: false,
      children: 0
    })

    const ack2 = await manager.followupTask(ack1.taskId, 'Try again', 'full-access')
    await manager.waitForLaunch(ack2.runId)

    // Replay stale callback from run1: must be ignored while run2 is running.
    await manager.handleSessionTaskFinished({
      taskId: run1.sessionTaskId!,
      sessionId: run1.sessionId!,
      status: 'completed',
      startedAt: Date.now(),
      endedAt: Date.now(),
      durationMs: 20,
      reply: 'stale',
      cost: 0,
      usageIncomplete: false,
      children: 0
    })

    await manager.markDeliveryState(ack1.taskId, ack1.runId, 'delivered', { noticeId: 'old' })
    const current = (await manager.getTask(ack1.taskId))!
    expect(current.delivery.state).toBe('pending')
    expect(current.status).toBe('running')
    expect(current.activeRunId).toBe(ack2.runId)
  })

  test('recovers interrupted runs on startup and rejects damaged tasks.json without overwriting', async () => {
    const { store, manager, projectCwd } = await makeFixture()
    const ack = await manager.delegateTask({
      projectCwd,
      title: 'Long run',
      intent: 'Work',
      mode: 'write'
    }, 'full-access')
    await manager.waitForLaunch(ack.runId)

    const recovered = await manager.initialize()
    expect(recovered[0].status).toBe('interrupted')
    expect(recovered[0].runs[0].status).toBe('interrupted')
    expect(recovered[0].activeRunId).toBeUndefined()

    // Corrupt tasks.json and verify readTasks fails fast instead of wiping data.
    await writeFile(join(store.dir, 'tasks.json'), '{broken json', 'utf8')
    await expect(store.readTasks()).rejects.toThrow()
  })

  test('a busy result after notice preparation remains pending and can be delivered', async () => {
    const { noticeQueue, projectCwd } = await makeFixture()
    let attempts = 0
    noticeQueue.setDeliverer({
      isUserBusy: () => false,
      deliverBatch: async () => ({ state: ++attempts === 1 ? 'deferred' : 'delivered' })
    })
    await noticeQueue.enqueue({ noticeId: 'race', kind: 'task_completed', taskId: 't', runId: 'r', projectCwd })
    await noticeQueue.drain()
    expect(noticeQueue.list().find((n) => n.noticeId === 'race')?.state).toBe('pending')
    await noticeQueue.drain()
    expect(noticeQueue.list().find((n) => n.noticeId === 'race')?.state).toBe('delivered')
  })

  test('a Git write retry after worktree creation fails never launches in the project checkout', async () => {
    let creates = 0
    const { manager, projectCwd, launched } = await makeFixture({
      createWorktree: async (project, options) => {
        if (++creates === 1) throw new Error('creation failed')
        return { cwd: `${project}-isolated`, branch: 'bot/retry', isPrimary: false, missing: false, locked: false, managed: true, owner: options.owner }
      }
    })
    const first = await manager.delegateTask({ projectCwd, title: 'Write', intent: 'Edit', mode: 'write' }, 'full-access')
    await manager.waitForLaunch(first.runId)
    expect(launched).toHaveLength(0)
    const retry = await manager.followupTask(first.taskId, 'Retry', 'full-access')
    await manager.waitForLaunch(retry.runId)
    const task = await manager.getTask(first.taskId)
    expect(task?.workspace.kind).toBe('worktree')
    expect(launched.map(({ cwd }) => cwd)).toEqual([`${task?.projectCwd}-isolated`])
  })

  test('notice queue yields while user is busy and coalesces pending notices once idle', async () => {
    const { noticeQueue, projectCwd } = await makeFixture()
    let userBusy = true
    const batches: BotNotice[][] = []

    noticeQueue.setDeliverer({
      isUserBusy: () => userBusy,
      deliverBatch: async (batch) => {
        batches.push(batch)
        return { state: 'delivered' }
      }
    })

    await noticeQueue.enqueue({
      noticeId: 'n1',
      kind: 'task_completed',
      taskId: 't1',
      runId: 'r1',
      projectCwd,
      summary: 'done 1'
    })
    await noticeQueue.enqueue({
      noticeId: 'n2',
      kind: 'task_completed',
      taskId: 't2',
      runId: 'r2',
      projectCwd,
      summary: 'done 2'
    })
    // Duplicate noticeId must be ignored.
    await noticeQueue.enqueue({
      noticeId: 'n2',
      kind: 'task_completed',
      taskId: 't2',
      runId: 'r2',
      projectCwd,
      summary: 'done 2 dup'
    })

    await new Promise((r) => setTimeout(r, 60))
    expect(batches).toHaveLength(0)

    userBusy = false
    noticeQueue.notifyUserIdle()
    await new Promise((r) => setTimeout(r, 80))

    expect(batches).toHaveLength(1)
    expect(batches[0].map((n) => n.noticeId)).toEqual(['n1', 'n2'])
    expect(noticeQueue.pendingCount()).toBe(0)
  })

  test('enforces non-Git write confirmation and serializes concurrent writes to same non-Git dir', async () => {
    const { manager, projectCwd } = await makeFixture({
      isGitRepo: async () => false
    })

    // Unconfirmed non-Git write fails cleanly with task_start_failed.
    const unconfirmed = await manager.delegateTask({
      projectCwd,
      title: 'Write non-git',
      intent: 'Edit',
      mode: 'write'
    }, 'full-access')
    await manager.waitForLaunch(unconfirmed.runId)
    expect((await manager.getTask(unconfirmed.taskId))?.status).toBe('failed')

    // Confirmed non-Git write holds mutex; second concurrent write to same dir fails fast.
    const first = await manager.delegateTask({
      projectCwd,
      title: 'Write 1',
      intent: 'Edit 1',
      mode: 'write',
      confirmSharedNonGitWrite: true
    }, 'full-access')
    await manager.waitForLaunch(first.runId)
    expect((await manager.getTask(first.taskId))?.status).toBe('running')

    const second = await manager.delegateTask({
      projectCwd,
      title: 'Write 2',
      intent: 'Edit 2',
      mode: 'write',
      confirmSharedNonGitWrite: true
    }, 'full-access')
    await manager.waitForLaunch(second.runId)
    const secondTask = await manager.getTask(second.taskId)
    expect(secondTask?.status).toBe('failed')
    expect(secondTask?.latestReceipt?.errorMessage).toContain('already running')
  })

  test('cleanup safety check flags dirty or unmerged worktree for mandatory confirmation', async () => {
    const { manager, projectCwd } = await makeFixture({
      worktreeDeletionInfo: async (_proj, cwd) => ({
        worktree: {
          cwd,
          branch: 'bot/dirty-123456',
          isPrimary: false,
          locked: false,
          missing: false,
          managed: true,
          owner: { kind: 'bot', taskId: currentTaskId }
        },
        dirty: true,
        unmerged: true
      })
    })
    let currentTaskId = ''
    const ack = await manager.delegateTask({
      projectCwd,
      title: 'Dirty task',
      intent: 'Edit',
      mode: 'write'
    }, 'full-access')
    currentTaskId = ack.taskId
    await manager.waitForLaunch(ack.runId)
    const run = (await manager.getTask(ack.taskId))!.runs[0]
    await manager.handleSessionTaskFinished({
      taskId: run.sessionTaskId!,
      sessionId: run.sessionId!,
      status: 'completed',
      startedAt: Date.now(),
      endedAt: Date.now(),
      durationMs: 10,
      reply: 'done',
      cost: 0,
      usageIncomplete: false,
      children: 0
    })

    const safety = await manager.checkWorktreeCleanupSafety(ack.taskId)
    expect(safety.dirty).toBe(true)
    expect(safety.unmerged).toBe(true)
    expect(safety.needsForceConfirm).toBe(true)
  })

  test('bot-initiated stop emits task_stopped (not task_stopped_by_user) and read-only receipts skip git diff collection', async () => {
    const collectCalls: Array<{ cwd: string; collectChanges?: boolean }> = []
    const { manager, noticeQueue, projectCwd } = await makeFixture({
      collectReceipt: async (cwd, summary, opts) => {
        collectCalls.push({ cwd, collectChanges: opts?.collectChanges })
        return emptyReceipt(summary)
      }
    })

    // 1. Bot-initiated stop on write task
    const writeAck = await manager.delegateTask({
      projectCwd,
      title: 'Bot-stopped task',
      intent: 'Do work',
      mode: 'write'
    }, 'full-access')
    await manager.waitForLaunch(writeAck.runId)
    const writeRun = (await manager.getTask(writeAck.taskId))!.runs[0]
    await manager.handleBeforeSessionStop(writeRun.sessionId!, 'bot')
    await manager.handleSessionTaskFinished({
      taskId: writeRun.sessionTaskId!,
      sessionId: writeRun.sessionId!,
      status: 'aborted',
      stopOrigin: 'bot',
      startedAt: Date.now(),
      endedAt: Date.now(),
      durationMs: 10,
      reply: '',
      cost: 0,
      usageIncomplete: false,
      children: 0
    })
    await manager.handleAfterSessionStop(writeRun.sessionId!)
    const stopNotice = noticeQueue.list().find((n) => n.taskId === writeAck.taskId)
    expect(stopNotice?.kind).toBe('task_stopped')
    expect(stopNotice?.stopOrigin).toBe('bot')
    expect(collectCalls.at(-1)?.collectChanges).toBe(true)

    // 2. Read-only task skips git diff collection
    const readAck = await manager.delegateTask({
      projectCwd,
      title: 'Read package.json',
      intent: 'Read version',
      mode: 'read'
    }, 'full-access')
    await manager.waitForLaunch(readAck.runId)
    const readRun = (await manager.getTask(readAck.taskId))!.runs[0]
    await manager.handleSessionTaskFinished({
      taskId: readRun.sessionTaskId!,
      sessionId: readRun.sessionId!,
      status: 'completed',
      startedAt: Date.now(),
      endedAt: Date.now(),
      durationMs: 10,
      reply: 'v0.0.0',
      cost: 0,
      usageIncomplete: false,
      children: 0
    })
    expect(collectCalls.at(-1)?.collectChanges).toBe(false)
  })

  test('a tool-owned stop returns the settled receipt without a second Notice', async () => {
    const { manager, noticeQueue, projectCwd, cleanedProcesses } = await makeFixture()
    const { taskId, runId } = await manager.delegateTask({
      projectCwd, title: 'Stop via tool', intent: 'Work', mode: 'write'
    }, 'full-access')
    await manager.waitForLaunch(runId)

    const result = await manager.stopTaskFromTool(taskId)
    expect(result.runId).toBe(runId)
    expect(result.task.status).toBe('stopped')
    expect(result.receipt).toEqual(result.task.latestReceipt)
    expect(result.receipt?.summary).toContain('Stopped (bot)')
    expect(cleanedProcesses).toEqual([result.task.runs[0].sessionId!])
    expect(noticeQueue.list()).toEqual([])
    expect((await manager.stopTaskFromTool(taskId)).receipt).toBeUndefined()
  })

  test('a tool stop during backend launch stops the late session and returns that run’s receipt', async () => {
    let unblock!: () => void
    let launching!: () => void
    let stopping!: () => void
    const launchStarted = new Promise<void>((resolve) => { launching = resolve })
    const launchGate = new Promise<void>((resolve) => { unblock = resolve })
    const stopRequested = new Promise<void>((resolve) => { stopping = resolve })
    const stopped: string[] = []
    const { manager, projectCwd, noticeQueue, cleanedProcesses } = await makeFixture({
      launchBackendSession: async () => {
        launching()
        await launchGate
        return { sessionId: 'late-session', sessionTaskId: 'late-task' }
      },
      stopSession: async (sessionId) => { stopped.push(sessionId) },
      onTaskUpdated: (task) => {
        if (task.runs[0].status === 'stopping') stopping()
      }
    })
    const { taskId, runId } = await manager.delegateTask({
      projectCwd, title: 'Late session', intent: 'Work', mode: 'write'
    }, 'full-access')
    await launchStarted
    const stop = manager.stopTaskFromTool(taskId)
    await stopRequested
    expect(stopped).toEqual([])
    unblock()

    const result = await stop
    expect(result.runId).toBe(runId)
    expect(result.receipt).toEqual(result.task.latestReceipt)
    expect(result.task.status).toBe('stopped')
    expect(stopped).toEqual(['late-session'])
    expect(cleanedProcesses).toEqual(stopped)
    expect(noticeQueue.list()).toEqual([])
  })

  test('a tool call joining a manual stop does not claim its receipt or silence its Notice', async () => {
    const { manager, noticeQueue, projectCwd } = await makeFixture()
    const { taskId, runId } = await manager.delegateTask({
      projectCwd, title: 'Manual stop', intent: 'Work', mode: 'write'
    }, 'full-access')
    await manager.waitForLaunch(runId)
    const run = (await manager.getTask(taskId))!.runs[0]
    await manager.handleBeforeSessionStop(run.sessionId!, 'user')
    const joined = manager.stopTaskFromTool(taskId)
    await manager.handleBeforeSessionStop(run.sessionId!, 'takeover')
    await manager.handleSessionTaskFinished({
      taskId: run.sessionTaskId!, sessionId: run.sessionId!, status: 'aborted',
      stopOrigin: 'takeover', startedAt: run.startedAt, durationMs: 0, reply: '',
      cost: 0, usageIncomplete: false, children: 0
    })
    await manager.handleAfterSessionStop(run.sessionId!)
    expect(noticeQueue.list()).toEqual([])
    await manager.handleAfterSessionStop(run.sessionId!)

    expect((await joined).receipt).toBeUndefined()
    expect((await manager.getTask(taskId))?.runs[0].stopOrigin).toBe('user')
    expect(noticeQueue.list().map(({ kind, stopOrigin }) => ({ kind, stopOrigin })))
      .toEqual([{ kind: 'task_stopped_by_user', stopOrigin: 'user' }])
  })

  test('takeover waits for coordinator and cleanup, sharing finalization with the tracker callback', async () => {
    let manager!: BotTaskManager
    let finish!: SessionAgentTask
    let allowStop!: () => void
    let reachedStop!: () => void
    const stopEntered = new Promise<void>((resolve) => { reachedStop = resolve })
    const stopGate = new Promise<void>((resolve) => { allowStop = resolve })
    let allowCleanup!: () => void
    let reachedCleanup!: () => void
    const cleanupEntered = new Promise<void>((resolve) => { reachedCleanup = resolve })
    const cleanupGate = new Promise<void>((resolve) => { allowCleanup = resolve })
    const order: string[] = []
    const fixture = await makeFixture({
      isGitRepo: async () => false,
      stopSession: async () => {
        await manager.handleSessionTaskFinished(finish)
        reachedStop()
        await stopGate
        order.push('stopped')
      },
      cleanupSessionProcesses: async () => {
        reachedCleanup()
        await cleanupGate
        order.push('processes')
      },
      collectReceipt: async (_cwd, summary) => {
        order.push('receipt')
        return emptyReceipt(summary)
      },
      restoreSessionCapabilities: () => { order.push('capabilities') },
      onTaskUpdated: (task) => {
        if (task.status === 'taken_over') order.push('published')
      }
    })
    manager = fixture.manager
    const delegate = () => manager.delegateTask({
      projectCwd: fixture.projectCwd, title: 'Takeover', intent: 'Work', mode: 'write',
      confirmSharedNonGitWrite: true
    }, 'full-access')
    const { taskId, runId } = await delegate()
    await manager.waitForLaunch(runId)
    const run = (await manager.getTask(taskId))!.runs[0]
    finish = {
      taskId: run.sessionTaskId!, sessionId: run.sessionId!, status: 'aborted',
      stopOrigin: 'user', startedAt: run.startedAt, durationMs: 0, reply: 'Partial work',
      cost: 0, usageIncomplete: false, children: 0
    }

    const takeover = manager.takeoverTask(taskId)
    await stopEntered
    expect(order).toEqual([])
    allowStop()
    await cleanupEntered
    const blocked = await delegate()
    await manager.waitForLaunch(blocked.runId)
    expect((await manager.getTask(blocked.taskId))?.status).toBe('failed')
    expect((await manager.getTask(taskId))?.activeRunId).toBe(runId)
    allowCleanup()
    const settled = await takeover
    expect(order).toEqual(['stopped', 'processes', 'receipt', 'capabilities', 'published'])
    expect(settled.runs[0].stopOrigin).toBe('takeover')
    expect(settled.latestReceipt?.summary).toBe('Partial work')
    await manager.handleSessionTaskFinished(finish)
    const notices = fixture.noticeQueue.list().filter((n) => n.taskId === taskId)
    expect(notices.map((n) => n.kind)).toEqual(['task_taken_over'])
    expect(notices[0].receipt).toEqual(settled.latestReceipt)
    const next = await delegate()
    await manager.waitForLaunch(next.runId)
    expect((await manager.getTask(next.taskId))?.status).toBe('running')
  })

  test('takeover without a tracker callback still creates a receipt and never clobbers settled runs on recovery', async () => {
    const { manager, store, projectCwd, restoredCapabilities, noticeQueue } = await makeFixture()
    const ack = await manager.delegateTask({
      projectCwd,
      title: 'Takeover run',
      intent: 'Long work',
      mode: 'write'
    }, 'full-access')
    await manager.waitForLaunch(ack.runId)

    const takenOver = await manager.takeoverTask(ack.taskId)
    expect(takenOver.status).toBe('taken_over')
    expect(takenOver.activeRunId).toBeUndefined()
    expect(takenOver.runs[0].status).toBe('stopped')
    expect(takenOver.runs[0].stopOrigin).toBe('takeover')
    expect(typeof takenOver.runs[0].endedAt).toBe('number')
    expect(takenOver.latestReceipt?.summary).toContain('Stopped (takeover)')
    expect(restoredCapabilities).toEqual([takenOver.runs[0].sessionId!])
    expect(noticeQueue.list().map((n) => n.kind)).toEqual(['task_taken_over'])

    // Simulate legacy data where an older run on a settled stopped task was left in `stopping`.
    await store.updateTasks((tasks) => {
      const target = tasks.find((t) => t.taskId === ack.taskId)!
      target.status = 'stopped'
      target.runs[0].status = 'stopping'
      return { tasks, result: undefined }
    })

    const recovered = await store.recoverInterruptedRuns()
    expect(recovered).toHaveLength(0)
    const after = await manager.getTask(ack.taskId)
    expect(after?.status).toBe('stopped')
    expect(after?.runs[0].status).toBe('stopped')
  })

  test('cleanupWorktree records cleanedUpAt and prevents duplicate cleanup or follow-up on deleted worktree', async () => {
    let taskId = ''
    const { manager, projectCwd } = await makeFixture({
      worktreeDeletionInfo: async (_proj, cwd) => ({
        worktree: {
          cwd,
          branch: 'bot/clean-123456',
          isPrimary: false,
          locked: false,
          missing: false,
          managed: true,
          owner: { kind: 'bot', taskId }
        },
        dirty: false,
        unmerged: false
      })
    })
    const ack = await manager.delegateTask({
      projectCwd,
      title: 'Clean task',
      intent: 'Edit',
      mode: 'write'
    }, 'full-access')
    taskId = ack.taskId
    await manager.waitForLaunch(ack.runId)
    const run = (await manager.getTask(ack.taskId))!.runs[0]
    await manager.handleSessionTaskFinished({
      taskId: run.sessionTaskId!,
      sessionId: run.sessionId!,
      status: 'completed',
      startedAt: Date.now(),
      endedAt: Date.now(),
      durationMs: 10,
      reply: 'done',
      cost: 0,
      usageIncomplete: false,
      children: 0
    })

    await manager.cleanupWorktree(ack.taskId)
    const after = await manager.getTask(ack.taskId)
    expect(typeof after?.workspace.cleanedUpAt).toBe('number')
    await expect(manager.checkWorktreeCleanupSafety(ack.taskId)).rejects.toThrow('already been cleaned up')
    await expect(manager.followupTask(ack.taskId, 'more work', 'full-access')).rejects.toThrow('cleaned up')
  })

  test('BotStore preserves persisted model, avatar, delegateModel, delegateThinkingLevel, and thinkingLevel and rejects invalid fields', async () => {
    const { store } = await makeFixture()
    await store.ensureState('bot-test-persist')
    await store.updateState((s) => ({
      ...s,
      avatar: 'cat',
      model: { provider: 'anthropic', id: 'claude-sonnet-4-5' },
      thinkingLevel: 'high',
      delegateModel: { provider: 'google', id: 'gemini-2.5-pro' },
      delegateThinkingLevel: 'medium'
    }))
    const reloaded = await store.readState()
    expect(reloaded?.sessionId).toBe('bot-test-persist')
    expect(reloaded?.avatar).toBe('cat')
    expect(reloaded?.model).toEqual({ provider: 'anthropic', id: 'claude-sonnet-4-5' })
    expect(reloaded?.thinkingLevel).toBe('high')
    expect(reloaded?.delegateModel).toEqual({ provider: 'google', id: 'gemini-2.5-pro' })
    expect(reloaded?.delegateThinkingLevel).toBe('medium')

    // Invalid avatar, delegateModel, or delegateThinkingLevel fails fast instead of silently resetting.
    const statePath = join(store.dir, 'state.json')
    const valid = JSON.parse(await readFile(statePath, 'utf8'))
    await writeFile(statePath, JSON.stringify({ ...valid, avatar: 'not-a-real-avatar' }))
    await expect(store.readState()).rejects.toThrow('Invalid bot state.json')
    await writeFile(statePath, JSON.stringify({ ...valid, delegateModel: { provider: 'google', id: '' } }))
    await expect(store.readState()).rejects.toThrow('Invalid bot state.json')
    await writeFile(statePath, JSON.stringify({ ...valid, delegateThinkingLevel: 'ultra' }))
    await expect(store.readState()).rejects.toThrow('Invalid bot state.json')
  })

  test('delegation and followup follow model & thinking precedence: per-run override > Bot settings > Pig global default', async () => {
    const launchedRuns: Array<{ runId: string; modelOverride?: { provider: string; id: string }; thinkingOverride?: string }> = []
    let counter = 0
    const { manager, store, projectCwd } = await makeFixture({
      launchBackendSession: async (params) => {
        launchedRuns.push({ runId: params.run.runId, modelOverride: params.modelOverride, thinkingOverride: params.thinkingOverride })
        counter += 1
        return { sessionId: `sess-${counter}`, sessionTaskId: `st-${counter}` }
      }
    })
    await store.ensureState('bot-model-precedence')

    // 1. Neither Bot setting nor per-run override -> passes undefined so backend inherits Pig global default.
    const ackGlobal = await manager.delegateTask({
      projectCwd, title: 'Global default', intent: 'Use Pig global default', mode: 'read'
    }, 'full-access')
    await manager.waitForLaunch(ackGlobal.runId)
    expect(launchedRuns.at(-1)?.modelOverride).toBeUndefined()
    expect(launchedRuns.at(-1)?.thinkingOverride).toBeUndefined()

    // Finish first task so we can test followup later.
    const run1 = (await manager.getTask(ackGlobal.taskId))!.runs[0]
    await manager.handleSessionTaskFinished({
      taskId: run1.sessionTaskId!, sessionId: run1.sessionId!, status: 'completed',
      startedAt: run1.startedAt, endedAt: Date.now(), durationMs: 10, reply: 'done',
      cost: 0, usageIncomplete: false, children: 0
    })

    // 2. Configure Bot default execution model & thinking -> applies to new delegations and followups.
    await store.updateState((s) => ({
      ...s,
      delegateModel: { provider: 'google', id: 'gemini-2.5-pro' },
      delegateThinkingLevel: 'high'
    }))
    const ackBotDefault = await manager.delegateTask({
      projectCwd, title: 'Bot setting default', intent: 'Use Bot setting', mode: 'read'
    }, 'full-access')
    await manager.waitForLaunch(ackBotDefault.runId)
    expect(launchedRuns.at(-1)?.modelOverride).toEqual({ provider: 'google', id: 'gemini-2.5-pro' })
    expect(launchedRuns.at(-1)?.thinkingOverride).toBe('high')

    const ackFollowupDefault = await manager.followupTask(ackGlobal.taskId, 'Continue with Bot setting', 'full-access')
    await manager.waitForLaunch(ackFollowupDefault.runId)
    expect(launchedRuns.at(-1)?.modelOverride).toEqual({ provider: 'google', id: 'gemini-2.5-pro' })
    expect(launchedRuns.at(-1)?.thinkingOverride).toBe('high')

    const run2 = (await manager.getTask(ackGlobal.taskId))!.runs[1]
    await manager.handleSessionTaskFinished({
      taskId: run2.sessionTaskId!, sessionId: run2.sessionId!, status: 'completed',
      startedAt: run2.startedAt, endedAt: Date.now(), durationMs: 10, reply: 'done',
      cost: 0, usageIncomplete: false, children: 0
    })

    // 3. Explicit per-run modelOverride beats Bot setting and does NOT leak Bot's old-model thinking level.
    const ackExplicitModelOnly = await manager.delegateTask({
      projectCwd, title: 'Explicit model override', intent: 'Use Claude for this task', mode: 'read',
      modelOverride: { provider: 'anthropic', id: 'claude-sonnet-4-5' }
    }, 'full-access')
    await manager.waitForLaunch(ackExplicitModelOnly.runId)
    expect(launchedRuns.at(-1)?.modelOverride).toEqual({ provider: 'anthropic', id: 'claude-sonnet-4-5' })
    expect(launchedRuns.at(-1)?.thinkingOverride).toBeUndefined()

    // Explicit per-run modelOverride + thinkingOverride both win on followup too.
    const ackFollowupExplicit = await manager.followupTask(ackGlobal.taskId, 'Retry with Claude low', 'full-access', {
      modelOverride: { provider: 'anthropic', id: 'claude-sonnet-4-5' },
      thinkingOverride: 'low'
    })
    await manager.waitForLaunch(ackFollowupExplicit.runId)
    expect(launchedRuns.at(-1)?.modelOverride).toEqual({ provider: 'anthropic', id: 'claude-sonnet-4-5' })
    expect(launchedRuns.at(-1)?.thinkingOverride).toBe('low')

    // 4. Clearing Bot delegateModel reverts future runs to Pig global default (even if a stale thinking field existed).
    await store.updateState((s) => {
      const next = { ...s }
      delete next.delegateModel
      return next
    })
    const ackCleared = await manager.delegateTask({
      projectCwd, title: 'Back to global', intent: 'Use global again', mode: 'read'
    }, 'full-access')
    await manager.waitForLaunch(ackCleared.runId)
    expect(launchedRuns.at(-1)?.modelOverride).toBeUndefined()
    expect(launchedRuns.at(-1)?.thinkingOverride).toBeUndefined()
  })

  test('stopTask during launchRunAsync store.readState aborts before launchBackendSession and settles as stopped', async () => {
    let launchCalls = 0
    let enteredStopping!: () => void
    const stoppingEntered = new Promise<void>((resolve) => { enteredStopping = resolve })
    const { manager, store, projectCwd } = await makeFixture({
      onTaskUpdated: (task) => {
        if (task.runs[0]?.status === 'stopping') enteredStopping()
      },
      launchBackendSession: async () => {
        launchCalls += 1
        return { sessionId: 'sess-should-not-start', sessionTaskId: 'st-should-not-start' }
      }
    })
    await store.ensureState('bot-stop-during-readstate')

    let enteredReadState!: () => void
    const readStateEntered = new Promise<void>((resolve) => { enteredReadState = resolve })
    let releaseReadState!: () => void
    const readStateGate = new Promise<void>((resolve) => { releaseReadState = resolve })

    const origReadState = store.readState.bind(store)
    let intercepted = false
    store.readState = async () => {
      if (!intercepted) {
        intercepted = true
        enteredReadState()
        await readStateGate
      }
      return origReadState()
    }

    const ack = await manager.delegateTask({
      projectCwd,
      title: 'Stop while reading Bot state',
      intent: 'Should not launch after stop',
      mode: 'read'
    }, 'full-access')

    await readStateEntered
    const stopPromise = manager.stopTask(ack.taskId, 'user')
    await stoppingEntered
    releaseReadState()

    const stopped = await stopPromise
    await manager.waitForLaunch(ack.runId)

    expect(launchCalls).toBe(0)
    expect(stopped.status).toBe('stopped')
    expect(stopped.runs[0].status).toBe('stopped')
    const finalTask = await manager.getTask(ack.taskId)
    expect(finalTask?.status).toBe('stopped')
    expect(finalTask?.runs[0].status).toBe('stopped')
    expect(finalTask?.runs[0].sessionId).toBeUndefined()
  })

  test('newProject returns Fast Ack while initializing Git asynchronously, writes in place without worktrees, and isolates later independent tasks', async () => {
    let createWorktreeCalls = 0
    let markInitEntered!: () => void
    let releaseInit!: () => void
    const initEntered = new Promise<void>((r) => { markInitEntered = r })
    const initGate = new Promise<void>((r) => { releaseInit = r })

    const { realpath } = await import('node:fs/promises')
    const rawNpDir = await mkdtemp(join(tmpdir(), 'pig-bot-np-'))
    temps.push(rawNpDir)
    const realDir = await realpath(rawNpDir)
    const { manager, launched } = await makeFixture({
      isAllowedProject: async (cwd) => cwd.startsWith(join(realDir, 'pig_projects')),
      reserveNewProject: async (input) => ({
        cwd: join(realDir, 'pig_projects', input.folderName),
        createdTarget: true
      }),
      initializeNewProject: async () => {
        markInitEntered()
        await initGate
      },
      createWorktree: async (_proj, opts) => {
        createWorktreeCalls += 1
        return {
          cwd: join(realDir, 'wt', `bot-${opts.owner!.taskId.slice(0, 6)}`),
          branch: `bot/feat-${opts.owner!.taskId.slice(0, 6)}`,
          isPrimary: false,
          locked: false,
          missing: false,
          managed: true,
          owner: opts.owner
        }
      }
    })

    const expectedCwd = join(realDir, 'pig_projects', 'snake-game')
    const ack = await manager.delegateTask({
      newProject: { folderName: 'snake-game' },
      title: 'Build Snake Game',
      intent: 'Create HTML5 snake game',
      mode: 'write'
    }, 'full-access')

    expect(ack.status).toBe('starting')
    expect(ack.projectCwd).toBe(expectedCwd)
    expect(launched).toHaveLength(0)

    await initEntered
    releaseInit()
    await manager.waitForLaunch(ack.runId)

    const running = await manager.getTask(ack.taskId)
    expect(running?.status).toBe('running')
    expect(running?.workspace.kind).toBe('project')
    expect(running?.workspace.cwd).toBe(expectedCwd)
    expect(running?.workspace.branch).toBe('main')
    expect(createWorktreeCalls).toBe(0)
    expect(launched[0]?.cwd).toBe(expectedCwd)

    // Settle initial run as stopped, then follow up on the same task: stays in-place in expectedCwd!
    await manager.handleSessionTaskFinished({
      taskId: 'stask-1',
      sessionId: 'sess-1',
      status: 'aborted',
      stopOrigin: 'user'
    } as SessionAgentTask)

    const followupAck = await manager.followupTask(ack.taskId, 'Add leaderboard', 'full-access')
    await manager.waitForLaunch(followupAck.runId)
    expect(createWorktreeCalls).toBe(0)
    expect(launched[1]?.cwd).toBe(expectedCwd)

    await manager.handleSessionTaskFinished({
      taskId: 'stask-2',
      sessionId: 'sess-2',
      status: 'completed',
      reply: 'Done'
    } as SessionAgentTask)

    // A subsequent independent write task on the now-existing Git project uses an isolated worktree as normal.
    const laterAck = await manager.delegateTask({
      projectCwd: expectedCwd,
      title: 'Refactor controls',
      intent: 'Add gamepad support',
      mode: 'write'
    }, 'full-access')
    await manager.waitForLaunch(laterAck.runId)
    expect(createWorktreeCalls).toBe(1)
    const laterTask = await manager.getTask(laterAck.taskId)
    expect(laterTask?.workspace.kind).toBe('worktree')
  })

  test('inPlace write task modifies existing Git checkout directly, serializes concurrent inPlace writes, and keeps worktree as default', async () => {
    let createWorktreeCalls = 0
    const { manager, projectCwd, launched } = await makeFixture({
      resolveBranch: async () => 'main',
      createWorktree: async (_proj, opts) => {
        createWorktreeCalls += 1
        return {
          cwd: `/tmp/wt-${opts.owner!.taskId.slice(0, 6)}`,
          branch: `bot/isolated-${opts.owner!.taskId.slice(0, 6)}`,
          isPrimary: false,
          locked: false,
          missing: false,
          managed: true,
          owner: opts.owner
        }
      }
    })

    await expect(manager.delegateTask({
      projectCwd,
      title: 'Read with inPlace',
      intent: 'Inspect',
      mode: 'read',
      inPlace: true
    }, 'full-access')).rejects.toThrow(/inPlace/)

    const inPlaceAck = await manager.delegateTask({
      projectCwd,
      title: 'Update main directly',
      intent: 'Edit README on main',
      mode: 'write',
      inPlace: true
    }, 'full-access')
    await manager.waitForLaunch(inPlaceAck.runId)

    const inPlaceTask = await manager.getTask(inPlaceAck.taskId)
    expect(inPlaceTask?.status).toBe('running')
    expect(inPlaceTask?.workspace).toMatchObject({
      kind: 'project',
      cwd: inPlaceTask!.projectCwd,
      inPlace: true,
      branch: 'main'
    })
    expect(createWorktreeCalls).toBe(0)
    expect(launched[0]?.cwd).toBe(inPlaceTask!.projectCwd)

    const concurrentInPlace = await manager.delegateTask({
      projectCwd,
      title: 'Conflicting direct edit',
      intent: 'Also edit main directly',
      mode: 'write',
      inPlace: true
    }, 'full-access')
    await manager.waitForLaunch(concurrentInPlace.runId)
    const failedConcurrent = await manager.getTask(concurrentInPlace.taskId)
    expect(failedConcurrent?.status).toBe('failed')
    expect(failedConcurrent?.latestReceipt?.errorMessage).toContain('already running')

    await manager.handleSessionTaskFinished({
      taskId: 'stask-1',
      sessionId: 'sess-1',
      status: 'completed',
      startedAt: Date.now(),
      endedAt: Date.now(),
      durationMs: 10,
      reply: 'Updated main',
      cost: 0,
      usageIncomplete: false,
      children: 0
    })

    const followupAck = await manager.followupTask(inPlaceAck.taskId, 'Polish wording on main', 'full-access')
    await manager.waitForLaunch(followupAck.runId)
    expect(createWorktreeCalls).toBe(0)
    expect(launched[1]?.cwd).toBe(inPlaceTask!.projectCwd)
    expect((await manager.getTask(inPlaceAck.taskId))?.workspace).toMatchObject({
      kind: 'project',
      cwd: inPlaceTask!.projectCwd,
      inPlace: true,
      branch: 'main'
    })

    await manager.handleSessionTaskFinished({
      taskId: 'stask-2',
      sessionId: 'sess-2',
      status: 'completed',
      startedAt: Date.now(),
      endedAt: Date.now(),
      durationMs: 10,
      reply: 'Polished',
      cost: 0,
      usageIncomplete: false,
      children: 0
    })

    const defaultWriteAck = await manager.delegateTask({
      projectCwd,
      title: 'Feature in worktree',
      intent: 'Develop feature in isolated worktree',
      mode: 'write'
    }, 'full-access')
    await manager.waitForLaunch(defaultWriteAck.runId)
    expect(createWorktreeCalls).toBe(1)
    expect((await manager.getTask(defaultWriteAck.taskId))?.workspace.kind).toBe('worktree')

    const nonGit = await makeFixture({ isGitRepo: async () => false })
    const unconfirmedInPlace = await nonGit.manager.delegateTask({
      projectCwd: nonGit.projectCwd,
      title: 'Non-git inPlace without confirm',
      intent: 'Attempt write',
      mode: 'write',
      inPlace: true
    }, 'full-access')
    await nonGit.manager.waitForLaunch(unconfirmedInPlace.runId)
    expect((await nonGit.manager.getTask(unconfirmedInPlace.taskId))?.status).toBe('failed')
  })
})
