/**
 * Project display-name aliasing, managed project creation (`~/pig_projects/<folderName>`),
 * physical directory moving, and full directory relocation (migrating Pi JSONL sessions,
 * repairing Git worktrees, and updating spaces, Kanban, bookmarks, subagent parent pointers,
 * open workspaces, Bot tasks, and long-term project memory).
 */
import { randomUUID } from 'node:crypto'
import { lstatSync, renameSync } from 'node:fs'
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  utimes,
  writeFile
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type {
  DefaultProjectsLocation,
  MoveProjectDialogTarget,
  MoveProjectInput,
  ProjectGroup,
  RelocateProjectResult
} from '../shared/api'
import { isBotTaskActive } from '../shared/bot'
import { bookmarks } from './bookmarks'
import { BotStore } from './bot/store'
import { isChatCwd, isChatsRoot } from './chats'
import { MemoryFiles, memoryRoot, projectMemoryKey } from './features/memory/long-term/files'
import { closeWorktreeWatch } from './git/watch'
import { t } from './i18n'
import { sendToAllWindows as broadcastToWindows } from './ipc/send'
import { kanban } from './kanban/service'
import { relocateOpenProjectWorkspace } from './open-project-sessions'
import { listOpenedCwds, renameOpenedProject, replaceOpenedProjectCwd } from './opened-projects'
import { forgetSessionName, listJsonlFiles, sessionDirForCwd } from './pi/session-loader'
import { closeSessionsForCwd, hasBusySessionsForCwd, openSessions } from './pi/session-registry'
import { pigDir, pigPath } from './pig-dir'
import { hasRunningSessionProcesses } from './processes'
import { resolveProjectDirectory } from './project-directory-browser'
import { openProjectDirectory } from './project-open'
import { projectSpaces } from './project-spaces'
import { forgetProjectBranches, loadWorktreeProject, requireOpenedProject, worktrees } from './project-worktrees'
import { realTarget } from './sandbox/path'
import { within } from './sandbox/policy'
import { sessionWorkspace } from './sandbox/workspace'
import { manager as subagentManager } from './subagents/service'
import { forgetKnownWorktrees } from './worktree-access'
import { canonicalProject, git, isGitProject } from './worktrees'

function userHomeDir(): string {
  return resolve(process.env.HOME || homedir())
}

export async function getDefaultProjectsLocation(): Promise<DefaultProjectsLocation> {
  const homeDir = userHomeDir()
  const defaultParentDir = join(homeDir, 'pig_projects')
  const info = await stat(defaultParentDir).catch(() => null)
  return {
    defaultParentDir,
    parentExists: info?.isDirectory() ?? false,
    homeDir
  }
}

function sendToAllWindows(channel: string, payload?: unknown): void {
  if (payload === undefined) broadcastToWindows(channel)
  else broadcastToWindows(channel, payload)
}

export async function isManagedPigProjectDir(cwd: string): Promise<boolean> {
  if (typeof cwd !== 'string' || !cwd.trim()) return false
  const { defaultParentDir } = await getDefaultProjectsLocation()
  const parentInfo = await stat(defaultParentDir).catch(() => null)
  if (!parentInfo?.isDirectory()) return false
  const realParent = await realpath(defaultParentDir).catch(() => resolve(defaultParentDir))
  const resolved = resolve(cwd)
  const info = await lstat(resolved).catch(() => null)
  if (!info?.isDirectory() || info.isSymbolicLink()) return false
  const realCwd = await realpath(resolved).catch(() => resolved)
  return dirname(realCwd) === realParent
}

export async function listManagedPigProjects(): Promise<string[]> {
  const { defaultParentDir } = await getDefaultProjectsLocation()
  const entries = await readdir(defaultParentDir, { withFileTypes: true }).catch(() => [])
  const realParent = await realpath(defaultParentDir).catch(() => resolve(defaultParentDir))
  const results: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') || !entry.isDirectory() || entry.isSymbolicLink()) continue
    const candidate = join(realParent, entry.name)
    const real = await realpath(candidate).catch(() => candidate)
    results.push(real)
  }
  return results
}

function normalizeFolderName(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error(t('project.moveDialog.invalidName'))
  const trimmed = raw.trim()
  if (
    !trimmed ||
    trimmed.length > 200 ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('\0')
  ) {
    throw new Error(t('project.moveDialog.invalidName'))
  }
  return trimmed
}

function resolveParentDir(raw: unknown): string {
  const home = userHomeDir()
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) {
    return join(home, 'pig_projects')
  }
  if (typeof raw !== 'string') {
    throw new Error(t('project.moveDialog.invalidParent'))
  }
  const trimmed = raw.trim()
  const expanded =
    trimmed === '~'
      ? home
      : trimmed.startsWith('~/') || trimmed.startsWith('~\\')
        ? join(home, trimmed.slice(2))
        : trimmed
  if (!isAbsolute(expanded)) {
    throw new Error(t('project.moveDialog.invalidParent'))
  }
  return resolve(expanded)
}

