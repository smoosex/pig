/**
 * Own pending sessions, live SDK sessions, and in-flight initialization.
 *
 * Publish sessions only after extensions and pending controls are ready.
 * Closing a directory waits for its builds before the caller removes it.
 */
import { existsSync, statSync } from 'node:fs'
import { writeFile, rm } from 'node:fs/promises'
import type { BrowserWindow } from 'electron'
import { createAgentSession, getAgentDir, SessionManager, type AgentSession, type SessionEntry, type ResourceLoader } from '@earendil-works/pi-coding-agent'
import { t } from '../i18n'
import type {
  DisplayTurnsResult,
  FollowUpAction,
  ForkedSessionRef,
  PromptStreamingBehavior,
  SessionControls,
  SessionBranchOptions,
  SessionTokenStats,
  SessionTreeRow,
  SessionTreeView,
  SessionWindowMessage,
  ThinkingLevel
} from '../../shared/api'
import { normalizeWorktreePath as resolve } from '../worktrees'
import { createChatDir, isChatCwd } from '../chats'
import { worktrees } from '../project-worktrees'
import { createChatResourceLoader, createNoExtensionsResourceLoader, sessionResourceSettings } from './chat-resources'
import { sessionToolFactory } from './tool-resources'
import { cancelExtensionUI, createExtensionUI } from '../extension-ui'
import { emitToolSettingsChanged } from '../mcp/events'
import { beginSessionInput, bridgeEvents, isSessionRunActive } from './event-bridge'
import { enabledPluginPaths } from './plugins'
import { attachSystemUI, detachSystemUI, resetSystemUI } from './system-plugin-ui'
import { startModelRuntime } from './model-settings'
import {
  applyPendingControls,
  controlsFor,
  tokenStatsFor,
  setSessionModel as applyModel,
  setSessionThinking as applyThinking,
  refreshSessionModels as refreshModels
} from './session-controls'
import {
  exportSession as exportAgentSession,
  listSessionCommands as commandsFor,
  updateFollowUpMessage as updateFollowUp
} from './session-actions'
import { buildSessionTreeViews, SESSION_TREE_VIEWS } from './session-tree'
import { switchSessionBranch } from './session-branch'
import { forkSessionManager } from './session-fork'
import {
  displayWindow,
  fileSource,
  managerSource,
  openTail,
  sessionIndex,
  windowUpdate,
  type SessionSource
} from './session-source'
import {
  appendLabelChange,
  appendSessionInfo,
  readEntryById,
  readSessionHeader,
  UnsupportedSessionFile,
  type SessionHeader
} from './session-jsonl'
import { CURRENT_SESSION_VERSION } from '@earendil-works/pi-coding-agent'
import { forgetSessionName, isSessionFile, sessionDirForCwd } from './session-loader'
import type {
  LiveSession,
  MemorySession,
  PendingSession,
  SessionFileSession,
  SessionState
} from './session-state'

export type {
  DefaultSessionSettings,
  FollowUpAction,
  SessionContextUsage,
  SessionControls,
  SessionModelInfo,
  SessionTokenStats,
  SessionTreeGutter,
  SessionTreeRow,
  SessionTreeView,
  SlashCommand as SessionSlashCommand,
  SlashCommandSource as SessionSlashSource,
  ThinkingLevel as SessionThinkingLevel
} from '../../shared/api'
export type { MemorySession, PendingSession, SessionFileSession } from './session-state'
export {
  getDefaultSessionSettings,
  listAvailableModels,
  setDefaultModel,
  setDefaultThinking,
  startModelRuntime
} from './model-settings'

interface Preparation {
  cwd: string
  promise: Promise<LiveSession>
}

export interface OpenSessionPreview {
  sessionId: string
  cwd: string
  display: DisplayTurnsResult
}

