/**
 * Project display-name aliasing and full directory relocation (rebinding a moved or renamed project
 * directory while migrating Pi JSONL sessions, repairing Git worktrees, and updating spaces, Kanban,
 * bookmarks, subagent parent pointers, open workspaces, Bot tasks, and long-term project memory).
 */
import * as electron from 'electron'
import { randomUUID } from 'node:crypto'
import { lstatSync, renameSync } from 'node:fs'
import { mkdir, readFile, rename, rm, rmdir, stat, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { ProjectGroup, RelocateProjectResult } from '../shared/api'
import { isBotTaskActive } from '../shared/bot'
import { bookmarks } from './bookmarks'
import { BotStore } from './bot/store'
import { isChatCwd, isChatsRoot } from './chats'
import { MemoryFiles, memoryRoot, projectMemoryKey } from './features/memory/long-term/files'
import { closeWorktreeWatch } from './git/watch'
import { t } from './i18n'
import { kanban } from './kanban/service'
import { relocateOpenProjectWorkspace } from './open-project-sessions'
import { listOpenedCwds, renameOpenedProject, replaceOpenedProjectCwd } from './opened-projects'
import { forgetSessionName, listJsonlFiles, sessionDirForCwd } from './pi/session-loader'
import { closeSessionsForCwd, hasBusySessionsForCwd, openSessions } from './pi/session-registry'
import { pigDir, pigPath } from './pig-dir'
import { hasRunningSessionProcesses } from './processes'
import { resolveProjectDirectory } from './project-directory-browser'
import { projectSpaces } from './project-spaces'
import { forgetProjectBranches, loadWorktreeProject, requireOpenedProject, worktrees } from './project-worktrees'
import { within } from './sandbox/policy'
import { sessionWorkspace } from './sandbox/workspace'
import { manager as subagentManager } from './subagents/service'
import { forgetKnownWorktrees } from './worktree-access'
import { canonicalProject, git, isGitProject } from './worktrees'

function sendToAllWindows(channel: string, payload?: unknown): void {
  for (const win of electron.BrowserWindow?.getAllWindows?.() ?? []) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      if (payload === undefined) win.webContents.send(channel)
      else win.webContents.send(channel, payload)
    }
  }
}

function assertSafeProjectTarget(targetDir: string): void {
  const resolved = resolve(targetDir)
  const home = resolve(process.env.HOME || homedir())
  const dataRoot = resolve(pigDir())
  if (
    dirname(resolved) === resolved ||
    resolved === home ||
    within(dataRoot, resolved) ||
    within(resolved, dataRoot) ||
    isChatCwd(resolved) ||
    isChatsRoot(resolved)
  ) {
    throw new Error(t('project.relocateUnsafeTarget'))
  }
}

function rewriteSessionJsonlCwd(rawBytes: Buffer, nextCwd: string): { bytes: Buffer; sessionId: string | null } {
  const newline = rawBytes.indexOf(0x0a)
  const firstLine = (newline >= 0 ? rawBytes.subarray(0, newline) : rawBytes).toString('utf8')
  const header = JSON.parse(firstLine) as Record<string, unknown>
  const sessionId = typeof header.id === 'string' && header.id ? header.id : null
  if (header.type === 'session') {
    header.cwd = nextCwd
  }
  const encodedHeader = Buffer.from(JSON.stringify(header), 'utf8')
  const rest = newline >= 0 ? rawBytes.subarray(newline) : Buffer.from('\n', 'utf8')
  return { bytes: Buffer.concat([encodedHeader, rest]), sessionId }
}

