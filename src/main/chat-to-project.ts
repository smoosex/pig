/**
 * Converts a standalone Chat (`$PIG_DIR/chats/<id>`) into a dedicated Project directory
 * (defaulting under `$HOME/pig_projects/<folderName>`), copying workspace files and optionally
 * migrating its Pi JSONL session history, subagent parent links, bookmarks, and Kanban links.
 */
import * as electron from 'electron'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type {
  ConvertChatToProjectInput,
  ConvertChatToProjectResult,
  DefaultProjectsLocation
} from '../shared/api'
import { bookmarks } from './bookmarks'
import { isChatCwd, isChatsRoot, removeChatWorkDir } from './chats'
import { t } from './i18n'
import { kanban } from './kanban/service'
import { forgetSessionName, listJsonlFiles, sessionDirForCwd } from './pi/session-loader'
import { closeSessionsForCwd, hasBusySessionsForCwd } from './pi/session-registry'
import { pigDir, pigPath } from './pig-dir'
import { resolveProjectDirectory } from './project-directory-browser'
import { openProjectDirectory } from './project-open'
import { within } from './sandbox/policy'
import { manager as subagentManager } from './subagents/service'
import { canonicalProject } from './worktrees'

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

function normalizeFolderName(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error(t('sessions.convertDialog.invalidName'))
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
    throw new Error(t('sessions.convertDialog.invalidName'))
  }
  return trimmed
}

function resolveParentDir(raw: unknown): string {
  const home = userHomeDir()
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) {
    return join(home, 'pig_projects')
  }
  if (typeof raw !== 'string') {
    throw new Error(t('sessions.convertDialog.invalidParent'))
  }
  const trimmed = raw.trim()
  const expanded =
    trimmed === '~'
      ? home
      : trimmed.startsWith('~/') || trimmed.startsWith('~\\')
        ? join(home, trimmed.slice(2))
        : trimmed
  if (!isAbsolute(expanded)) {
    throw new Error(t('sessions.convertDialog.invalidParent'))
  }
  return resolve(expanded)
}

function assertSafeTargetDir(targetDir: string): void {
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
    throw new Error(t('sessions.convertDialog.unsafeTarget'))
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

export async function convertChatToProject(
  input: ConvertChatToProjectInput
): Promise<ConvertChatToProjectResult> {
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid convert request')
  }
  if (typeof input.chatCwd !== 'string' || !input.chatCwd || !isChatCwd(input.chatCwd)) {
    throw new Error('Chat cwd is required')
  }
  const sourceChatDir = resolve(input.chatCwd)
  const folderName = normalizeFolderName(input.folderName)
  const parentDir = resolveParentDir(input.parentDir)
  const targetDir = resolve(parentDir, folderName)
  assertSafeTargetDir(targetDir)

  const existingTarget = await stat(targetDir).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (existingTarget && !existingTarget.isDirectory()) {
    throw new Error(t('sessions.convertDialog.targetNotDirectory'))
  }
  if (existingTarget) {
    const entries = await readdir(targetDir)
    if (entries.length > 0) {
      throw new Error(t('sessions.convertDialog.targetNotEmpty'))
    }
  }

  if (hasBusySessionsForCwd(sourceChatDir)) {
    throw new Error(t('sessions.convertDialog.sessionBusy'))
  }
  const chatSessionFiles = await listJsonlFiles(sessionDirForCwd(sourceChatDir))
  for (const file of chatSessionFiles) {
    const header = JSON.parse(
      (await readFile(file, 'utf8')).split('\n', 1)[0] || '{}'
    ) as { id?: unknown }
    if (
      typeof header.id === 'string' &&
      subagentManager.snapshot(header.id).some((item) => item.status === 'running' || item.status === 'queued')
    ) {
      throw new Error(t('sessions.convertDialog.sessionBusy'))
    }
  }

  const createdTarget = !existingTarget
  await mkdir(targetDir, { recursive: true })
  try {
    const sourceStat = await stat(sourceChatDir).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (sourceStat?.isDirectory()) {
      const entries = await readdir(sourceChatDir)
      for (const name of entries) {
        await cp(join(sourceChatDir, name), join(targetDir, name), {
          recursive: true,
          verbatimSymlinks: true
        })
      }
    }
  } catch (error) {
    if (createdTarget) {
      await rm(targetDir, { recursive: true, force: true }).catch(() => {})
    }
    throw error
  }

  const canonicalTarget = await canonicalProject(await resolveProjectDirectory(targetDir))

  if (!input.transferSession) {
    const project = await openProjectDirectory(canonicalTarget)
    return { project, migratedSessionIds: [] }
  }

  await closeSessionsForCwd(sourceChatDir)

  const oldSessionDir = sessionDirForCwd(sourceChatDir)
  const filesToMigrate = await listJsonlFiles(oldSessionDir)
  const newSessionDir = sessionDirForCwd(canonicalTarget)
  const writtenFiles: string[] = []
  const relocations = new Map<string, { oldFile: string; newFile: string }>()

  if (filesToMigrate.length > 0) {
    await mkdir(newSessionDir, { recursive: true })
    try {
      for (const oldFile of filesToMigrate) {
        const [rawBytes, fileStat] = await Promise.all([readFile(oldFile), stat(oldFile)])
        const { bytes, sessionId } = rewriteSessionJsonlCwd(rawBytes, canonicalTarget)
        const newFile = join(newSessionDir, basename(oldFile))
        const temp = `${newFile}.${randomUUID()}.tmp`
        try {
          await writeFile(temp, bytes, { mode: 0o600, flag: 'wx' })
          await rename(temp, newFile)
        } finally {
          await rm(temp, { force: true })
        }
        await utimes(newFile, fileStat.atime, fileStat.mtime).catch(() => {})
        writtenFiles.push(newFile)
        if (sessionId) {
          relocations.set(sessionId, { oldFile, newFile })
        }
      }
    } catch (error) {
      await Promise.all(writtenFiles.map((f) => rm(f, { force: true }).catch(() => {})))
      throw error
    }
  }

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
        { path: newFile, cwd: canonicalTarget, kind: 'project' as const }
      ])
    )
    const prevBookmarks = await bookmarks.list().catch(() => null)
    const nextBookmarks = await bookmarks.relocateSessions(bookmarkTargets).catch(() => null)
    if (prevBookmarks && nextBookmarks && nextBookmarks.revision !== prevBookmarks.revision) {
      for (const win of electron.BrowserWindow?.getAllWindows?.() ?? []) {
        if (!win.isDestroyed()) win.webContents.send('bookmarks:changed')
      }
    }
    await kanban.relocateLinkedSessions(migratedSessionIds, canonicalTarget).catch(() => {})
  }

  const project = await openProjectDirectory(canonicalTarget)

  for (const oldFile of filesToMigrate) {
    forgetSessionName(oldFile)
  }
  await rm(oldSessionDir, { recursive: true, force: true })
  await removeChatWorkDir(sourceChatDir)

  return { project, migratedSessionIds }
}