const live = new Map<string, LiveSession>()
const pending = new Map<string, PendingSession>()
/** Draft sessions by id: the file they own, which stays absent until the first send. */
const drafts = new Map<string, string>()
const preparing = new Map<string, Preparation>()
const closing = new Map<string, { cwd: string; promise: Promise<void> }>()
const resourceFailures = new Map<string, Error>()
class SessionResourceError extends Error { readonly code = 'ERR_SESSION_RESOURCES_UNAVAILABLE' }
function assertExtensionResources(loader: ResourceLoader): void {
  const errors = loader.getExtensions().errors
  if (errors.length) throw new SessionResourceError(errors.map((item) => `${item.path}: ${item.error}`).join('\n'))
}
async function reloadSessionResources(session: LiveSession): Promise<void> {
  try {
    await session.agentSession.reload({ beforeSessionStart: async () => assertExtensionResources(session.agentSession.resourceLoader) })
    assertExtensionResources(session.agentSession.resourceLoader)
    resourceFailures.delete(session.sessionId)
  } catch (error) {
    // SDK IO failures and loader-recorded factory errors both leave a replaced, unusable runtime.
    const failure = new SessionResourceError(`Session resources unavailable: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    resourceFailures.set(session.sessionId, failure)
    pendingToolRefresh.add(session.sessionId)
    throw failure
  }
}
function reportBackgroundReload(session: LiveSession, promise: Promise<void>): void {
  void promise.catch((error) => {
    // Background settings updates have no invoke caller; retain the blocked session and notify its owner.
    console.error('Could not reload session resources:', error)
    if (session.win && !session.win.isDestroyed() && !session.win.webContents.isDestroyed()) {
      session.win.webContents.send('system-plugins:ui', {
        kind: 'notify', sessionId: session.sessionId, plugin: 'host', level: 'error',
        message: error instanceof Error ? error.message : String(error)
      })
    }
  })
}

function trackPreparation(
  sessionId: string,
  cwd: string,
  building: Promise<LiveSession>
): Promise<LiveSession> {
  const promise = building.then((session) => {
    live.set(sessionId, session)
    pending.delete(sessionId)
    return session
  }).finally(() => {
    preparing.delete(sessionId)
  })
  preparing.set(sessionId, { cwd, promise })
  return promise
}

async function build(
  sessionManager: SessionManager,
  cwd: string,
  win: BrowserWindow,
  configure?: (session: AgentSession) => Promise<void>
): Promise<LiveSession> {
  worktrees.assertAvailable(cwd)
  const pluginPaths = isChatCwd(cwd) ? undefined : await enabledPluginPaths()
  const settingsManager = sessionResourceSettings(cwd, getAgentDir())
  const resources = { settingsManager, extensionFactories: [sessionToolFactory(cwd)] }
  const resourceLoader = pluginPaths
    ? await createNoExtensionsResourceLoader(cwd, pluginPaths, resources)
    : await createChatResourceLoader(cwd, resources)
  assertExtensionResources(resourceLoader)
  const result = await createAgentSession({
    cwd,
    sessionManager,
    modelRuntime: await startModelRuntime(),
    settingsManager,
    ...(resourceLoader ? { resourceLoader } : {})
  })
  const session = result.session
  const created: LiveSession = {
    sessionId: session.sessionId,
    cwd,
    agentSession: session,
    unsubscribe: () => {},
    pluginPaths,
    win
  }
  try {
    worktrees.assertAvailable(cwd)
    const notifications = attachSystemUI(session.sessionId, win)
    // Pig owns session lifecycle, so extension-driven replacement is refused rather than faked as a
    // user cancellation; the notification is the only signal an extension (or the user) gets.
    const unsupportedAction = (what: string): { cancelled: boolean } => {
      notifications.notify(`${what} is not supported in Pig`, 'warning')
      return { cancelled: true }
    }
    await session.bindExtensions({
      mode: 'rpc',
      uiContext: await createExtensionUI(win, session.sessionId),
      // Pi binds these actions only in its own hosts; without them ctx.navigateTree is a no-op that
      // reports success, which stranded extensions that switch branches (like code review).
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: async () => unsupportedAction('Starting a new session'),
        fork: async () => unsupportedAction('Forking the session'),
        navigateTree: async (targetId, options) => {
          const result = await session.navigateTree(targetId, options)
          if (!result.cancelled && !win.isDestroyed()) {
            win.webContents.send('session:branch-changed', session.sessionId, session.sessionManager.getLeafId())
          }
          return { cancelled: result.cancelled }
        },
        switchSession: async () => unsupportedAction('Switching sessions'),
        reload: async () => {
          await reloadSessionResources(created)
        }
      },
      onError: (error) => notifications.notify(`${error.extensionPath}: ${error.error}`, 'error')
    })
    worktrees.assertAvailable(cwd)
    await configure?.(session)
    worktrees.assertAvailable(cwd)
    created.unsubscribe = bridgeEvents(session, session.sessionId, win)
    return created
  } catch (error) {
    await disposeLiveSession(created)
    throw error
  }
}

function holdPendingSession(
  sessionManager: SessionManager,
  cwd: string,
  win: BrowserWindow,
  draft: boolean
): MemorySession {
  const sessionId = sessionManager.getSessionId()
  if (live.has(sessionId) || pending.has(sessionId) || preparing.has(sessionId) || closing.has(sessionId)) {
    throw new Error(`Session already exists: ${sessionId}`)
  }
  const session: MemorySession = {
    kind: 'memory',
    sessionId,
    cwd,
    sessionManager,
    win
  }
  const sessionFile = sessionManager.getSessionFile()
  if (!sessionFile) throw new Error('Pending session has no session file')
  pending.set(sessionId, session)
  if (draft) drafts.set(sessionId, sessionFile)
  return session
}

export function createPendingSession(
  cwd: string,
  win: BrowserWindow,
  options: { draft?: boolean; id?: string } = {}
): PendingSession {
  worktrees.assertAvailable(cwd)
  if (!statSync(cwd).isDirectory()) throw new Error(t('error.sessionCwdMissing'))
  const sessionManager = SessionManager.create(cwd, undefined, options.id ? { id: options.id } : undefined)
  return holdPendingSession(sessionManager, cwd, win, options.draft !== false)
}

export function promoteDraftSession(sessionId: string): string {
  if (!drafts.delete(sessionId)) throw new Error(`Draft session not found: ${sessionId}`)
  return sessionState(sessionId).cwd
}

/**
 * Renaming writes a `session_info` line, the SDK's own record for a session's display name: through
 * the manager when one holds the session, into the file when it is not open at all. A draft has no
 * file yet, so its entry waits in the manager until the first send publishes it.
 */
export async function renameSession(sessionId: string, name: string, path?: string): Promise<void> {
  const clean = name.replace(/[\r\n]+/g, ' ').trim()
  const session = live.get(sessionId) ?? pending.get(sessionId)
  if (session) {
    if ('agentSession' in session) {
      session.agentSession.setSessionName(clean)
      return
    }
    if (session.kind === 'memory') {
      session.sessionManager.appendSessionInfo(clean)
      return
    }
    appendSessionInfo(session.path, clean)
    // The index was built before that line existed: its leaf and its size both moved on.
    session.index = null
    session.indexing = null
    session.tailById = null
    session.treeRows = undefined
    session.treeRowsRequest = undefined
    forgetSessionName(session.path)
    return
  }
  if (!path) throw new Error(`Session not found: ${sessionId}`)
  // The check compares against the sessions root as it is spelled, so resolving first would reject a
  // root that is reached through a symlink.
  if (!isSessionFile(path)) throw new Error(`Invalid session path: ${path}`)
  appendSessionInfo(path, clean)
  forgetSessionName(path)
}

/**
 * Labeling writes a `label` line, the SDK's own bookmark record: through the manager when one holds
 * the session, into the file when it is not open at all. An empty label clears the mark.
 */
export async function setSessionLabel(
  sessionId: string,
  targetId: string,
  label: string,
  path?: string
): Promise<void> {
  const clean = label.replace(/[\r\n]+/g, ' ').trim()
  const session = live.get(sessionId) ?? pending.get(sessionId)
  if (session) {
    if ('agentSession' in session) {
      session.agentSession.sessionManager.appendLabelChange(targetId, clean)
      return
    }
    if (session.kind === 'memory') {
      session.sessionManager.appendLabelChange(targetId, clean)
      return
    }
    // The SDK fails fast on an unknown target; a hand-appended line cannot, so check first.
    const index = await sessionIndex(session)
    if (!index.byId.has(targetId)) throw new Error(`Entry ${targetId} not found`)
    appendLabelChange(session.path, targetId, clean)
    // The index and the tree below were built before that line existed.
    session.index = null
    session.indexing = null
    session.tailById = null
    session.treeRows = undefined
    session.treeRowsRequest = undefined
    return
  }
  if (!path) throw new Error(`Session not found: ${sessionId}`)
  // Same spelling rule as a rename: resolving first would reject a symlinked sessions root.
  // The target is not checked here: with no session held there is no index to ask, and building a
  // whole-file index for one id would cost more than the stray line it could prevent.
  if (!isSessionFile(path)) throw new Error(`Invalid session path: ${path}`)
  appendLabelChange(path, targetId, clean)
}

export async function discardDraftSession(sessionId: string): Promise<void> {
  const path = drafts.get(sessionId)
  if (path === undefined) return
  drafts.delete(sessionId)
  await closeSession(sessionId)
  // The path is computed when the draft is created, so a stranger's file may be sitting on it.
  if (!isOwnSessionFile(path, sessionId)) return
  await rm(path, { force: true })
}

function managerOf(session: LiveSession | MemorySession): SessionManager {
  return 'agentSession' in session ? session.agentSession.sessionManager : session.sessionManager
}

/** Whether a file already on disk is this session's own, rather than a stranger that owns its path. */
function isOwnSessionFile(path: string, sessionId: string): boolean {
  try {
    return readSessionHeader(path).sessionId === sessionId
  } catch (error) {
    if (error instanceof UnsupportedSessionFile) return false
    throw error
  }
}

/**
 * A session exists on disk from its first send, not from its first read: this writes the header and
 * whatever the manager already holds, then hands the file to the SDK so later entries append to it
 * instead of rewinding. A file this session already published is left alone.
 */
async function publishSessionFile(sessionId: string): Promise<{ created: boolean; path?: string }> {
  const session = sessionState(sessionId)
  // An opened file is persisted already, and building it is what hands over the manager.
  if (!('agentSession' in session) && session.kind === 'file') return { created: false }
  const manager = managerOf(session)
  const path = manager.getSessionFile()
  const header = manager.getHeader()
  worktrees.assertAvailable(session.cwd)
  if (!path || !header) throw new Error('Pending session has no session file or header')
  if (existsSync(path)) {
    // Only our own file may be adopted without a second handover: adopting a stranger's would leave
    // the manager detached and blow up in the SDK's write on the first assistant message.
    if (isOwnSessionFile(path, manager.getSessionId())) return { created: false }
    throw new Error(`Session file already exists: ${path}`)
  }

  const rows = [header, ...manager.getEntries()]
  await writeFile(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(''), { flag: 'wx' })
  try {
    manager.setSessionFile(path)
  } catch (error) {
    await rm(path, { force: true })
    throw error
  }
  return { created: true, path }
}

/**
 * The send path: the file comes first, so a build that fails can take it back out and leave no
 * empty session behind in the session directory.
 */
export async function activateSession(
  sessionId: string
): Promise<{ session: LiveSession; created: boolean }> {
  const { created, path } = await publishSessionFile(sessionId)
  try {
    return { session: await prepareSession(sessionId), created }
  } catch (error) {
    if (created && path) await rm(path, { force: true })
    throw error
  }
}

export async function activateSessionInput(sessionId: string) {
  const activated = await activateSession(sessionId)
  while (resourceReloads.has(sessionId)) await prepareSession(sessionId)
  if (closing.has(sessionId) || live.get(sessionId) !== activated.session) throw new Error(`Session is closing: ${sessionId}`)
  const failure = resourceFailures.get(sessionId)
  if (failure) throw failure
  return { ...activated, releaseInput: beginSessionInput(activated.session.agentSession) }
}

export function prepareSession(sessionId: string): Promise<LiveSession> {
  if (closing.has(sessionId)) throw new Error(`Session is closing: ${sessionId}`)
  const existing = live.get(sessionId)
  if (existing) {
    worktrees.assertAvailable(existing.cwd)
    return (resourceReloads.get(sessionId) ?? Promise.resolve()).then(() => {
      if (closing.has(sessionId) || live.get(sessionId) !== existing) throw new Error(`Session is closing: ${sessionId}`)
      const failure = resourceFailures.get(sessionId)
      if (failure) throw failure
      return existing
    })
  }

  const running = preparing.get(sessionId)
  if (running) return running.promise

  const session = pending.get(sessionId)
  if (!session) throw new Error(`Session not found: ${sessionId}`)

  // Every pending-to-live path applies the choices made before the first send: the SDK restores the
  // model and thinking level the session file recorded when the build gets no explicit ones.
  const configure = (created: AgentSession) => applyPendingControls(session, created)
  const building =
    session.kind === 'file'
      ? build(SessionManager.open(session.path), session.cwd, session.win, configure)
      : build(session.sessionManager, session.cwd, session.win, configure)
  return trackPreparation(sessionId, session.cwd, building)
}

function previewFor(source: SessionSource, cwd: string): OpenSessionPreview {
  return { sessionId: source.sessionId, cwd, display: displayWindow(source) }
}

/**
 * Opening only indexes the JSONL and reads the current branch, so the SDK build still waits for the
 * first interaction. A file this reader cannot vouch for falls back to the SDK's own parse.
 */
export async function openSession(path: string, win: BrowserWindow): Promise<OpenSessionPreview> {
  const target = resolve(path)
  for (const ls of live.values()) {
    if (ls.agentSession.sessionFile && resolve(ls.agentSession.sessionFile) === target) {
      if (closing.has(ls.sessionId)) throw new Error(`Session is closing: ${ls.sessionId}`)
      worktrees.assertAvailable(ls.cwd)
      return previewFor(managerSource(ls.agentSession.sessionManager), ls.cwd)
    }
  }

  let header: SessionHeader | null = null
  try {
    header = readSessionHeader(target)
  } catch (error) {
    if (!(error instanceof UnsupportedSessionFile)) throw error
  }

  if (!header || header.version < CURRENT_SESSION_VERSION) {
    // No header to trust, or one only the SDK can migrate: read the file through the manager.
    const manager = SessionManager.open(target)
    const sessionId = manager.getSessionId()
    const cwd = manager.getCwd() || process.cwd()
    worktrees.assertAvailable(cwd)
    if (closing.has(sessionId)) throw new Error(`Session is closing: ${sessionId}`)
    const opened = live.get(sessionId) ?? pending.get(sessionId)
    if (opened) return previewFor(await sourceFor(opened), cwd)
    const session: PendingSession = {
      kind: 'memory',
      sessionId,
      cwd,
      win,
      sessionManager: manager
    }
    pending.set(sessionId, session)
    return previewFor(managerSource(manager), cwd)
  }

  const cwd = header.cwd || process.cwd()
  worktrees.assertAvailable(cwd)
  const sessionId = header.sessionId
  if (closing.has(sessionId)) throw new Error(`Session is closing: ${sessionId}`)

  const opened = live.get(sessionId) ?? pending.get(sessionId)
  if (opened) {
    // A file whose index is still building answers with its tail rather than waiting for the index.
    if ('path' in opened && !opened.index) {
      scheduleIndex(opened)
      return { sessionId, cwd, display: openTail(sessionId, opened.path).display }
    }
    return previewFor(await sourceFor(opened), cwd)
  }

  const tail = openTail(sessionId, target)
  const session: PendingSession = {
    kind: 'file',
    sessionId,
    cwd,
    win,
    path: target,
    index: null,
    indexing: null,
    tailById: new Map(tail.entries.map((entry) => [entry.id, entry])),
    tailTurns: tail.display.turns.length
  }
  pending.set(sessionId, session)
  // The index only needs to exist before the next read that wants the whole branch, not before paint.
  scheduleIndex(session)
  return { sessionId, cwd, display: tail.display }
}

/**
 * Builds the branch index after the first paint and tells the renderer what the provisional window
 * could not know: where the tail sits in the branch and how heavy the turns above it are. A file the
 * reader refuses falls back to the SDK manager, which is what a session without an index needs.
 */
async function warmIndex(session: SessionFileSession): Promise<void> {
  // A session that was promoted to live has nobody left to answer, and its window is already stale.
  if (pending.get(session.sessionId) !== session || preparing.has(session.sessionId)) return
  let index
  try {
    index = await sessionIndex(session)
  } catch (error) {
    if (!(error instanceof UnsupportedSessionFile)) throw error
    downgradeFileSession(session)
    return
  }
  if (pending.get(session.sessionId) !== session || preparing.has(session.sessionId)) return
  session.tailById = null
  sendWindow(session, windowUpdate(fileSource(index), session.tailTurns))
}

/** Scans per file, so a file that keeps failing is not rescanned by every reopen. */
const MAX_INDEX_ATTEMPTS = 2

/** A failed scan is not a verdict on the file, so an open without an index asks for it again. */
function scheduleIndex(session: SessionFileSession): void {
  if (session.index || session.indexing || session.indexScheduled) return
  if ((session.indexAttempts ?? 0) >= MAX_INDEX_ATTEMPTS) return
  session.indexAttempts = (session.indexAttempts ?? 0) + 1
  session.indexScheduled = true
  setImmediate(() => {
    session.indexScheduled = false
    void warmIndex(session).catch((error: unknown) => {
      console.error('Failed to index session:', error)
      // The renderer is waiting on this index: without an answer it keeps promising older turns.
      sendWindow(session, { error: errorMessage(error) })
    })
  })
}

/**
 * A file the byte index cannot vouch for is read through the SDK's own parse from here on. Returns
 * the manager that replaced the file session, or null when the session already moved on.
 */
function downgradeFileSession(session: SessionFileSession): SessionManager | null {
  if (pending.get(session.sessionId) !== session) return null
  const replacement: PendingSession = {
    kind: 'memory',
    sessionId: session.sessionId,
    cwd: session.cwd,
    win: session.win,
    sessionManager: SessionManager.open(session.path),
    // A retried read must not lose the model the user just picked for this session.
    ...(session.modelProvider === undefined ? {} : { modelProvider: session.modelProvider }),
    ...(session.modelId === undefined ? {} : { modelId: session.modelId }),
    ...(session.thinkingLevel === undefined ? {} : { thinkingLevel: session.thinkingLevel })
  }
  pending.set(session.sessionId, replacement)
  // Whatever the renderer holds was described by the index that just disagreed with the file, so it
  // gets the SDK's own window for the same tail instead of waiting for the next read to correct it.
  sendWindow(session, windowUpdate(managerSource(replacement.sessionManager), session.tailTurns))
  return replacement.sessionManager
}

/**
 * Runs a read against the session, downgrading a file index the file contradicts: a byte-level index
 * can only prove a line's shape, so a row that parses to nothing means its counts are not the file's.
 * The retry goes through the SDK manager, which is the source of truth.
 */
async function retryAfterIndexFallback<T>(sessionId: string, read: () => T | Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (!(error instanceof UnsupportedSessionFile)) throw error
    const session = pending.get(sessionId)
    if (!session || session.kind !== 'file' || !downgradeFileSession(session)) throw error
    return await read()
  }
}

/** Controls come from the same last rows the reader indexes, so they retry like every other read. */
function readControls(sessionId: string): Promise<SessionControls> {
  return retryAfterIndexFallback(sessionId, () => controlsFor(sessionState(sessionId)))
}

/** The same retry for the readers that work off a `SessionSource`. */
export function withSource<T>(sessionId: string, read: (source: SessionSource) => T | Promise<T>): Promise<T> {
  return retryAfterIndexFallback(sessionId, async () => read(await sessionSourceFor(sessionId)))
}

function sendWindow(session: SessionFileSession, message: Omit<SessionWindowMessage, 'sessionId'>): void {
  if (!session.win.isDestroyed()) {
    session.win.webContents.send('session:window', { sessionId: session.sessionId, ...message })
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function getLive(sessionId: string): LiveSession | undefined {
  return live.get(sessionId)
}

export function sessionCwd(sessionId: string): string {
  return sessionState(sessionId).cwd
}

const refreshingPlugins = new Set<string>()
const queuedPluginRefresh = new Map<string, boolean>()

const resourceReloads = new Map<string, Promise<void>>()
const pendingToolRefresh = new Set<string>()

export function pendingToolSessions(): string[] { return [...pendingToolRefresh] }
function canReloadResources(session: LiveSession): boolean {
  return session.agentSession.isIdle && !session.agentSession.isBashRunning && !isSessionRunActive(session.agentSession)
}

export async function refreshToolSessions(): Promise<void> {
  await Promise.all([...preparing.values()].map((item) => item.promise.catch(() => undefined)))
  const sessions = [...live.values()]
  for (const session of sessions) pendingToolRefresh.add(session.sessionId)
  emitToolSettingsChanged()
  await Promise.all(sessions.map((session) => {
    const refresh = refreshLivePlugins(session, true)
    if (canReloadResources(session)) return refresh
    reportBackgroundReload(session, refresh)
    return Promise.resolve()
  }))
}

async function refreshLivePlugins(session: LiveSession, force = false): Promise<void> {
  const paths = session.pluginPaths
  if (!paths && !force) return
  if (refreshingPlugins.has(session.sessionId)) {
    queuedPluginRefresh.set(session.sessionId, force || queuedPluginRefresh.get(session.sessionId) === true)
    return
  }
  refreshingPlugins.add(session.sessionId)
  let releaseReload: (() => void) | undefined
  try {
    let delay = 300
    while (live.get(session.sessionId) === session) {
      if (!canReloadResources(session)) {
        await new Promise((resolve) => setTimeout(resolve, delay))
        delay = Math.min(delay * 2, 2000)
        continue
      }
      const next = paths ? await enabledPluginPaths() : []
      if (!force && (!paths || (paths.length === next.length && paths.every((path, i) => path === next[i])))) return
      // Filesystem awaits above may let a prompt start. Once published, the reload promise gates
      // prepareSession so a new prompt cannot enter an extension runtime being replaced.
      if (!canReloadResources(session)) continue
      resetSystemUI(session.sessionId)
      cancelExtensionUI(session.sessionId)
      const previous = [...(paths ?? [])]
      paths?.splice(0, paths.length, ...next)
      if (!resourceReloads.has(session.sessionId)) {
        resourceReloads.set(session.sessionId, new Promise<void>((resolve) => { releaseReload = resolve }))
      }
      try {
        await reloadSessionResources(session)
      } catch (error) {
        paths?.splice(0, paths.length, ...previous)
        throw error
      }
      if (session.win && !session.win.isDestroyed()) session.win.webContents.send('plugins:changed')
      return
    }
  } finally {
    refreshingPlugins.delete(session.sessionId)
    try {
      if (queuedPluginRefresh.has(session.sessionId) && live.get(session.sessionId) === session) {
        const forceNext = queuedPluginRefresh.get(session.sessionId) === true
        queuedPluginRefresh.delete(session.sessionId)
        await refreshLivePlugins(session, forceNext)
      } else {
        queuedPluginRefresh.delete(session.sessionId)
        if (!resourceFailures.has(session.sessionId)) pendingToolRefresh.delete(session.sessionId)
        emitToolSettingsChanged()
      }
    } finally {
      if (releaseReload) {
        resourceReloads.delete(session.sessionId)
        releaseReload()
      }
    }
  }
}

export async function refreshPluginSessions(force = false, cwd?: string): Promise<void> {
  const building = [...preparing.values()]
    .filter((item) => !cwd || resolve(item.cwd) === resolve(cwd))
    .map((item) => item.promise.catch(() => undefined))
  await Promise.all(building)
  await Promise.all([...live.values()].filter((session) => !cwd || resolve(session.cwd) === resolve(cwd)).map(async (session) => {
    if (session.pluginPaths && canReloadResources(session)) {
      await refreshLivePlugins(session, force)
    } else if (session.pluginPaths) {
      reportBackgroundReload(session, refreshLivePlugins(session, force))
    }
  }))
}

export function hasBusyPluginSessions(): boolean {
  return [...live.values()].some((session) => session.pluginPaths &&
    (!canReloadResources(session) || refreshingPlugins.has(session.sessionId)))
}

/** A file session's source needs its index, which is why this waits on the deferred build. */
async function sourceFor(session: SessionState): Promise<SessionSource> {
  if ('agentSession' in session) return managerSource(session.agentSession.sessionManager)
  if (session.kind === 'memory') return managerSource(session.sessionManager)
  return fileSource(await sessionIndex(session))
}

/** Read-only entries of a live or pending session; the pending phase never builds the SDK. */
export function sessionSourceFor(sessionId: string): Promise<SessionSource> {
  return sourceFor(sessionState(sessionId))
}

/** One `pig-image` entry, read through the same degradation path as every other session read. */
export function sessionEntryLookup(sessionId: string, entryId: string): Promise<SessionEntry | undefined> {
  return retryAfterIndexFallback(sessionId, async () => {
    const session = live.get(sessionId) ?? pending.get(sessionId)
    // A session that is gone is an absent image, not a failure: the renderer answers 404 either way.
    if (!session) return undefined
    if ('agentSession' in session) return session.agentSession.sessionManager.getEntry(entryId)
    if (session.kind === 'memory') return session.sessionManager.getEntry(entryId)
    // The tail is answered from memory: the images of the first painted window must not wait for the
    // index, and a 404 here would stick in the renderer's cache for an image that does exist.
    const tail = session.tailById?.get(entryId)
    if (tail) return tail
    return readEntryById(await sessionIndex(session), entryId)
  })
}

export async function viewSessionBranch(sessionId: string, tipId: string, options?: SessionBranchOptions) {
  const ls = await prepareSession(sessionId)
  return switchSessionBranch(ls.agentSession, tipId, options)
}

export async function forkSessionFromMessage(
  sessionId: string,
  userEntryId: string,
  win: BrowserWindow
): Promise<ForkedSessionRef | null> {
  const source = await prepareSession(sessionId)
  const agentSession = source.agentSession
  if (!agentSession.isIdle || agentSession.isBashRunning) throw new Error('Session is busy')
  if (agentSession.extensionRunner.hasHandlers('session_before_fork')) {
    const result = await agentSession.extensionRunner.emit({
      type: 'session_before_fork',
      entryId: userEntryId,
      position: 'before'
    })
    if (result?.cancel === true) return null
  }

  const chat = isChatCwd(source.cwd)
  const targetCwd = chat ? await createChatDir() : source.cwd
  const targetSessionDir = chat
    ? sessionDirForCwd(targetCwd)
    : agentSession.sessionManager.getSessionDir()
  const forked = forkSessionManager(
    agentSession.sessionManager,
    userEntryId,
    targetCwd,
    targetSessionDir
  )
  const held = holdPendingSession(forked.sessionManager, targetCwd, win, false)
  return {
    ...previewFor(managerSource(forked.sessionManager), targetCwd),
    sessionId: held.sessionId,
    restoredPrompt: forked.restoredPrompt
  }
}

async function disposeLiveSession(session: LiveSession): Promise<void> {
  cancelExtensionUI(session.sessionId)
  detachSystemUI(session.sessionId)
  session.unsubscribe()
  await resourceReloads.get(session.sessionId)?.catch(() => {})
  pendingToolRefresh.delete(session.sessionId)
  resourceFailures.delete(session.sessionId)
  try {
    await session.agentSession.abort()
  } catch {
  }
  try {
    await session.agentSession.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
  } catch {
  }
  session.agentSession.dispose()
}

export function closeSession(sessionId: string): Promise<void> {
  const existing = closing.get(sessionId)
  if (existing) return existing.promise
  drafts.delete(sessionId)
  const preparation = preparing.get(sessionId)
  const session = live.get(sessionId) ?? pending.get(sessionId) ?? preparation
  if (!session) return Promise.resolve()
  pending.delete(sessionId)

  // Share teardown as well as startup so directory deletion cannot overtake another close.
  const promise = (async () => {
    if (preparation) {
      try {
        await preparation.promise
      } catch {
      }
    }
    const created = live.get(sessionId)
    if (!created) return
    live.delete(sessionId)
    await disposeLiveSession(created)
  })().finally(() => closing.delete(sessionId))
  closing.set(sessionId, { cwd: session.cwd, promise })
  return promise
}

export async function closeSessionsForCwd(cwd: string): Promise<void> {
  const target = resolve(cwd)
  const sessionIds = new Set<string>()
  for (const [id, session] of [...pending, ...live, ...preparing, ...closing]) {
    if (resolve(session.cwd) === target) sessionIds.add(id)
  }
  await Promise.all([...sessionIds].map((sessionId) =>
    drafts.has(sessionId) ? discardDraftSession(sessionId) : closeSession(sessionId)
  ))
}

export async function disposeAll(): Promise<void> {
  const sessionIds = new Set([...pending.keys(), ...live.keys(), ...preparing.keys(), ...closing.keys()])
  await Promise.all([...sessionIds].map((sessionId) =>
    drafts.has(sessionId) ? discardDraftSession(sessionId) : closeSession(sessionId)
  ))
}

function sessionState(sessionId: string): SessionState {
  const session = live.get(sessionId) ?? pending.get(sessionId)
  if (!session) throw new Error(`Session not found: ${sessionId}`)
  return session
}

export function getSessionControls(sessionId: string) {
  return readControls(sessionId)
}

export function getSessionTokenStats(sessionId: string): Promise<SessionTokenStats> {
  return retryAfterIndexFallback(sessionId, () => tokenStatsFor(sessionState(sessionId)))
}

export async function setSessionModel(sessionId: string, provider: string, id: string) {
  // Once materialization starts, choices must target the session it publishes.
  const preparation = preparing.get(sessionId)
  if (preparation) await preparation.promise
  return retryAfterIndexFallback(sessionId, () => applyModel(sessionState(sessionId), provider, id))
}

export async function setSessionThinking(sessionId: string, level: ThinkingLevel) {
  const preparation = preparing.get(sessionId)
  if (preparation) await preparation.promise
  return retryAfterIndexFallback(sessionId, () => applyThinking(sessionState(sessionId), level))
}

export function refreshSessionModels(sessionId: string) {
  return retryAfterIndexFallback(sessionId, () => refreshModels(sessionState(sessionId)))
}

export async function updateFollowUpMessage(sessionId: string, index: number, action: FollowUpAction, mode?: PromptStreamingBehavior) {
  const session = await prepareSession(sessionId)
  return updateFollowUp(session.agentSession, index, action, mode)
}

export async function listSessionCommands(sessionId: string) {
  return commandsFor((await prepareSession(sessionId)).agentSession)
}

export async function exportSession(sessionId: string, outputPath: string): Promise<string> {
  return exportAgentSession((await prepareSession(sessionId)).agentSession, outputPath)
}

export async function getSessionTrees(
  sessionId: string,
  views?: SessionTreeView[]
): Promise<Partial<Record<SessionTreeView, SessionTreeRow[]>>> {
  const picked = views?.filter((view) => SESSION_TREE_VIEWS.includes(view))
  const wanted = picked?.length ? picked : [...SESSION_TREE_VIEWS]
  return retryAfterIndexFallback(sessionId, async () => {
    const session = sessionState(sessionId)
    // Reopening the dialog must not read the file again: the index is immutable while it is pending.
    if (!('agentSession' in session) && session.kind === 'file') {
      const cached = session.treeRows
      if (cached && wanted.every((view) => cached[view])) {
        return Object.fromEntries(wanted.map((view) => [view, cached[view]]))
      }
      // Concurrent callers share one build when it already covers what they ask for.
      const resident = session.treeRowsRequest
      if (resident && wanted.every((view) => resident.views.includes(view))) {
        const shared = await resident.promise
        return Object.fromEntries(wanted.map((view) => [view, shared[view]]))
      }
      // The slot holds the in-flight build so the closure below can tell it apart from a newer
      // one: naming the promise directly would read the binding while it is being assigned.
      const slot: { views: SessionTreeView[]; promise?: Promise<Partial<Record<SessionTreeView, SessionTreeRow[]>>> } = {
        views: wanted
      }
      slot.promise = (async () => {
        const built = buildSessionTreeViews(fileSource(await sessionIndex(session)), wanted)
        // A write that landed mid-build cleared the request slot: rows read before it are stale.
        if (session.treeRowsRequest === slot) session.treeRows = { ...session.treeRows, ...built }
        return built
      })()
      session.treeRowsRequest = slot as NonNullable<typeof session.treeRowsRequest>
      try {
        return await slot.promise
      } finally {
        if (session.treeRowsRequest === slot) session.treeRowsRequest = null
      }
    }
    return buildSessionTreeViews(await sourceFor(session), wanted)
  })
}
