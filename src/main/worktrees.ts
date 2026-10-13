/** Own Git topology, branch naming and deletion tombstones; cleanup retries live in the same atomic state file. */
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'
import { execGit, GitExecError, isNotARepoError, type GitExecOptions } from './git/exec'
import { t } from './i18n'
import type { WorktreeDeletionJob } from '../shared/api'

function resolve(path: string): string {
  const absolute = resolvePath(path)
  try {
    return realpathSync.native(absolute)
  } catch {
    const parent = dirname(absolute)
    return parent === absolute ? absolute : join(resolve(parent), basename(absolute))
  }
}

export { resolve as normalizeWorktreePath }

export interface GitWorktree {
  cwd: string
  branch: string
  head?: string
  detached?: boolean
  isPrimary: boolean
  locked: boolean
  missing: boolean
  managed: boolean
  naming?: 'pending' | 'naming' | 'failed'
  namingError?: string
}

interface WorktreeRecord {
  projectCwd: string
  cwd: string
  initialBranch: string
  branch: string
  head?: string
  detached?: boolean
  naming?: 'pending' | 'naming' | 'failed'
  namingError?: string
  /** The task the attempt was given, kept so a retry is given the same one. */
  namingText?: string
  deleting?: boolean
  backgroundDeletion?: {
    /** Older jobs did not record consent to force deletion; missing means non-force. */
    force?: boolean
    attempts: number
    error?: string
    retryAt?: number
  }
}

export function git(cwd: string, args: string[], options?: GitExecOptions): Promise<string> {
  return execGit(cwd, args, options)
}

export function parseWorktrees(output: string): GitWorktree[] {
  const result: GitWorktree[] = []
  let current: GitWorktree | undefined
  for (const field of output.split('\0')) {
    if (field.startsWith('worktree ')) {
      current = {
        cwd: resolve(field.slice(9)), branch: '', isPrimary: result.length === 0,
        locked: false, missing: false, managed: false
      }
      result.push(current)
    } else if (current) {
      if (field.startsWith('branch refs/heads/')) current.branch = field.slice(18)
      if (field.startsWith('HEAD ')) {
        current.head = field.slice(5)
        if (!current.branch) current.branch = `detached/${field.slice(5, 13)}`
      }
      if (field === 'detached') current.detached = true
      if (field === 'locked' || field.startsWith('locked ')) current.locked = true
      if (field === 'prunable' || field.startsWith('prunable ')) current.missing = true
      if (field === 'bare') throw new Error(t('error.bareRepository'))
    }
  }
  return result
}

export async function repositoryWorktrees(cwd: string): Promise<GitWorktree[]> {
  const result = parseWorktrees(await git(cwd, ['worktree', 'list', '--porcelain', '-z']))
  for (const item of result) {
    item.cwd = await realpath(item.cwd).catch(() => item.cwd)
    item.missing ||= !(await stat(item.cwd).then((s) => s.isDirectory()).catch(() => false))
  }
  return result
}

export async function isGitProject(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ['rev-parse', '--git-dir'], { locale: 'C' })
    return true
  } catch (error) {
    if (isNotARepoError(error)) return false
    throw error
  }
}

export async function canonicalProject(cwd: string): Promise<string> {
  const path = await realpath(resolve(cwd))
  if (!(await isGitProject(path))) return path
  const worktrees = await repositoryWorktrees(path)
  if (!worktrees[0]) throw new Error(t('error.unknownWorktreeRoot'))
  return worktrees[0].cwd
}

/** The task a naming attempt is given: the model sees no more, and a retry replays no more. */
const NAMING_TASK_CHARS = 12_000

export function validateBranchName(value: string): string {
  const name = value.trim()
  if (name.length > 80 || !/^(feat|fix|chore|docs|refactor|test|ci|perf|style|build)\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(t('naming.invalidBranch'))
  }
  return name
}

export class WorktreeService {
  private locks = new Map<string, Promise<unknown>>()
  private stateLock: Promise<unknown> = Promise.resolve()
  private namingJobs = new Map<string, { controller: AbortController; done: Promise<void> }>()
  /** One preparation per cwd; shutdown also waits for any queued-state rollback it owes. */
  private preps = new Map<string, Promise<{ attempt: Promise<void> }>>()
  private blocked = new Set<string>()
  private stopped = false
  private deletionJobs = new Map<string, Promise<void>>()
  private deletionLock: Promise<void> = Promise.resolve()
  private deletionTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private cleanDeletedSessions?: (cwd: string) => Promise<void>

