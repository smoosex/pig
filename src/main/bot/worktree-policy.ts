/**
 * Workspace isolation helpers, non-Git write mutex, and bounded change receipt collection for Bot tasks.
 */
import { normalizeWorktreePath as resolve, git, isGitProject, resolveGitHead, type WorktreeService } from '../worktrees'
import type { BotFileChangeSummary, BotTask, BotTaskReceipt, BotWorkspace } from '../../shared/bot'

const MAX_RECEIPT_FILES = 100
const MAX_SUMMARY_CHARS = 4000

export class NonGitWriteMutex {
  private owners = new Map<string, string>()

  acquire(cwd: string, taskId: string): void {
    const key = resolve(cwd)
    const holder = this.owners.get(key)
    if (holder && holder !== taskId) {
      throw new Error(`Another Bot write task (${holder}) is already running directly in project directory ${key}`)
    }
    this.owners.set(key, taskId)
  }

  release(cwd: string, taskId: string): void {
    const key = resolve(cwd)
    if (this.owners.get(key) === taskId) {
      this.owners.delete(key)
    }
  }

  holder(cwd: string): string | undefined {
    return this.owners.get(resolve(cwd))
  }
}

function parsePorcelainStatus(code: string): BotFileChangeSummary['status'] {
  if (code.includes('R')) return 'renamed'
  if (code.includes('D')) return 'deleted'
  if (code.includes('?') || code.includes('A')) return 'added'
  return 'modified'
}

export async function prepareGitWriteWorkspace(
  service: Pick<WorktreeService, 'create' | 'verifyBotWorktree'>,
  task: Pick<BotTask, 'taskId' | 'projectCwd' | 'workspace'>,
  slug: string,
  reuse: boolean
): Promise<BotWorkspace> {
  const previous = task.workspace
  if (reuse && previous.kind === 'worktree' && !previous.cleanedUpAt) {
    // Do not replace an invalid claimed worktree silently or ever fall back to the project checkout.
    const wt = await service.verifyBotWorktree(task.projectCwd, previous.cwd, task.taskId)
    return { ...previous, cwd: wt.cwd, branch: wt.branch }
  }
  const wt = await service.create(task.projectCwd, { owner: { kind: 'bot', taskId: task.taskId }, slug })
  if (wt.isPrimary || wt.missing || resolve(wt.cwd) === resolve(task.projectCwd)) {
    throw new Error('Git write tasks require a dedicated Bot worktree')
  }
  return { kind: 'worktree', cwd: wt.cwd, branch: wt.branch, baseHead: wt.head }
}

export async function collectWorkspaceReceipt(
  cwd: string,
  summary: string,
  options?: { errorCode?: string; errorMessage?: string; artifactPaths?: string[]; collectChanges?: boolean }
): Promise<BotTaskReceipt> {
  const safeSummary = summary.slice(0, MAX_SUMMARY_CHARS)
  const changedFiles: BotFileChangeSummary[] = []
  let totalAdded = 0
  let totalRemoved = 0

  let collectionStage = 'repository discovery'
  let collectionError: string | undefined
  try {
    if (options?.collectChanges !== false && await isGitProject(cwd)) {
      collectionStage = 'status'
      const statusOut = await git(cwd, ['status', '--porcelain=v1', '--untracked-files=all'])
      let numstatOut = ''
      try {
        collectionStage = 'HEAD resolution'
        const head = await resolveGitHead(cwd)
        collectionStage = 'diff statistics'
        numstatOut = await git(cwd, head ? ['diff', '--numstat', head, '--'] : ['diff', '--cached', '--numstat', '--'])
      } catch {
        collectionError = `Could not collect Git ${collectionStage}.`
      }
      const statsByPath = new Map<string, { added: number; removed: number }>()
      for (const line of numstatOut.split('\n')) {
        if (!line.trim()) continue
        const [a, r, ...rest] = line.split('\t')
        const filePath = rest.join('\t').trim()
        if (!filePath) continue
        const added = Number.isFinite(Number(a)) ? Number(a) : 0
        const removed = Number.isFinite(Number(r)) ? Number(r) : 0
        statsByPath.set(filePath, { added, removed })
      }
      const seen = new Set<string>()
      for (const line of statusOut.split('\n')) {
        if (line.length < 4) continue
        const code = line.slice(0, 2)
        const rawPath = line.slice(3).trim()
        const filePath = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop()!.trim() : rawPath
        if (!filePath || seen.has(filePath)) continue
        seen.add(filePath)
        const stat = statsByPath.get(filePath)
        if (stat) {
          totalAdded += stat.added
          totalRemoved += stat.removed
        }
        if (changedFiles.length < MAX_RECEIPT_FILES) {
          changedFiles.push({
            path: filePath,
            status: parsePorcelainStatus(code),
            ...(stat ? { added: stat.added, removed: stat.removed } : {})
          })
        }
      }
    }
  } catch {
    collectionError = `Could not collect Git ${collectionStage}.`
  }

  const errorCode = options?.errorCode ?? (collectionError ? 'ERR_GIT_RECEIPT_COLLECTION' : undefined)
  // Preserve the task failure independently; don't copy unbounded Git stderr into the ledger.
  const errorMessage = [options?.errorMessage?.slice(0, collectionError ? 900 : 1000), collectionError].filter(Boolean).join(' ')
  return {
    summary: safeSummary,
    changedFiles,
    totalAdded,
    totalRemoved,
    ...(options?.artifactPaths?.length ? { artifactPaths: options.artifactPaths.slice(0, 20) } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    collectedAt: Date.now()
  }
}

export async function inspectWorktreeSafety(
  service: { deletionInfo: (...args: Parameters<WorktreeService['deletionInfo']>) => Promise<Omit<Awaited<ReturnType<WorktreeService['deletionInfo']>>, 'snapshot'> & { snapshot?: string }> },
  projectCwd: string,
  worktreeCwd: string
): Promise<{ dirty: boolean; unmerged: boolean; branch: string; isBotOwned: boolean; ownerTaskId?: string; snapshot?: string }> {
  const info = await service.deletionInfo(projectCwd, worktreeCwd)
  return {
    dirty: info.dirty,
    unmerged: info.unmerged,
    branch: info.worktree.branch,
    snapshot: info.snapshot,
    isBotOwned: info.worktree.owner?.kind === 'bot',
    ownerTaskId: info.worktree.owner?.taskId
  }
}