async function relocateSubagentParentFile(sessionId: string, oldFile: string, newFile: string): Promise<void> {
  const indexFile = join(pigPath('subagents'), sessionId, 'index.json')
  let text: string
  try {
    text = await readFile(indexFile, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const parsed = JSON.parse(text) as { version?: number; subagents?: Array<Record<string, unknown>> }
  if (!Array.isArray(parsed.subagents)) return
  let changed = false
  const subagents = parsed.subagents.map((entry) => {
    if (!entry || entry.parentSessionFile !== oldFile) return entry
    changed = true
    return { ...entry, parentSessionFile: newFile }
  })
  if (!changed) return
  const temp = `${indexFile}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify({ ...parsed, subagents }, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temp, indexFile)
  } finally {
    await rm(temp, { force: true })
  }
}

function migrateProjectLongTermMemory(oldProject: string, newMemKey: string): void {
  const root = memoryRoot()
  const projectsDir = join(root, 'projects')
  const candidateOldKeys = [
    projectMemoryKey(join(oldProject, '.git')),
    projectMemoryKey(oldProject)
  ]
  const targetDir = join(projectsDir, newMemKey)
  try {
    new MemoryFiles(root).withCatalogLease(() => {
      try {
        lstatSync(targetDir)
        // Destination scope already has memory files; never clobber existing notes.
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      for (const oldKey of candidateOldKeys) {
        if (oldKey === newMemKey) continue
        const sourceDir = join(projectsDir, oldKey)
        try {
          const info = lstatSync(sourceDir)
          if (info.isDirectory() && !info.isSymbolicLink()) {
            renameSync(sourceDir, targetDir)
            return
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    })
  } catch {
    // Absence of initialized memory catalog or busy lease does not block project relocation.
  }
}

async function relocateBotTasks(oldProject: string, nextProject: string): Promise<void> {
  const store = new BotStore(pigPath('bot'))
  const existing = await store.readTasks().catch(() => [])
  if (!existing.some((task) => task.projectCwd === oldProject)) return
  await store.updateTasks((tasks) => ({
    tasks: tasks.map((task) => {
      if (task.projectCwd !== oldProject) return task
      return {
        ...task,
        projectCwd: nextProject,
        workspace:
          task.workspace.kind === 'project' && task.workspace.cwd === oldProject
            ? { ...task.workspace, cwd: nextProject }
            : task.workspace
      }
    }),
    result: undefined
  }))
}

async function assertProjectIdleForRelocation(projectCwd: string, cwds: ReadonlySet<string>): Promise<void> {
  for (const path of cwds) {
    if (hasBusySessionsForCwd(path)) throw new Error(t('project.relocateBusy'))
  }
  for (const state of openSessions()) {
    if (!cwds.has(state.cwd)) continue
    if (hasRunningSessionProcesses(state.sessionId)) throw new Error(t('project.relocateBusy'))
    if (subagentManager.snapshot(state.sessionId).some((item) => item.status === 'running' || item.status === 'queued')) {
      throw new Error(t('project.relocateBusy'))
    }
  }
  const sessionFiles = await listJsonlFiles(sessionDirForCwd(projectCwd))
  for (const file of sessionFiles) {
    const firstLine = (await readFile(file, 'utf8')).split('\n', 1)[0] || '{}'
    const header = JSON.parse(firstLine) as { id?: unknown }
    if (
      typeof header.id === 'string' &&
      subagentManager.snapshot(header.id).some((item) => item.status === 'running' || item.status === 'queued')
    ) {
      throw new Error(t('project.relocateBusy'))
    }
  }
  const botTasks = await new BotStore(pigPath('bot')).readTasks().catch(() => [])
  if (botTasks.some((task) => task.projectCwd === projectCwd && isBotTaskActive(task.status))) {
    throw new Error(t('project.relocateBusy'))
  }
}

async function withOrderedProjectLocks<T>(cwds: string[], fn: () => Promise<T>): Promise<T> {
  const unique = [...new Set(cwds.map((cwd) => resolve(cwd)))].sort()
  const acquire = (index: number): Promise<T> =>
    index >= unique.length
      ? fn()
      : worktrees.exclusive(unique[index]!, () => acquire(index + 1))
  return acquire(0)
}

export async function renameProjectDirectory(cwd: string, name: unknown): Promise<ProjectGroup> {
  const projectCwd = await requireOpenedProject(cwd)
  await renameOpenedProject(projectCwd, name)
  sendToAllWindows('projects:changed', projectCwd)
  return loadWorktreeProject(projectCwd)
}

export async function relocateProjectDirectory(
  oldCwd: string,
  newPath: string
): Promise<RelocateProjectResult> {
  const sourceProject = await requireOpenedProject(oldCwd)
  const picked = await resolveProjectDirectory(newPath)
  assertSafeProjectTarget(picked)
  const targetProject = await canonicalProject(picked)

  if (targetProject === sourceProject) {
    const project = await loadWorktreeProject(sourceProject)
    sendToAllWindows('projects:changed', sourceProject)
    return { oldCwd: sourceProject, project, migratedSessionIds: [] }
  }

  return withOrderedProjectLocks([sourceProject, targetProject], async () => {
    await requireOpenedProject(sourceProject)
    const opened = await listOpenedCwds()
    const targetAlreadyOpen = opened.includes(targetProject)
    // Reject silently snapping a non-repo subfolder into an enclosing parent Git repo that is already open.
    if (targetAlreadyOpen && targetProject !== picked) {
      throw new Error(t('project.relocateInsideOpenRepo', { repo: targetProject }))
    }

    const sourceDiscovered = await worktrees.discover(sourceProject).catch(() => [])
    const targetDiscovered = targetAlreadyOpen ? await worktrees.discover(targetProject).catch(() => []) : []
    const allCwds = new Set([
      sourceProject,
      ...sourceDiscovered.map((item) => item.cwd),
      ...(targetAlreadyOpen ? [targetProject, ...targetDiscovered.map((item) => item.cwd)] : [])
    ])
    await assertProjectIdleForRelocation(sourceProject, allCwds)
    if (targetAlreadyOpen) {
      await assertProjectIdleForRelocation(targetProject, allCwds)
    }

    return worktrees.withBlockedCwds([...allCwds, targetProject], async () => {
      await closeSessionsForCwd(sourceProject, 'project_removed')
      if (targetAlreadyOpen) {
        await closeSessionsForCwd(targetProject, 'project_removed')
      }
      closeWorktreeWatch(sourceProject)
      forgetKnownWorktrees([sourceProject])

      // 1. Migrate primary project Pi JSONL sessions first so any I/O failure aborts before state mutations.
      const oldSessionDir = sessionDirForCwd(sourceProject)
      const newSessionDir = sessionDirForCwd(targetProject)
      const filesToMigrate = await listJsonlFiles(oldSessionDir)
      const writtenFiles: string[] = []
      const migratedOldFiles: string[] = []
      const relocations = new Map<string, { oldFile: string; newFile: string }>()

      if (filesToMigrate.length > 0) {
        await mkdir(newSessionDir, { recursive: true })
        try {
          for (const oldFile of filesToMigrate) {
            const newFile = join(newSessionDir, basename(oldFile))
            const alreadyAtTarget = await stat(newFile).then((s) => s.isFile()).catch(() => false)
            if (alreadyAtTarget) continue
            const [rawBytes, fileStat] = await Promise.all([readFile(oldFile), stat(oldFile)])
            const { bytes, sessionId } = rewriteSessionJsonlCwd(rawBytes, targetProject)
            const temp = `${newFile}.${randomUUID()}.tmp`
            try {
              await writeFile(temp, bytes, { mode: 0o600, flag: 'wx' })
              await rename(temp, newFile)
            } finally {
              await rm(temp, { force: true })
            }
            await utimes(newFile, fileStat.atime, fileStat.mtime).catch(() => {})
            writtenFiles.push(newFile)
            migratedOldFiles.push(oldFile)
            if (sessionId) {
              relocations.set(sessionId, { oldFile, newFile })
            }
          }
        } catch (error) {
          await Promise.all(writtenFiles.map((file) => rm(file, { force: true }).catch(() => {})))
          throw error
        }
      }

      // 2. Update managed worktree records and run `git worktree repair` for moved repository pointers.
      const managedCwds = await worktrees.relocateProject(sourceProject, targetProject)
      const targetHasGit = await isGitProject(targetProject).catch(() => false)
      if (targetHasGit) {
        const existingManaged = (
          await Promise.all(
            managedCwds.map(async (wtCwd) =>
              (await stat(wtCwd).then((s) => s.isDirectory()).catch(() => false)) ? wtCwd : null
            )
          )
        ).filter((wtCwd): wtCwd is string => wtCwd !== null)
        await git(targetProject, ['worktree', 'repair', ...existingManaged]).catch(() => {})
      }

      // 3. Migrate long-term file memory directory (`projects/<oldHash>` -> `projects/<newHash>`).
      const targetWorkspace = await sessionWorkspace(targetProject).catch(() => null)
      if (targetWorkspace) {
        const newMemKey = projectMemoryKey(targetWorkspace.gitCommonDir ?? targetWorkspace.cwd)
        migrateProjectLongTermMemory(sourceProject, newMemKey)
      }

      // 4. Update all Pig cwd-keyed registries and cross-references.
      await replaceOpenedProjectCwd(sourceProject, targetProject)
      const nextSpaces = await projectSpaces.relocateProject(sourceProject, targetProject)
      sendToAllWindows('spaces:changed', nextSpaces)
      await relocateOpenProjectWorkspace(sourceProject, targetProject)

      const migratedSessionIds = [...relocations.keys()]
      if (relocations.size > 0) {
        await Promise.all(
          [...relocations.entries()].map(([sessionId, { oldFile, newFile }]) =>
            relocateSubagentParentFile(sessionId, oldFile, newFile).catch(() => {})
          )
        )
        const bookmarkTargets = new Map(
          [...relocations.entries()].map(([sessionId, { newFile }]) => [
            sessionId,
            { path: newFile, cwd: targetProject, kind: 'project' as const }
          ])
        )
        const prevBookmarks = await bookmarks.list().catch(() => null)
        const nextBookmarks = await bookmarks.relocateSessions(bookmarkTargets).catch(() => null)
        if (prevBookmarks && nextBookmarks && nextBookmarks.revision !== prevBookmarks.revision) {
          sendToAllWindows('bookmarks:changed')
        }
      }

      await kanban.relocateProject(sourceProject, targetProject, migratedSessionIds).catch(() => {})
      await relocateBotTasks(sourceProject, targetProject).catch(() => {})

      // 5. Remove migrated JSONL files from the old session folder and clean up branch watchers.
      for (const oldFile of migratedOldFiles) {
        forgetSessionName(oldFile)
        await rm(oldFile, { force: true }).catch(() => {})
      }
      await rmdir(oldSessionDir).catch(() => {})
      forgetProjectBranches(sourceProject)

      const project = await loadWorktreeProject(targetProject)
      sendToAllWindows('projects:changed', targetProject)
      return { oldCwd: sourceProject, project, migratedSessionIds }
    })
  })
}
