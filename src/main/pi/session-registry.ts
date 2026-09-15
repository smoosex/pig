/**
 * Own pending sessions, live SDK sessions, and in-flight initialization.
 *
 * Publish sessions only after extensions and pending controls are ready.
 * Closing a directory waits for its builds before the caller removes it.
 */
import { statSync } from 'node:fs'
import { writeFile, rm } from 'node:fs/promises'
import type { BrowserWindow } from 'electron'
import { createAgentSession, SessionManager, type AgentSession } from '@earendil-works/pi-coding-agent'
import type {
  DisplayTurnsResult,
  FollowUpAction,
  SessionTokenStats,
  SessionWindowMessage,
  ThinkingLevel
} from '../../shared/api'
import { normalizeWorktreePath as resolve } from '../worktrees'
import { isChatCwd } from '../chats'
import { worktrees } from '../project-worktrees'
import { createChatResourceLoader, createNoExtensionsResourceLoader } from './chat-resources'
import { bridgeEvents } from './event-bridge'
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
import { sessionTreeRows } from './session-tree'
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
  readEntryById,
  readSessionHeader,
  UnsupportedSessionFile,
  type SessionHeader
} from './session-jsonl'
import { CURRENT_SESSION_VERSION } from '@earendil-works/pi-coding-agent'
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
const preparing = new Map<string, Preparation>()
const closing = new Map<string, { cwd: string; promise: Promise<void> }>()

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
  const resourceLoader = isChatCwd(cwd)
    ? await createChatResourceLoader(cwd)
    : await createNoExtensionsResourceLoader(cwd)
  const result = await createAgentSession({
    cwd,
    sessionManager,
    modelRuntime: await startModelRuntime(),
    ...(resourceLoader ? { resourceLoader } : {})
  })
  const session = result.session
  const created: LiveSession = {
    sessionId: session.sessionId,
    cwd,
    agentSession: session,
    unsubscribe: () => {}
  }
  try {
    worktrees.assertAvailable(cwd)
    await session.bindExtensions({ mode: 'rpc' })
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

export function createPendingSession(cwd: string, win: BrowserWindow): PendingSession {
  worktrees.assertAvailable(cwd)
  if (!statSync(cwd).isDirectory()) throw new Error('会话工作目录不存在')
  const sessionManager = SessionManager.create(cwd)
  const sessionId = sessionManager.getSessionId()
  const session: MemorySession = {
    kind: 'memory',
    sessionId,
    cwd,
    sessionManager,
    win,
    needsMaterialize: true
  }
  pending.set(sessionId, session)
  return session
}

async function materialize(session: MemorySession): Promise<LiveSession> {
  worktrees.assertAvailable(session.cwd)
  const sessionFile = session.sessionManager.getSessionFile()
  const header = session.sessionManager.getHeader()
  if (!sessionFile || !header) throw new Error('Pending session has no session file or header')

  // Drafts acquire a JSONL file only on first use; rollback must never remove an existing file.
  await writeFile(sessionFile, `${JSON.stringify(header)}\n`, { flag: 'wx' })
  try {
    session.sessionManager.setSessionFile(sessionFile)
    return await build(session.sessionManager, session.cwd, session.win, (created) =>
      applyPendingControls(session, created)
    )
  } catch (error) {
    await rm(sessionFile, { force: true })
    throw error
  }
}

export function prepareSession(sessionId: string): Promise<LiveSession> {
  if (closing.has(sessionId)) throw new Error(`Session is closing: ${sessionId}`)
  const existing = live.get(sessionId)
  if (existing) {
    worktrees.assertAvailable(existing.cwd)
    return Promise.resolve(existing)
  }

  const running = preparing.get(sessionId)
  if (running) return running.promise

  const session = pending.get(sessionId)
  if (!session) throw new Error(`Session not found: ${sessionId}`)

  const building =
    session.kind === 'file'
      ? build(SessionManager.open(session.path), session.cwd, session.win)
      : session.needsMaterialize
        ? materialize(session)
        : build(session.sessionManager, session.cwd, session.win)
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
      sessionManager: manager,
      needsMaterialize: false
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
  setImmediate(() => {
    void warmIndex(session).catch((error: unknown) => {
      console.error('Failed to index session:', error)
      // The renderer is waiting on this index: without an answer it keeps promising older turns.
      sendWindow(session, { error: errorMessage(error) })
    })
  })
  return { sessionId, cwd, display: tail.display }
}

/**
 * Builds the branch index after the first paint and tells the renderer what the provisional window
 * could not know: where the tail sits in the branch and how heavy the turns above it are. A file the
 * reader refuses falls back to the SDK manager, which is what a session without an index needs.
 */
async function warmIndex(session: SessionFileSession): Promise<void> {
  let index
  try {
    index = await sessionIndex(session)
  } catch (error) {
    if (!(error instanceof UnsupportedSessionFile)) throw error
    downgradeFileSession(session)
    return
  }
  if (pending.get(session.sessionId) !== session) return
  session.tailById = null
  sendWindow(session, windowUpdate(fileSource(index), session.tailTurns))
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
    needsMaterialize: false
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

export function isPendingDraft(sessionId: string): boolean {
  const session = pending.get(sessionId)
  return session?.kind === 'memory' && session.needsMaterialize
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

/** Enough of a session to answer one `pig-image` request, or undefined when it is not registered. */
export function sessionEntryLookup(
  sessionId: string
): { getEntry(entryId: string): ReturnType<SessionSource['entryById']> } | undefined {
  const session = live.get(sessionId) ?? pending.get(sessionId)
  if (!session) return undefined
  if ('agentSession' in session) {
    return { getEntry: (entryId) => session.agentSession.sessionManager.getEntry(entryId) }
  }
  if (session.kind === 'memory') {
    return { getEntry: (entryId) => session.sessionManager.getEntry(entryId) }
  }
  // The tail is answered from memory: the images of the first painted window must not wait for the
  // index, and a 404 here would stick in the renderer's cache for an image that does exist.
  return {
    getEntry: (entryId) =>
      session.tailById?.get(entryId) ??
      (session.index ? readEntryById(session.index, entryId) : undefined)
  }
}

export async function viewSessionBranch(sessionId: string, tipId: string): Promise<string | null> {
  const ls = await prepareSession(sessionId)
  if (ls.agentSession.isStreaming) throw new Error('Session is streaming')
  const sm = ls.agentSession.sessionManager
  if (!sm.getEntry(tipId)) throw new Error(`Entry not found: ${tipId}`)
  if (sm.getLeafId() !== tipId) {
    sm.branch(tipId)
    ls.agentSession.agent.state.messages = sm.buildSessionContext().messages
  }
  return sm.getLeafId()
}

async function disposeLiveSession(session: LiveSession): Promise<void> {
  session.unsubscribe()
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
  await Promise.all([...sessionIds].map(closeSession))
}

export async function disposeAll(): Promise<void> {
  const sessionIds = new Set([...pending.keys(), ...live.keys(), ...preparing.keys(), ...closing.keys()])
  await Promise.all([...sessionIds].map(closeSession))
}

function sessionState(sessionId: string): SessionState {
  const session = live.get(sessionId) ?? pending.get(sessionId)
  if (!session) throw new Error(`Session not found: ${sessionId}`)
  return session
}

export function getSessionControls(sessionId: string) {
  return controlsFor(sessionState(sessionId))
}

export function getSessionTokenStats(sessionId: string): Promise<SessionTokenStats> {
  return retryAfterIndexFallback(sessionId, () => tokenStatsFor(sessionState(sessionId)))
}

export async function setSessionModel(sessionId: string, provider: string, id: string) {
  // Once materialization starts, choices must target the session it publishes.
  const preparation = preparing.get(sessionId)
  if (preparation) await preparation.promise
  return applyModel(sessionState(sessionId), provider, id)
}

export async function setSessionThinking(sessionId: string, level: ThinkingLevel) {
  const preparation = preparing.get(sessionId)
  if (preparation) await preparation.promise
  return applyThinking(sessionState(sessionId), level)
}

export function refreshSessionModels(sessionId: string) {
  return refreshModels(sessionState(sessionId))
}

export async function updateFollowUpMessage(sessionId: string, index: number, action: FollowUpAction) {
  const session = await prepareSession(sessionId)
  return updateFollowUp(session.agentSession, index, action)
}

export async function listSessionCommands(sessionId: string) {
  return commandsFor((await prepareSession(sessionId)).agentSession)
}

export async function exportSession(sessionId: string, outputPath?: string): Promise<string> {
  return exportAgentSession((await prepareSession(sessionId)).agentSession, outputPath)
}

export async function getSessionTree(sessionId: string) {
  return retryAfterIndexFallback(sessionId, async () => {
    const session = sessionState(sessionId)
    // Reopening the dialog must not read the file again: the index is immutable while it is pending.
    if (!('agentSession' in session) && session.kind === 'file') {
      session.treeRows ??= sessionTreeRows(fileSource(await sessionIndex(session)))
      return session.treeRows
    }
    return sessionTreeRows(await sourceFor(session))
  })
}