function assertSafeProjectTarget(targetDir: string): void {
  const resolved = resolve(targetDir)
  const home = userHomeDir()
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

async function migrateRelocatedProjectState(
  sourceProject: string,
  targetProject: string
): Promise<RelocateProjectResult> {
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
  const openedBefore = await listOpenedCwds()
  if (openedBefore.includes(sourceProject)) {
    await replaceOpenedProjectCwd(sourceProject, targetProject)
  } else {
    await openProjectDirectory(targetProject)
  }
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
      return migrateRelocatedProjectState(sourceProject, targetProject)
    })
  })
}

async function resolveMovableProject(cwd: string): Promise<string> {
  if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('Project cwd is required')
  const resolved = resolve(cwd)
  const opened = await listOpenedCwds()
  if (opened.includes(resolved)) return resolved
  const real = await realpath(resolved).catch(() => resolved)
  if (opened.includes(real)) return real
  if (await isManagedPigProjectDir(real)) return real
  return requireOpenedProject(cwd)
}

export async function moveProjectDirectory(input: MoveProjectInput): Promise<RelocateProjectResult> {
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid move project request')
  }
  const sourceProject = await resolveMovableProject(input.oldCwd)
  const sourceStat = await stat(sourceProject).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (!sourceStat?.isDirectory()) {
    throw new Error(t('project.moveDialog.sourceMissing'))
  }

  const folderName = normalizeFolderName(input.folderName)
  const rawParentDir = resolveParentDir(input.parentDir)
  const prelimTarget = resolve(rawParentDir, folderName)
  assertSafeProjectTarget(prelimTarget)

  if (prelimTarget === sourceProject) {
    const project = await loadWorktreeProject(sourceProject)
    return { oldCwd: sourceProject, project, migratedSessionIds: [] }
  }
  if (within(sourceProject, prelimTarget) || within(prelimTarget, sourceProject)) {
    throw new Error(t('project.moveDialog.nestedTarget'))
  }

  await mkdir(rawParentDir, { recursive: true })
  const realParent = await realpath(rawParentDir)
  const targetDir = join(realParent, folderName)
  assertSafeProjectTarget(targetDir)

  if (targetDir === sourceProject) {
    const project = await loadWorktreeProject(sourceProject)
    return { oldCwd: sourceProject, project, migratedSessionIds: [] }
  }
  if (within(sourceProject, targetDir) || within(targetDir, sourceProject)) {
    throw new Error(t('project.moveDialog.nestedTarget'))
  }

  return withOrderedProjectLocks([sourceProject, targetDir], async () => {
    await resolveMovableProject(sourceProject)
    const opened = await listOpenedCwds()
    if (opened.includes(targetDir)) {
      throw new Error(t('project.moveDialog.targetNotEmpty'))
    }
    const enclosingOpenRepo = opened.find((cwd) => cwd !== sourceProject && within(cwd, targetDir))
    if (enclosingOpenRepo) {
      throw new Error(t('project.relocateInsideOpenRepo', { repo: enclosingOpenRepo }))
    }

    const existingTarget = await lstat(targetDir).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (existingTarget && (!existingTarget.isDirectory() || existingTarget.isSymbolicLink())) {
      throw new Error(t('project.moveDialog.targetNotDirectory'))
    }
    if (existingTarget) {
      const entries = await readdir(targetDir)
      if (entries.length > 0) {
        throw new Error(t('project.moveDialog.targetNotEmpty'))
      }
    }

    const sourceDiscovered = await worktrees.discover(sourceProject).catch(() => [])
    const allCwds = new Set([sourceProject, ...sourceDiscovered.map((item) => item.cwd)])
    await assertProjectIdleForRelocation(sourceProject, allCwds)

    return worktrees.withBlockedCwds([...allCwds, targetDir], async () => {
      await closeSessionsForCwd(sourceProject, 'project_removed')
      closeWorktreeWatch(sourceProject)
      forgetKnownWorktrees([sourceProject])

      if (existingTarget) {
        await rmdir(targetDir)
      }

      try {
        await rename(sourceProject, targetDir)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
        try {
          await cp(sourceProject, targetDir, { recursive: true, verbatimSymlinks: true })
        } catch (copyError) {
          await rm(targetDir, { recursive: true, force: true }).catch(() => {})
          throw copyError
        }
        await rm(sourceProject, { recursive: true, force: true })
      }

      const targetProject = await canonicalProject(await resolveProjectDirectory(targetDir))
      return migrateRelocatedProjectState(sourceProject, targetProject)
    })
  })
}

