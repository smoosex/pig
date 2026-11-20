/** Own Git topology, branch naming and deletion tombstones; cleanup retries live in the same atomic state file. */
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { lstat, mkdir, readFile, realpath, rmdir, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'
import { execGit, GitExecError, isNotARepoError, type GitExecOptions } from './git/exec'
import { t } from './i18n'
import type { WorktreeDeletionJob, WorktreeOwner } from '../shared/api'
import { writeFileAtomic } from './atomic-write'

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
  owner?: WorktreeOwner
  naming?: 'pending' | 'naming' | 'failed'
  namingError?: string
}

export interface CreateWorktreeOptions {
  owner?: WorktreeOwner
  slug?: string
}

export interface WorktreeDeletionInfo {
  worktree: GitWorktree
  dirty: boolean
  unmerged: boolean
  snapshot: string
}

interface WorktreeRecord {
  allocationId?: string
  directoryIdentity?: string
  projectCwd: string
  cwd: string
  initialBranch: string
  branch: string
  head?: string
  detached?: boolean
  owner?: WorktreeOwner
  naming?: 'pending' | 'naming' | 'failed'
  namingError?: string
  /** The task the attempt was given, kept so a retry is given the same one. */
  namingText?: string
  deleting?: boolean
  backgroundDeletion?: {
    /** Only explicit true authorizes discarding files; legacy jobs may omit this field. */
    force?: boolean
    guard?: { snapshot: string; confirmed: boolean }
    attempts: number
    error?: string
    retryAt?: number
  }
}

export function git(cwd: string, args: string[], options?: GitExecOptions): Promise<string> {
  return execGit(cwd, args, options)
}

function gitExit(error: unknown, code: number): boolean {
  return error instanceof GitExecError && error.code === code
}

