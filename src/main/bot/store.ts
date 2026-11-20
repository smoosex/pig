/**
 * Atomic JSON / JSONL persistence for Pig Bot state, task ledger, timeline, and crash recovery.
 * Parse or I/O errors fail fast and never overwrite damaged files with defaults.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, appendFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import type { BotState, BotSurface, BotTask, BotTimelineItem } from '../../shared/bot'
import { writeFileAtomic } from '../atomic-write'

interface TasksFile {
  version: 1
  tasks: BotTask[]
}

export class BotStore {
  private lock: Promise<unknown> = Promise.resolve()
  private readonly statePath: string
  private readonly tasksPath: string
  private readonly timelinePath: string
  private readonly noticesPath: string

  constructor(readonly dir: string) {
    this.statePath = join(dir, 'state.json')
    this.tasksPath = join(dir, 'tasks.json')
    this.timelinePath = join(dir, 'timeline.jsonl')
    this.noticesPath = join(dir, 'notices.jsonl')
  }

  get noticesFilePath(): string {
    return this.noticesPath
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.lock.then(fn)
    this.lock = task.catch(() => {})
    return task
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
  }

  async readState(): Promise<BotState | null> {
    try {
      const raw = JSON.parse(await readFile(this.statePath, 'utf8')) as Partial<BotState>
      if (!raw || typeof raw !== 'object' || raw.version !== 1 || typeof raw.sessionId !== 'string' || !raw.sessionId) {
        throw new Error('Invalid bot state.json')
      }
      const lastSurface: BotSurface = raw.lastSurface === 'bot' ? 'bot' : 'workspace'
      const archivedSessions = Array.isArray(raw.archivedSessions) ? raw.archivedSessions : []
      return {
        version: 1,
        sessionId: raw.sessionId,
        cwd: typeof raw.cwd === 'string' && raw.cwd ? raw.cwd : this.dir,
        lastSurface,
        ...(raw.model && typeof raw.model.provider === 'string' && typeof raw.model.id === 'string'
          ? { model: { provider: raw.model.provider, id: raw.model.id } }
          : {}),
        ...(typeof raw.thinkingLevel === 'string' ? { thinkingLevel: raw.thinkingLevel } : {}),
        archivedSessions,
        createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
        updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async ensureState(initialSessionId?: string): Promise<BotState> {
    return this.serialize(async () => {
      const existing = await this.readState()
      if (existing) return existing
      await this.ensureDir()
      const now = Date.now()
      const state: BotState = {
        version: 1,
        sessionId: initialSessionId || `bot-${randomUUID()}`,
        cwd: this.dir,
        lastSurface: 'workspace',
        archivedSessions: [],
        createdAt: now,
        updatedAt: now
      }
      await writeFileAtomic(this.statePath, `${JSON.stringify(state, null, 2)}\n`)
      return state
    })
  }

  async updateState(mutate: (current: BotState) => BotState): Promise<BotState> {
    return this.serialize(async () => {
      const existing = await this.readState()
      const now = Date.now()
      const base: BotState = existing ?? {
        version: 1,
        sessionId: `bot-${randomUUID()}`,
        cwd: this.dir,
        lastSurface: 'workspace',
        archivedSessions: [],
        createdAt: now,
        updatedAt: now
      }
      const next = { ...mutate(structuredClone(base)), version: 1 as const, updatedAt: Date.now() }
      await this.ensureDir()
      await writeFileAtomic(this.statePath, `${JSON.stringify(next, null, 2)}\n`)
      return next
    })
  }

  async readTasks(): Promise<BotTask[]> {
    try {
      const raw = JSON.parse(await readFile(this.tasksPath, 'utf8')) as Partial<TasksFile>
      if (!raw || typeof raw !== 'object' || raw.version !== 1 || !Array.isArray(raw.tasks)) {
        throw new Error('Invalid bot tasks.json')
      }
      return raw.tasks
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async updateTasks<T>(mutate: (tasks: BotTask[]) => { tasks: BotTask[]; result: T }): Promise<T> {
    return this.serialize(async () => {
      const current = await this.readTasks()
      const { tasks, result } = mutate(structuredClone(current))
      await this.ensureDir()
      const payload: TasksFile = { version: 1, tasks }
      await writeFileAtomic(this.tasksPath, `${JSON.stringify(payload, null, 2)}\n`)
      return result
    })
  }

  /**
   * Mark any starting/running/stopping runs left behind by a crash as interrupted.
   * Never masquerades crashed runs as completed.
   */
  async recoverInterruptedRuns(): Promise<BotTask[]> {
    const recovered: BotTask[] = []
    await this.updateTasks((tasks) => {
      const now = Date.now()
      for (const task of tasks) {
        const wasTaskActive =
          task.status === 'starting' ||
          task.status === 'running' ||
          task.status === 'blocked_approval' ||
          Boolean(task.activeRunId)
        for (const run of task.runs) {
          if (run.status === 'starting' || run.status === 'running' || run.status === 'stopping') {
            // Only active tasks become interrupted on crash recovery; historical stale runs on already
            // terminal tasks (e.g. legacy takeover runs) are finalized silently without clobbering task.status.
            run.status = !wasTaskActive && run.stopOrigin ? 'stopped' : 'interrupted'
            run.endedAt = now
            run.durationMs = Math.max(0, now - run.startedAt)
          }
        }
        if (wasTaskActive) {
          task.status = 'interrupted'
          task.activeRunId = undefined
          task.updatedAt = now
          task.latestReceipt ??= {
            summary: 'Run was interrupted when Pig exited unexpectedly.',
            changedFiles: [],
            totalAdded: 0,
            totalRemoved: 0,
            errorCode: 'INTERRUPTED',
            collectedAt: now
          }
          recovered.push(structuredClone(task))
        }
      }
      return { tasks, result: undefined }
    })
    return recovered
  }

  async readTimeline(): Promise<BotTimelineItem[]> {
    try {
      const content = await readFile(this.timelinePath, 'utf8')
      const items: BotTimelineItem[] = []
      for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        items.push(JSON.parse(trimmed) as BotTimelineItem)
      }
      return items
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async appendTimelineItem(item: BotTimelineItem): Promise<void> {
    await this.serialize(async () => {
      await this.ensureDir()
      await appendFile(this.timelinePath, `${JSON.stringify(item)}\n`, { encoding: 'utf8', mode: 0o600 })
      await chmod(this.timelinePath, 0o600).catch(() => {})
    })
  }

  async archiveAndResetTimeline(archivedSessionId: string): Promise<void> {
    await this.serialize(async () => {
      await this.ensureDir()
      const archivePath = join(this.dir, `timeline-${archivedSessionId}-${Date.now()}.jsonl`)
      try {
        await rename(this.timelinePath, archivePath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    })
  }
}