async function copySafeFromWorkspace(srcRoot: string, subpath: string, destDir: string): Promise<boolean> {
  const rootReal = realTarget(srcRoot)
  const cleanSub = subpath.trim()
  const resolvedSrc = cleanSub === '.' || cleanSub === '' ? resolve(srcRoot) : resolve(srcRoot, cleanSub)
  const srcReal = realTarget(resolvedSrc)
  if (srcReal !== rootReal && !within(rootReal, srcReal)) {
    throw new Error('Source path must stay inside Bot workspace')
  }
  const info = await lstat(resolvedSrc).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (!info) throw new Error(`Bot workspace path does not exist: ${cleanSub}`)
  if (info.isSymbolicLink()) {
    throw new Error('Symbolic links in Bot workspace cannot be copied into a project')
  }

  let copiedAny = false
  const copyTree = async (fromDir: string, toDir: string): Promise<void> => {
    await mkdir(toDir, { recursive: true })
    const entries = await readdir(fromDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === '.git') continue
      const fromChild = join(fromDir, entry.name)
      const childStat = await lstat(fromChild)
      if (childStat.isSymbolicLink()) continue
      const toChild = join(toDir, entry.name)
      if (childStat.isDirectory()) {
        await copyTree(fromChild, toChild)
      } else if (childStat.isFile()) {
        await copyFile(fromChild, toChild)
        copiedAny = true
      }
    }
  }

  if (info.isFile()) {
    await copyFile(resolvedSrc, join(destDir, basename(resolvedSrc)))
    return true
  }
  if (info.isDirectory()) {
    await copyTree(resolvedSrc, destDir)
    return copiedAny
  }
  return false
}

export interface CreateManagedProjectOptions {
  folderName: string
  displayName?: string
  fromWorkspaceSubpath?: string
  botWorkspaceDir?: string
  initGit?: boolean
}

export async function reserveManagedProjectDirectory(
  rawFolderName: string,
  check?: () => void
): Promise<{ cwd: string; folderName: string; createdTarget: boolean }> {
  const folderName = normalizeFolderName(rawFolderName)
  const { defaultParentDir } = await getDefaultProjectsLocation()
  await mkdir(defaultParentDir, { recursive: true })
  const realParent = await realpath(defaultParentDir)
  const targetDir = join(realParent, folderName)
  assertSafeProjectTarget(targetDir)

  const existing = await lstat(targetDir).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw new Error(t('project.moveDialog.targetNotDirectory'))
  }
  if (existing) {
    const entries = await readdir(targetDir)
    if (entries.length > 0) {
      throw new Error(t('project.moveDialog.targetNotEmpty'))
    }
  }

  check?.()
  const createdTarget = !existing
  await mkdir(targetDir, { recursive: true })
  const cwd = await realpath(targetDir)
  return { cwd, folderName, createdTarget }
}

export async function initializeManagedProjectDirectory(
  targetDir: string,
  options: {
    fromWorkspaceSubpath?: string
    botWorkspaceDir?: string
    initGit?: boolean
    createdTarget?: boolean
  },
  check?: () => void
): Promise<string> {
  try {
    let copiedAny = false
    if (options.fromWorkspaceSubpath?.trim()) {
      if (!options.botWorkspaceDir) {
        throw new Error('Bot workspace directory is unavailable')
      }
      copiedAny = await copySafeFromWorkspace(options.botWorkspaceDir, options.fromWorkspaceSubpath, targetDir)
    }

    if (options.initGit !== false) {
      try {
        await git(targetDir, ['init', '-b', 'main'])
      } catch {
        await git(targetDir, ['init'])
      }
      if (copiedAny) {
        await git(targetDir, ['add', '-A'])
        await git(targetDir, ['-c', 'user.name=Pig', '-c', 'user.email=pig@local', 'commit', '-m', 'chore: initial files'])
      }
    }

    check?.()
    return await canonicalProject(await resolveProjectDirectory(targetDir))
  } catch (error) {
    if (options.createdTarget) {
      await rm(targetDir, { recursive: true, force: true }).catch(() => {})
    }
    throw error
  }
}

export async function createManagedProjectDirectory(
  options: CreateManagedProjectOptions,
  check?: () => void
): Promise<ProjectGroup> {
  const reserved = await reserveManagedProjectDirectory(options.folderName, check)
  const canonicalTarget = await initializeManagedProjectDirectory(
    reserved.cwd,
    {
      fromWorkspaceSubpath: options.fromWorkspaceSubpath,
      botWorkspaceDir: options.botWorkspaceDir,
      initGit: options.initGit,
      createdTarget: reserved.createdTarget
    },
    check
  )
  const displayName = options.displayName?.trim()
  return {
    cwd: canonicalTarget,
    name: displayName || basename(canonicalTarget) || reserved.folderName,
    ...(displayName ? { customName: displayName } : {}),
    hasGit: options.initGit !== false,
    sessions: []
  }
}

export async function requestMoveProjectDialog(
  cwd: string,
  options?: { suggestedFolderName?: string; suggestedParentDir?: string }
): Promise<MoveProjectDialogTarget> {
  const projectCwd = await resolveMovableProject(cwd)
  const opened = await listOpenedCwds()
  const project = opened.includes(projectCwd)
    ? await loadWorktreeProject(projectCwd)
    : { cwd: projectCwd, name: basename(projectCwd) || projectCwd }
  const target: MoveProjectDialogTarget = {
    cwd: project.cwd,
    name: project.name,
    ...(options?.suggestedFolderName?.trim() ? { suggestedFolderName: options.suggestedFolderName.trim() } : {}),
    ...(options?.suggestedParentDir?.trim() ? { suggestedParentDir: options.suggestedParentDir.trim() } : {})
  }
  sendToAllWindows('projects:request-move', target)
  return target
}
