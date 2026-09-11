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
import type { FollowUpAction, ThinkingLevel } from '../../shared/api'
import { normalizeWorktreePath as resolve } from '../worktrees'
import { isChatCwd } from '../chats'
import { worktrees } from '../project-worktrees'
import { createChatResourceLoader, createNoExtensionsResourceLoader } from './chat-resources'
import { bridgeEvents } from './event-bridge'
import { startModelRuntime } from './model-settings'
import {
  applyPendingControls,
  controlsFor,
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
import type { LiveSession, PendingSession, SessionState } from './session-state'

export type { LiveSession, PendingSession } from './session-state'
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

const live = new Map<string, LiveSession>()
const pending = new Map<string, PendingSession>()
const preparing = new Map<string, Preparation>()
const closing = new Map<string, { cwd: string; promise: Promise<void> }>()
const openingPaths = new Map<string, Promise<LiveSession>>()

function trackPreparation(
  sessionId: string,
  cwd: string,
  building: Promise<LiveSession>,
  path?: string
): Promise<LiveSession> {
  const promise = building.then((session) => {
    live.set(sessionId, session)
    pending.delete(sessionId)
    return session
  }).finally(() => {
    preparing.delete(sessionId)
    if (path) openingPaths.delete(path)
  })
  preparing.set(sessionId, { cwd, promise })
  if (path) openingPaths.set(path, promise)
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
  const session = { sessionId, cwd, sessionManager, win }
  pending.set(sessionId, session)
  return session
}

async function materialize(session: PendingSession): Promise<LiveSession> {
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

  return trackPreparation(sessionId, session.cwd, materialize(session))
}

export async function openSession(path: string, win: BrowserWindow): Promise<LiveSession> {
  const target = resolve(path)
  for (const ls of live.values()) {
    if (ls.agentSession.sessionFile && resolve(ls.agentSession.sessionFile) === target) {
      if (closing.has(ls.sessionId)) throw new Error(`Session is closing: ${ls.sessionId}`)
      worktrees.assertAvailable(ls.cwd)
      return ls
    }
  }
  const opening = openingPaths.get(target)
  if (opening) return opening
  const sm = SessionManager.open(target)
  const cwd = sm.getCwd() || process.cwd()
  worktrees.assertAvailable(cwd)
  const sessionId = sm.getSessionId()
  if (closing.has(sessionId)) throw new Error(`Session is closing: ${sessionId}`)
  const existing = preparing.get(sessionId)
  if (existing) return existing.promise
  return trackPreparation(sessionId, cwd, build(sm, cwd, win), target)
}

export function getLive(sessionId: string): LiveSession | undefined {
  return live.get(sessionId)
}

export function sessionManagerFor(sessionId: string): SessionManager {
  const session = sessionState(sessionId)
  return 'agentSession' in session ? session.agentSession.sessionManager : session.sessionManager
}

export function viewSessionBranch(sessionId: string, tipId: string): string | null {
  const ls = requireLive(sessionId)
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

export function requireLive(sessionId: string): LiveSession {
  const session = getLive(sessionId)
  if (!session) throw new Error(`Session not found: ${sessionId}`)
  return session
}

function sessionState(sessionId: string): SessionState {
  const session = live.get(sessionId) ?? pending.get(sessionId)
  if (!session) throw new Error(`Session not found: ${sessionId}`)
  return session
}

export function getSessionControls(sessionId: string) {
  return controlsFor(sessionState(sessionId))
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

export function updateFollowUpMessage(sessionId: string, index: number, action: FollowUpAction) {
  return updateFollowUp(requireLive(sessionId).agentSession, index, action)
}

export async function listSessionCommands(sessionId: string) {
  return commandsFor((await prepareSession(sessionId)).agentSession)
}

export async function exportSession(sessionId: string, outputPath?: string): Promise<string> {
  return exportAgentSession((await prepareSession(sessionId)).agentSession, outputPath)
}

export function getSessionTree(sessionId: string) {
  return sessionTreeRows(sessionManagerFor(sessionId))
}