  constructor(
    readonly root: string,
    private readonly onChange: (projectCwd: string) => void = () => {},
    private readonly onDeletionsChanged: (jobs: WorktreeDeletionJob[]) => void = () => {},
    private readonly deletionRetryDelays: readonly number[] = [1_000, 5_000, 30_000]
  ) {
    this.root = resolve(root)
  }

  private async records(): Promise<WorktreeRecord[]> {
    try {
      const data = JSON.parse(await readFile(join(this.root, '.state.json'), 'utf8'))
      if (data.version !== 1 || !Array.isArray(data.worktrees)) throw new Error('Invalid worktree state')
      return data.worktrees
    } catch (error) {
      // No state file on the first run is an empty registry; parse and other I/O failures are fatal.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private storageParent(project: string, records: WorktreeRecord[], name: string): string {
    const managed = records.filter((record) => !record.deleting)
    const existing = managed.find((record) => record.projectCwd === project)
    if (existing) return dirname(existing.cwd)
    const preferred = join(this.root, name)
    if (managed.some((record) => record.projectCwd !== project && dirname(record.cwd) === preferred)) {
      const hash = createHash('sha256').update(project).digest('hex').slice(0, 8)
      return join(this.root, `${name}-${hash}`)
    }
    return preferred
  }

  private update(fn: (records: WorktreeRecord[]) => WorktreeRecord[]): Promise<void> {
    const task = this.stateLock.then(async () => {
      const records = fn(await this.records())
      await mkdir(this.root, { recursive: true })
      const target = join(this.root, '.state.json')
      const temp = `${target}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, `${JSON.stringify({ version: 1, worktrees: records }, null, 2)}\n`, { mode: 0o600 })
        await rename(temp, target)
      } finally {
        await rm(temp, { force: true })
      }
    })
    this.stateLock = task.catch(() => {})
    return task
  }

  exclusive<T>(projectCwd: string, fn: () => Promise<T>): Promise<T> {
    const key = resolve(projectCwd)
    const task = (this.locks.get(key) ?? Promise.resolve()).catch(() => {}).then(fn)
    this.locks.set(key, task)
    void task.finally(() => {
      if (this.locks.get(key) === task) this.locks.delete(key)
    }).catch(() => {})
    return task
  }

  assertAvailable(cwd: string): void {
    if (this.stopped || this.blocked.has(resolve(cwd))) throw new Error(t('error.worktreeBusy'))
  }

  async withBlockedCwds<T>(cwds: string[], fn: () => Promise<T>): Promise<T> {
    const paths = cwds.map((cwd) => resolve(cwd))
    for (const path of paths) this.assertAvailable(path)
    for (const path of paths) {
      this.blocked.add(path)
      this.namingJobs.get(path)?.controller.abort()
    }
    try {
      return await fn()
    } finally {
      for (const path of paths) this.blocked.delete(path)
    }
  }

  async discover(projectCwd: string, knownHasGit?: boolean): Promise<GitWorktree[]> {
    const cwd = resolve(projectCwd)
    const hasGit = knownHasGit ?? await isGitProject(cwd)
    if (!hasGit) {
      return [{ cwd, branch: basename(cwd), isPrimary: true, locked: false, missing: false, managed: false }]
    }
    const items = await repositoryWorktrees(cwd)
    const records = (await this.records()).filter((r) => r.projectCwd === cwd)
    for (const record of records) {
      if (record.backgroundDeletion) continue
      let item = items.find((w) => w.cwd === record.cwd)
      if (!item && record.deleting) {
        item = { cwd: record.cwd, branch: record.branch, head: record.head, detached: record.detached, isPrimary: false, locked: false, missing: true, managed: true }
        items.push(item)
      }
      if (!item) continue
      item.managed = true
      if (record.deleting) {
        item.namingError = t('error.deleteIncomplete')
      } else if (item.branch === record.initialBranch) {
        item.naming = record.naming === 'naming' ? (this.namingJobs.has(item.cwd) ? 'naming' : 'failed') : record.naming
        item.namingError = record.namingError || (record.naming === 'naming' && !this.namingJobs.has(item.cwd) ? t('naming.interrupted') : undefined)
      }
    }
    const deleting = new Set(records.filter((record) => record.backgroundDeletion).map((record) => record.cwd))
    return items.filter((item) => !deleting.has(item.cwd))
  }

  async create(projectCwd: string): Promise<GitWorktree> {
    return this.exclusive(projectCwd, async () => {
      this.assertAvailable(projectCwd)
      const project = await canonicalProject(projectCwd)
      if (project !== resolve(projectCwd)) throw new Error(t('error.worktreeFromProject'))
      if (!(await isGitProject(project))) throw new Error(t('error.gitRequired'))
      const id = randomUUID()
      const name = basename(project).replace(/[^\p{L}\p{N}._-]/gu, '-').replace(/^\.+/, '') || 'project'
      const hasHead = await git(project, ['rev-parse', '--verify', 'HEAD']).then(() => true).catch(() => false)
      let cwd = ''
      await this.update((records) => {
        cwd = join(this.storageParent(project, records, name), id)
        return [...records, { projectCwd: project, cwd, initialBranch: id, branch: id, naming: 'pending' }]
      })
      try {
        await mkdir(dirname(cwd), { recursive: true })
        const args = hasHead
          ? ['worktree', 'add', '-b', id, cwd, 'HEAD']
          : ['worktree', 'add', '--orphan', '-b', id, cwd]
        await git(project, args)
      } catch (error) {
        await this.update((records) => records.filter((record) => record.cwd !== cwd))
        await git(project, ['worktree', 'remove', '--force', cwd]).catch(() => {})
        await rm(cwd, { recursive: true, force: true }).catch(() => {})
        if (hasHead) await git(project, ['branch', '-D', id]).catch(() => {})
        throw error
      }
      this.onChange(project)
      return { cwd, branch: id, isPrimary: false, locked: false, missing: false, managed: true, naming: 'pending' }
    })
  }

  async deletionInfo(projectCwd: string, cwd: string): Promise<{ worktree: GitWorktree; dirty: boolean; unmerged: boolean }> {
    const items = await this.discover(projectCwd)
    const worktree = items.find((item) => item.cwd === resolve(cwd))
    if (!worktree || worktree.isPrimary || worktree.cwd === resolve(projectCwd)) throw new Error(t('error.worktreeDeletePrimary'))
    if (worktree.locked) throw new Error(t('error.worktreeLocked'))
    if (!worktree.detached && items.some((w) => w.cwd !== worktree.cwd && !w.detached && w.branch === worktree.branch)) throw new Error(t('error.worktreeBranchInUse'))
    const dirty = !worktree.missing && (await git(cwd, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching'])).length > 0
    const ref = `refs/heads/${worktree.branch}`
    const hasBranch = !worktree.detached && await git(projectCwd, ['show-ref', '--verify', '--quiet', ref]).then(() => true).catch(() => false)
    const head = worktree.head && !/^0+$/.test(worktree.head) ? worktree.head : hasBranch ? ref : undefined
    const unmerged = Boolean(head) && !(await git(projectCwd, ['merge-base', '--is-ancestor', head!, 'HEAD']).then(() => true).catch(() => false))
    return { worktree, dirty, unmerged }
  }

  async remove(
    projectCwd: string,
    cwd: string,
    force: boolean,
    close: () => Promise<void>,
    cleanSessions: () => Promise<void>,
    options: { background?: boolean } = {}
  ): Promise<void> {
    const { background = false } = options
    const path = resolve(cwd)
    return this.exclusive(projectCwd, async () => {
      this.assertAvailable(path)
      if (background && !this.cleanDeletedSessions) {
        throw Object.assign(new Error('Worktree deletion worker is not ready'), { code: 'ERR_WORKTREE_DELETION_WORKER_NOT_READY' })
      }
      const initial = await this.deletionInfo(projectCwd, path)
      if (!force && (initial.dirty || initial.unmerged)) throw new Error(t('error.worktreeDirty'))
      this.blocked.add(path)
      this.namingJobs.get(path)?.controller.abort()
      let queued = false
      try {
        await close()
        const { worktree, dirty, unmerged } = await this.deletionInfo(projectCwd, path)
        if (!force && (dirty || unmerged)) throw new Error(t('error.worktreeNewChanges'))
        await this.update((records) => {
          const record = records.find((r) => r.cwd === path)
          const deletion = {
            branch: worktree.branch, head: worktree.head, detached: worktree.detached, deleting: true,
            backgroundDeletion: background ? { force, attempts: 0 } : undefined
          }
          if (record) return records.map((r) => r === record ? { ...r, ...deletion } : r)
          return [...records, { projectCwd, cwd: path, initialBranch: worktree.branch, ...deletion }]
        })
        if (background) {
          queued = true
          // Every window must see the tombstone even if cleanup finishes before IPC returns.
          try {
            await this.publishDeletions()
          } finally {
            this.scheduleDeletion(path, 0)
          }
        } else {
          await this.cleanWorktree(projectCwd, worktree, force, cleanSessions)
        }
      } finally {
        if (!queued) this.blocked.delete(path)
        this.onChange(projectCwd)
      }
    })
  }

  private async cleanWorktree(
    projectCwd: string,
    worktree: Pick<GitWorktree, 'cwd' | 'branch' | 'head' | 'detached'>,
    force: boolean,
    cleanSessions: () => Promise<void>,
    authorized = false
  ): Promise<void> {
    const path = worktree.cwd
    const registered = (await repositoryWorktrees(projectCwd)).find((w) => w.cwd === path)
    if (registered) {
      if (authorized && (registered.branch !== worktree.branch || registered.head !== worktree.head || Boolean(registered.detached) !== Boolean(worktree.detached))) {
        throw new Error(t('error.worktreeDeletionChanged'))
      }
      if (!force && !registered.missing && (await git(path, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching'])).length > 0) {
        throw new Error(t('error.worktreeNewChanges'))
      }
      await git(projectCwd, ['worktree', 'remove', ...(force ? ['--force'] : []), path])
    }
    const branch = worktree.branch
    if (!worktree.detached && branch) {
      const ref = `refs/heads/${branch}`
      const exists = await git(projectCwd, ['show-ref', '--verify', '--quiet', ref]).then(() => true).catch((error: unknown) => {
        if (error instanceof GitExecError && error.code === 1) return false
        throw error
      })
      if (exists) {
        if (authorized && worktree.head && (await git(projectCwd, ['rev-parse', ref])).trim() !== worktree.head) {
          throw new Error(t('error.worktreeDeletionChanged'))
        }
        await git(projectCwd, ['branch', '-D', branch])
      }
    }
    await cleanSessions()
    await this.update((records) => records.filter((r) => r.cwd !== path))
  }

  /** Restore tombstones before the window can reopen their sessions. */
  async startDeletionWorker(cleanSessions: (cwd: string) => Promise<void>): Promise<void> {
    const records = await this.records()
    this.cleanDeletedSessions = cleanSessions
    for (const record of records) {
      if (!record.backgroundDeletion) continue
      this.blocked.add(record.cwd)
      const deletion = record.backgroundDeletion
      if (!deletion.error || deletion.retryAt !== undefined) {
        this.scheduleDeletion(record.cwd, Math.max(0, (deletion.retryAt ?? 0) - Date.now()))
      }
    }
  }

  async listDeletions(): Promise<WorktreeDeletionJob[]> {
    return (await this.records()).filter((record) => record.backgroundDeletion).map((record) => {
      const deletion = record.backgroundDeletion!
      return {
        projectCwd: record.projectCwd, cwd: record.cwd, branch: record.branch,
        attempts: deletion.attempts, error: deletion.error, retryAt: deletion.retryAt,
        status: this.deletionJobs.has(record.cwd) ? 'running'
          : deletion.error ? deletion.retryAt !== undefined ? 'retrying' : 'failed' : 'pending'
      }
    })
  }

  private async publishDeletions(): Promise<void> {
    this.onDeletionsChanged(await this.listDeletions())
  }

  async retryDeletion(cwd: string): Promise<void> {
    const path = resolve(cwd)
    if (this.stopped) throw new Error(t('error.worktreeBusy'))
    const record = (await this.records()).find((item) => item.cwd === path && item.backgroundDeletion)
    if (!record) throw new Error(t('error.worktreeNotOpen'))
    await this.exclusive(record.projectCwd, async () => {
      if (this.stopped) throw new Error(t('error.worktreeBusy'))
      if (this.deletionJobs.has(path)) return
      await this.update((records) => records.map((item) => item.cwd === path
        ? { ...item, backgroundDeletion: { ...item.backgroundDeletion, attempts: 0, error: undefined, retryAt: undefined } } : item))
      try {
        await this.publishDeletions()
      } finally {
        this.scheduleDeletion(path, 0)
      }
    })
  }

  private scheduleDeletion(path: string, delay: number): void {
    if (this.stopped) return
    clearTimeout(this.deletionTimers.get(path))
    const timer = setTimeout(() => {
      this.deletionTimers.delete(path)
      if (this.stopped || this.deletionJobs.has(path)) return
      const task = this.deletionLock.then(() => this.runDeletion(path)).finally(async () => {
        this.deletionJobs.delete(path)
        await this.publishDeletions()
        const record = (await this.records()).find((item) => item.cwd === path)
        if (record?.backgroundDeletion?.retryAt !== undefined) {
          this.scheduleDeletion(path, Math.max(0, record.backgroundDeletion.retryAt - Date.now()))
        }
      })
      this.deletionLock = task.catch(() => {})
      this.deletionJobs.set(path, task)
      void task.catch((error) => console.error('Background worktree deletion failed:', error))
    }, delay)
    this.deletionTimers.set(path, timer)
  }

  private async runDeletion(path: string): Promise<void> {
    const record = (await this.records()).find((item) => item.cwd === path && item.backgroundDeletion)
    if (!record || this.stopped) return
    const deletion = record.backgroundDeletion!
    const attempts = deletion.attempts + 1
    try {
      await this.update((records) => records.map((item) => item.cwd === path
        ? { ...item, backgroundDeletion: { ...deletion, attempts, error: undefined, retryAt: undefined } } : item))
      await this.publishDeletions()
      // Preparation alone holds the project lock. Cleanup uses its frozen tombstone and Git's
      // own locks, so a slow directory removal cannot block creating or queuing another worktree.
      // Retries keep the original force choice: a tombstone is not permission to discard new files.
      await this.cleanWorktree(record.projectCwd, record, deletion.force === true, () => this.cleanDeletedSessions!(path), true)
      this.blocked.delete(path)
    } catch (error) {
      // This task boundary translates Git/cleanup failures into durable retry state and UI notices.
      // If recording the failure also fails, that I/O error propagates to the worker boundary.
      const message = error instanceof Error ? error.message : String(error)
      const delay = this.deletionRetryDelays[attempts - 1]
      await this.update((records) => records.map((item) => item.cwd === path
        ? { ...item, backgroundDeletion: { ...deletion, attempts, error: message, retryAt: delay === undefined ? undefined : Date.now() + delay } }
        : item))
      console.error('Background worktree deletion failed:', path, message)
    }
  }

  nameOnFirstPrompt(cwd: string, text: string, generate: (text: string, signal: AbortSignal) => Promise<string>): Promise<void> {
    const path = resolve(cwd)
    if (this.stopped || this.blocked.has(path) || this.namingJobs.has(path)) return Promise.resolve()
    const controller = new AbortController()
    const done = this.name(path, text, generate, controller.signal).finally(() => {
      this.namingJobs.delete(path)
    })
    this.namingJobs.set(path, { controller, done })
    return done
  }

  /**
   * A second attempt at a worktree whose naming failed. The record goes back to `pending` so
   * `name()` accepts it again. Refusing the attempt (already named, nothing to name from) rejects
   * this call, while `attempt` settles only when the rename does: a model call can run for minutes
   * and the row follows the record through the pushes the first try used. `attempt` is a field
   * rather than the return value because awaiting this call must not await the rename.
   * The task is read lazily: a worktree that cannot be retried never pays for that read.
   */
  retryNaming(
    cwd: string,
    task: () => Promise<string>,
    generate: (text: string, signal: AbortSignal) => Promise<string>
  ): Promise<{ attempt: Promise<void> }> {
    const path = resolve(cwd)
    const preparing = this.preps.get(path)
    if (preparing) return preparing
    const prep = this.prepareRetry(path, task, generate).finally(() => this.preps.delete(path))
    this.preps.set(path, prep)
    return prep
  }

  /** The task the last attempt was given; undefined for a record written before it was kept. */
  async namingTask(cwd: string): Promise<string | undefined> {
    const path = resolve(cwd)
    return (await this.records()).find((r) => r.cwd === path && !r.deleting)?.namingText
  }

  private async prepareRetry(
    path: string,
    task: () => Promise<string>,
    generate: (text: string, signal: AbortSignal) => Promise<string>
  ): Promise<{ attempt: Promise<void> }> {
    this.assertAvailable(path)
    const running = this.namingJobs.get(path)
    if (running) return { attempt: running.done }
    const record = (await this.records()).find((r) => r.cwd === path && !r.deleting)
    if (!record) throw new Error(t('error.worktreeNotOpen'))
    // A `naming` record without a live job is one a crashed run left behind, and `discover()` already
    // shows it as failed, so it is retryable too. `pending` is not: that name has not been lost yet.
    if (record.naming !== 'failed' && record.naming !== 'naming') {
      throw new Error(t('error.worktreeNotRenamable'))
    }
    const text = await task()
    // Reading the task is the slow step here, and a quit or a deletion can land inside it. Only
    // `failed` offers a retry and only a prompt re-queues `pending`, so a queued name nothing will
    // ever run strands the row for good: the check before the write refuses it, and the one after
    // unwinds a write it raced.
    this.assertAvailable(path)
    await this.update((records) => records.map((r) => r.cwd === path ? { ...r, naming: 'pending', namingError: undefined } : r))
    if (this.stopped || this.blocked.has(path)) {
      await this.update((records) => records.map((r) => r.cwd === path
        ? { ...r, naming: record.naming, namingError: record.namingError }
        : r))
      this.onChange(record.projectCwd)
      throw new Error(t('error.worktreeBusy'))
    }
    this.onChange(record.projectCwd)
    return { attempt: this.nameOnFirstPrompt(path, text, generate) }
  }

  private async name(cwd: string, text: string, generate: (text: string, signal: AbortSignal) => Promise<string>, signal: AbortSignal): Promise<void> {
    const record = (await this.records()).find((r) => r.cwd === cwd && r.naming === 'pending' && !r.deleting)
    if (!record || signal.aborted) return
    const task = text.slice(0, NAMING_TASK_CHARS)
    try {
      await this.exclusive(record.projectCwd, async () => {
        this.assertAvailable(cwd)
        signal.throwIfAborted()
        const branch = (await git(cwd, ['symbolic-ref', '--short', 'HEAD'])).trim()
        if (branch !== record.initialBranch) throw new Error(t('error.branchMoved'))
        await this.update((records) => records.map((r) => r.cwd === cwd ? { ...r, naming: 'naming', namingText: task, namingError: undefined } : r))
      })
      this.onChange(record.projectCwd)
      const requested = validateBranchName(await generate(task, signal))
      await this.exclusive(record.projectCwd, async () => {
        signal.throwIfAborted()
        this.assertAvailable(cwd)
        const current = (await this.records()).find((r) => r.cwd === cwd && !r.deleting)
        if (!current || (await git(cwd, ['symbolic-ref', '--short', 'HEAD'])).trim() !== record.initialBranch) return
        const items = await repositoryWorktrees(record.projectCwd)
        let branch = requested
        const taken = async (name: string) => items.some((w) => w.branch === name) || await git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]).then(() => true).catch(() => false)
        if (await taken(branch)) branch = `${requested}-${record.initialBranch.slice(0, 8)}`
        if (await taken(branch)) throw new Error(t('error.branchNameTaken'))
        const hasHead = await git(cwd, ['rev-parse', '--verify', 'HEAD']).then(() => true).catch(() => false)
        if (hasHead) await git(cwd, ['branch', '-m', branch])
        else await git(cwd, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`])
        await this.update((records) => records.map((r) => r.cwd === cwd ? { ...r, branch, naming: undefined, namingText: undefined, namingError: undefined } : r))
      })
    } catch (error) {
      // This background boundary reports model/Git failures through the persisted row.
      if (!signal.aborted) {
        await this.update((records) => records.map((r) => r.cwd === cwd && !r.deleting
          ? { ...r, naming: 'failed', namingError: error instanceof Error ? error.message : String(error) }
          : r))
      }
    } finally {
      this.onChange(record.projectCwd)
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    for (const timer of this.deletionTimers.values()) clearTimeout(timer)
    this.deletionTimers.clear()
    for (const job of this.namingJobs.values()) job.controller.abort()
    // Preparation rechecks `stopped` after reading and writing, so it cannot register another job.
    await Promise.allSettled([...this.preps.values()])
    await Promise.allSettled([...this.namingJobs.values()].map((job) => job.done))
    await Promise.allSettled([...this.deletionJobs.values()])
    await Promise.allSettled([...this.locks.values()])
    await this.stateLock
  }
}