/** Only a symbolic HEAD with a missing target is unborn. Broken refs and Git failures propagate. */
export async function resolveGitHead(cwd: string): Promise<string | undefined> {
  try {
    return (await git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
  } catch (error) {
    if (!gitExit(error, 128)) throw error
    const ref = (await git(cwd, ['symbolic-ref', '--quiet', 'HEAD'])).trim()
    try {
      await git(cwd, ['show-ref', '--exists', ref])
    } catch (refError) {
      if (gitExit(refError, 2)) return undefined
      throw refError
    }
    throw error
  }
}

async function directoryIdentity(cwd: string): Promise<string | undefined> {
  try {
    const info = await lstat(cwd, { bigint: true })
    return info.isDirectory() ? `${info.dev}:${info.ino}` : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
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

const BOT_SLUG_MAX_LEN = 32
const BOT_BRANCH_MAX_LEN = 80

export function formatBotWorktreeSlug(raw?: string): string {
  const normalized = (raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, BOT_SLUG_MAX_LEN)
    .replace(/-+$/g, '')
  return normalized || 'task'
}

export function formatBotShortId(taskId: string): string {
  const hex = taskId.toLowerCase().replace(/[^0-9a-f]/g, '')
  if (hex.length >= 6) return hex.slice(0, 6)
  return createHash('sha256').update(taskId).digest('hex').slice(0, 6)
}

export function buildBotWorktreeBranch(slug: string | undefined, taskId: string, collisionSuffix?: number): string {
  const shortId = formatBotShortId(taskId)
  const suffix = collisionSuffix && collisionSuffix > 1 ? `-${collisionSuffix}` : ''
  const tail = `-${shortId}${suffix}`
  const maxSlugLen = Math.min(BOT_SLUG_MAX_LEN, BOT_BRANCH_MAX_LEN - 'bot/'.length - tail.length)
  const cleanSlug = formatBotWorktreeSlug(slug).slice(0, Math.max(1, maxSlugLen)).replace(/-+$/g, '') || 'task'
  const branch = `bot/${cleanSlug}${tail}`
  return validateBotBranchName(branch)
}

export function validateBotBranchName(value: string): string {
  const name = value.trim()
  if (name.length > BOT_BRANCH_MAX_LEN || !/^bot\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
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

  private update(fn: (records: WorktreeRecord[]) => WorktreeRecord[] | Promise<WorktreeRecord[]>): Promise<void> {
    const task = this.stateLock.then(async () => {
      const records = await fn(await this.records())
      await mkdir(this.root, { recursive: true })
      await writeFileAtomic(join(this.root, '.state.json'), `${JSON.stringify({ version: 1, worktrees: records }, null, 2)}\n`)
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
      if (record.owner) item.owner = record.owner
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

  async create(projectCwd: string, options?: CreateWorktreeOptions): Promise<GitWorktree> {
    return this.exclusive(projectCwd, async () => {
      this.assertAvailable(projectCwd)
      const project = await canonicalProject(projectCwd)
      if (project !== resolve(projectCwd)) throw new Error(t('error.worktreeFromProject'))
      if (!(await isGitProject(project))) throw new Error(t('error.gitRequired'))
      const name = basename(project).replace(/[^\p{L}\p{N}._-]/gu, '-').replace(/^\.+/, '') || 'project'
      const head = await resolveGitHead(project)
      const owner = options?.owner
      const allocationId = randomUUID()
      const items = await repositoryWorktrees(project)
      let reservation: { cwd: string; identity: string } | undefined
      let branch = ''
      let refCreated = false
      try {
        await this.update(async (records) => {
          const reserved = records.filter((r) => r.projectCwd === project)
          for (let suffix = 1; ; suffix++) {
            branch = owner ? buildBotWorktreeBranch(options?.slug, owner.taskId, suffix) : randomUUID()
            if (items.some((w) => w.branch === branch) || reserved.some((r) => r.branch === branch || r.initialBranch === branch)) continue
            if (await this.branchExists(project, branch)) continue
            break
          }
          const parent = resolve(this.storageParent(project, records, name))
          await mkdir(parent, { recursive: true })
          const stem = owner ? `bot-${formatBotShortId(owner.taskId)}` : branch
          for (let suffix = 1; ; suffix++) {
            const cwd = join(parent, suffix === 1 ? stem : `${stem}-${suffix}`)
            if (records.some((r) => resolve(r.cwd) === cwd) || items.some((w) => w.cwd === cwd)) continue
            try {
              await mkdir(cwd)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
              throw error
            }
            const identity = await directoryIdentity(cwd)
            if (!identity) throw new Error('Worktree allocation directory changed')
            reservation = { cwd, identity }
            return [...records, {
              allocationId, directoryIdentity: identity, projectCwd: project, cwd,
              initialBranch: branch, branch, owner, naming: owner ? undefined : 'pending'
            }]
          }
        })
        const { cwd, identity } = reservation!
        if (await directoryIdentity(cwd) !== identity) throw new Error('Worktree allocation directory changed')
        if (head) {
          // Claim the ref with compare-and-swap so a failed add cannot delete a pre-existing branch.
          await git(project, ['update-ref', `refs/heads/${branch}`, head, '0'.repeat(head.length)])
          refCreated = true
          await git(project, ['worktree', 'add', cwd, branch])
        } else {
          await git(project, ['worktree', 'add', '--orphan', '-b', branch, cwd])
        }
      } catch (error) {
        if (reservation) {
          const { cwd, identity } = reservation
          try {
            const current = await repositoryWorktrees(project)
            // Keep a partial registered checkout discoverable, including any hook-created files.
            if (!current.some((item) => item.cwd === cwd)) {
              if (await directoryIdentity(cwd) === identity) {
                await rmdir(cwd).catch((error: NodeJS.ErrnoException) => {
                  if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code ?? '')) throw error
                })
              }
              if (refCreated && !current.some((item) => item.branch === branch)) {
                await git(project, ['update-ref', '-d', `refs/heads/${branch}`, head!])
              }
              await this.update((records) => records.filter((record) => record.allocationId !== allocationId))
            }
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], 'Worktree creation failed and could not be fully rolled back')
          } finally {
            this.onChange(project)
          }
        }
        throw error
      }
      this.onChange(project)
      return {
        cwd: reservation!.cwd, branch, head, isPrimary: false, locked: false, missing: false,
        managed: true, owner, ...(owner ? {} : { naming: 'pending' })
      }
    })
  }

  private async branchExists(projectCwd: string, branch: string): Promise<boolean> {
    try {
      await git(projectCwd, ['show-ref', '--exists', `refs/heads/${branch}`])
      return true
    } catch (error) {
      if (gitExit(error, 2)) return false
      throw error
    }
  }

  async verifyBotWorktree(projectCwd: string, cwd: string, taskId: string): Promise<GitWorktree> {
    return this.exclusive(projectCwd, async () => {
      const path = resolve(cwd)
      this.assertAvailable(path)
      const record = (await this.records()).find((r) => r.cwd === path && r.projectCwd === resolve(projectCwd))
      const worktree = (await this.discover(projectCwd)).find((item) => item.cwd === path)
      if (!record || record.deleting || record.owner?.taskId !== taskId || worktree?.owner?.kind !== 'bot'
        || worktree.isPrimary || worktree.missing || worktree.locked || worktree.detached || record.branch !== worktree.branch
        || (record.directoryIdentity && await directoryIdentity(path) !== record.directoryIdentity)) {
        throw new Error('Cannot reuse a missing or unverified Bot worktree')
      }
      return worktree
    })
  }

  async deletionInfo(projectCwd: string, cwd: string): Promise<WorktreeDeletionInfo> {
    const items = await this.discover(projectCwd)
    const worktree = items.find((item) => item.cwd === resolve(cwd))
    if (!worktree || worktree.isPrimary || worktree.cwd === resolve(projectCwd)) throw new Error(t('error.worktreeDeletePrimary'))
    if (worktree.locked) throw new Error(t('error.worktreeLocked'))
    if (!worktree.detached && items.some((w) => w.cwd !== worktree.cwd && !w.detached && w.branch === worktree.branch)) throw new Error(t('error.worktreeBranchInUse'))
    return this.inspectDeletion(projectCwd, worktree)
  }

  private async isUnmerged(projectCwd: string, head?: string): Promise<boolean> {
    if (!head || /^0+$/.test(head)) return false
    const base = await resolveGitHead(projectCwd)
    if (!base) return true
    try {
      await git(projectCwd, ['merge-base', '--is-ancestor', head, base])
      return false
    } catch (error) {
      if (gitExit(error, 1)) return true
      throw error
    }
  }

  private async inspectDeletion(projectCwd: string, worktree: GitWorktree, bindChanges = worktree.owner?.kind === 'bot'): Promise<WorktreeDeletionInfo> {
    const identity = worktree.missing ? null : await directoryIdentity(worktree.cwd)
    if (identity === undefined) throw new Error(t('error.worktreeDeletionChanged'))
    const unmerged = await this.isUnmerged(projectCwd, worktree.head)
    const status = worktree.missing ? '' : await git(worktree.cwd, [
      'status', '--porcelain=v1', '-z', '--untracked-files=all', bindChanges ? '--ignored=traditional' : '--ignored=matching', '--ignore-submodules=none'
    ], { optionalLocks: false })
    const snapshot = createHash('sha256').update(JSON.stringify([
      resolve(projectCwd), worktree.cwd, identity, worktree.branch, worktree.head, Boolean(worktree.detached), status, unmerged
    ]))
    if (bindChanges && status) {
      // Status letters alone do not notice another edit to an already dirty file or index entry.
      snapshot.update(await git(worktree.cwd, ['diff', '--cached', '--raw', '--no-abbrev', '-z', '--']))
      const entries = status.split('\0')
      for (let i = 0; i < entries.length - 1; i++) {
        const entry = entries[i]
        const path = entry.slice(3)
        if (/[RC]/.test(entry.slice(0, 2))) i++ // -z supplies the source path next; the destination is first.
        if (!path || path.startsWith('/') || path.split('/').includes('..')) throw new Error(t('error.worktreeDeletionChanged'))
        try {
          const info = await lstat(join(worktree.cwd, path), { bigint: true })
          snapshot.update([info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs].join(':') + '\0')
          // Nested repositories/submodules can be represented by one entry. Do not force-remove
          // that opaque directory based on its status alone.
          if (info.isDirectory()) throw new Error('Cannot confirm deletion of an opaque dirty worktree directory')
        } catch (error) {
          if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
          snapshot.update('missing\0')
        }
      }
    }
    return {
      worktree, dirty: status.length > 0, unmerged,
      snapshot: snapshot.digest('hex')
    }
  }

  private checkDeletion(info: WorktreeDeletionInfo, guard: { snapshot?: string; confirmed: boolean }): void {
    if (guard.snapshot !== undefined && guard.snapshot !== info.snapshot) {
      throw new Error(t('error.worktreeDeletionChanged'))
    }
    if (!guard.confirmed && (info.dirty || info.unmerged)) {
      throw Object.assign(new Error(t('error.worktreeDeletionUnconfirmedChanges')), { code: 'ERR_WORKTREE_DELETION_UNCONFIRMED_CHANGES' })
    }
  }

  async remove(
    projectCwd: string,
    cwd: string,
    close: () => Promise<void>,
    cleanSessions: () => Promise<void>,
    options: { background?: boolean; bot?: { taskId: string; confirmation?: string }; confirmation?: string; check?: () => void } = {}
  ): Promise<void> {
    const { background = false } = options
    const project = resolve(projectCwd)
    const path = resolve(cwd)
    return this.exclusive(project, async () => {
      this.assertAvailable(path)
      if (background && !this.cleanDeletedSessions) {
        throw Object.assign(new Error('Worktree deletion worker is not ready'), { code: 'ERR_WORKTREE_DELETION_WORKER_NOT_READY' })
      }
      const initial = await this.deletionInfo(project, path)
      if (options.bot && initial.worktree.owner?.taskId !== options.bot.taskId) {
        throw new Error('Target worktree is not owned by this Bot task')
      }
      const confirmation = options.bot ? options.bot.confirmation : initial.worktree.owner ? options.confirmation : undefined
      const guarded = Boolean(initial.worktree.owner || options.bot || confirmation !== undefined)
      const guard = guarded ? { snapshot: confirmation ?? initial.snapshot, confirmed: confirmation !== undefined } : undefined
      if (guard) this.checkDeletion(initial, guard)
      options.check?.()
      this.blocked.add(path)
      this.namingJobs.get(path)?.controller.abort()
      let queued = false
      try {
        await close()
        const final = await this.deletionInfo(project, path)
        if (guard) this.checkDeletion(final, guard)
        const { worktree: current } = final
        const force = guard ? guard.confirmed && final.dirty : true
        await this.update((records) => {
          options.check?.()
          const record = records.find((r) => r.cwd === path)
          const deletion = {
            branch: current.branch, head: current.head, detached: current.detached, deleting: true,
            backgroundDeletion: background ? { force, guard, attempts: 0 } : undefined
          }
          if (record) return records.map((r) => r === record ? { ...r, ...deletion } : r)
          return [...records, { projectCwd: project, cwd: path, initialBranch: current.branch, ...deletion }]
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
          try {
            await this.cleanWorktree(project, current, force, cleanSessions, guard)
          } catch (error) {
            // Keep the recovery record if Git already removed the registration.
            if (guard && (await repositoryWorktrees(project)).some((item) => item.cwd === path)) {
              await this.update((records) => records.map((r) => r.cwd === path ? { ...r, deleting: undefined } : r))
            }
            throw error
          }
        }
      } finally {
        if (!queued) this.blocked.delete(path)
        this.onChange(project)
      }
    })
  }

  private async cleanWorktree(
    projectCwd: string,
    worktree: Pick<GitWorktree, 'cwd' | 'branch' | 'head' | 'detached'>,
    force: boolean,
    cleanSessions: () => Promise<void>,
    guard?: { snapshot?: string; confirmed: boolean },
    durable = false
  ): Promise<void> {
    const path = worktree.cwd
    const tracked = durable || guard !== undefined
    const items = await repositoryWorktrees(projectCwd)
    const registered = items.find((w) => w.cwd === path)
    const branch = worktree.branch
    if (!worktree.detached && items.some((w) => w.cwd !== path && !w.detached && w.branch === branch)) {
      throw new Error(t('error.worktreeBranchInUse'))
    }
    if (registered) {
      if (tracked && (registered.isPrimary || registered.branch !== branch || registered.head !== worktree.head || Boolean(registered.detached) !== Boolean(worktree.detached))) {
        throw new Error(t('error.worktreeDeletionChanged'))
      }
      if (guard || !force) await this.checkDeletion(await this.inspectDeletion(projectCwd, registered, Boolean(guard?.snapshot)), guard ?? { confirmed: false })
      await git(projectCwd, ['worktree', 'remove', ...(force ? ['--force'] : []), path])
    } else if (guard) {
      // A retry after partial cleanup can delete the same branch, but not a replacement path.
      try {
        await lstat(path)
        throw new Error(t('error.worktreeDeletionChanged'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    if (!worktree.detached && branch && await this.branchExists(projectCwd, branch)) {
      const ref = `refs/heads/${branch}`
      const head = (await git(projectCwd, ['rev-parse', '--verify', ref])).trim()
      if (tracked && worktree.head && head !== worktree.head) throw new Error(t('error.worktreeDeletionChanged'))
      if (guard || !force) {
        if (head !== worktree.head) throw new Error(t('error.worktreeDeletionChanged'))
        if (!guard?.confirmed && await this.isUnmerged(projectCwd, head)) {
          throw Object.assign(new Error(t('error.worktreeDeletionUnconfirmedChanges')), { code: 'ERR_WORKTREE_DELETION_UNCONFIRMED_CHANGES' })
        }
        if ((await repositoryWorktrees(projectCwd)).some((w) => !w.detached && w.branch === branch)) {
          throw new Error(t('error.worktreeBranchInUse'))
        }
        await git(projectCwd, ['update-ref', '-d', ref, head])
      } else {
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
      // Recovery and retries retain the original consent; old jobs must not gain force implicitly.
      const guard = deletion.guard ?? (record.owner?.kind === 'bot' ? { confirmed: false } : undefined)
      const force = deletion.force === true && (!guard || (guard.confirmed && 'snapshot' in guard))
      await this.cleanWorktree(record.projectCwd, record, force, () => this.cleanDeletedSessions!(path), guard, true)
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
    if (record.owner) throw new Error(t('error.worktreeNotRenamable'))
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
    const record = (await this.records()).find((r) => r.cwd === cwd && r.naming === 'pending' && !r.deleting && !r.owner)
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
