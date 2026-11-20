/**
 * Durable JSONL notice queue feeding critical background task transitions into the Bot session.
 * Yields to active user turns and coalesces concurrent head notices into a single delivery batch.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { BotNotice, BotNoticeKind, BotNoticeState, BotStopOrigin, BotTaskReceipt } from '../../shared/bot'
import { writeFileAtomic } from '../atomic-write'

export interface EnqueueNoticeInput {
  noticeId?: string
  kind: BotNoticeKind
  taskId: string
  runId: string
  sessionId?: string
  projectCwd: string
  branch?: string
  worktreePath?: string
  stopOrigin?: BotStopOrigin
  summary?: string
  receipt?: BotTaskReceipt
  approvalRequestId?: string
}

export interface NoticeDeliverer {
  isUserBusy(): boolean
  deliverBatch(notices: BotNotice[]): Promise<{ state: 'delivered' | 'fallback' | 'failed' | 'deferred'; error?: string }>
}

export class BotNoticeQueue {
  private notices: BotNotice[] = []
  private loaded = false
  private draining = false
  private persistLock: Promise<unknown> = Promise.resolve()
  private retryTimer?: ReturnType<typeof setTimeout>
  private deliverer?: NoticeDeliverer
  private disposed = false

  constructor(private readonly filePath: string, private readonly retryDelayMs = 150) {}

  setDeliverer(deliverer: NoticeDeliverer): void {
    this.deliverer = deliverer
    this.scheduleDrain(0)
  }

  async load(): Promise<BotNotice[]> {
    if (this.loaded) return structuredClone(this.notices)
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed: BotNotice[] = []
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const item = JSON.parse(trimmed) as BotNotice
        // Recover in-flight deliveries left behind by a crash back to pending.
        if (item.state === 'delivering') item.state = 'pending'
        parsed.push(item)
      }
      this.notices = parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.notices = []
    }
    this.loaded = true
    return structuredClone(this.notices)
  }

  private async persist(): Promise<void> {
    const snapshot = this.notices.map((n) => JSON.stringify(n)).join('\n')
    const data = snapshot ? `${snapshot}\n` : ''
    const task = this.persistLock.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
      await writeFileAtomic(this.filePath, data)
    })
    this.persistLock = task.catch(() => {})
    await task
  }

  async enqueue(input: EnqueueNoticeInput): Promise<BotNotice> {
    await this.load()
    const noticeId = input.noticeId ?? randomUUID()
    const existing = this.notices.find((n) => n.noticeId === noticeId)
    if (existing) return structuredClone(existing)

    const notice: BotNotice = {
      noticeId,
      kind: input.kind,
      taskId: input.taskId,
      runId: input.runId,
      sessionId: input.sessionId,
      projectCwd: input.projectCwd,
      branch: input.branch,
      worktreePath: input.worktreePath,
      stopOrigin: input.stopOrigin,
      summary: input.summary,
      receipt: input.receipt,
      approvalRequestId: input.approvalRequestId,
      createdAt: Date.now(),
      state: 'pending'
    }
    this.notices.push(notice)
    // Retain at most 500 historical delivered notices to keep file bounded.
    if (this.notices.length > 500) {
      const pending = this.notices.filter((n) => n.state === 'pending' || n.state === 'delivering')
      const settled = this.notices.filter((n) => n.state !== 'pending' && n.state !== 'delivering').slice(-400)
      this.notices = [...settled, ...pending]
    }
    await this.persist()
    this.scheduleDrain(0)
    return structuredClone(notice)
  }

  pendingCount(): number {
    return this.notices.filter((n) => n.state === 'pending' || n.state === 'delivering').length
  }

  list(): BotNotice[] {
    return structuredClone(this.notices)
  }

  notifyUserIdle(): void {
    this.scheduleDrain(0)
  }

  private scheduleDrain(delayMs: number): void {
    if (this.disposed || !this.deliverer) return
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.drain()
    }, delayMs)
    this.retryTimer.unref?.()
  }

  async drain(): Promise<void> {
    if (this.disposed || this.draining || !this.deliverer) return
    await this.load()
    if (this.disposed || this.draining) return
    const pending = this.notices.filter((n) => n.state === 'pending')
    if (pending.length === 0) return

    // Always yield to active user conversation turns so notices never hijack live banter.
    if (this.deliverer.isUserBusy()) {
      this.scheduleDrain(this.retryDelayMs)
      return
    }

    this.draining = true
    const batch = pending.slice(0, 5)
    let deferred = false
    try {
      for (const item of batch) item.state = 'delivering'
      await this.persist()

      const result = await this.deliverer.deliverBatch(structuredClone(batch))
      const now = Date.now()
      deferred = result.state === 'deferred'
      const finalState: BotNoticeState = result.state === 'deferred' ? 'pending' : result.state
      for (const item of batch) {
        item.state = finalState
        item.deliveredAt = finalState === 'delivered' || finalState === 'fallback' ? now : undefined
        item.error = result.error
      }
      await this.persist()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      for (const item of batch) {
        item.state = 'failed'
        item.error = msg
      }
      await this.persist()
    } finally {
      this.draining = false
      if (!this.disposed && this.notices.some((n) => n.state === 'pending')) {
        this.scheduleDrain(deferred ? this.retryDelayMs : 0)
      }
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }
  }
}
