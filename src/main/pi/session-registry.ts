import { writeFile, rm } from 'node:fs/promises'
import type { BrowserWindow } from 'electron'
import { resolve } from 'node:path'
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  type AgentSession
} from '@earendil-works/pi-coding-agent'
import { bridgeEvents } from './event-bridge'

export interface LiveSession {
  sessionId: string
  cwd: string
  agentSession: AgentSession
  unsubscribe: () => void
}

export interface PendingSession {
  sessionId: string
  cwd: string
  sessionManager: SessionManager
  win: BrowserWindow
}

const live = new Map<string, LiveSession>()
const pending = new Map<string, PendingSession>()
const preparing = new Map<string, Promise<LiveSession>>()

const authStorage = AuthStorage.create()
const modelRegistry = ModelRegistry.create(authStorage)

async function build(
  sessionManager: SessionManager,
  cwd: string,
  win: BrowserWindow
): Promise<LiveSession> {
  const result = await createAgentSession({
    cwd,
    sessionManager,
    authStorage,
    modelRegistry
  })
  const session = result.session
  const unsubscribe = bridgeEvents(session, session.sessionId, win)
  const ls: LiveSession = { sessionId: session.sessionId, cwd, agentSession: session, unsubscribe }
  live.set(session.sessionId, ls)
  return ls
}

export function createPendingSession(cwd: string, win: BrowserWindow): PendingSession {
  const sessionManager = SessionManager.create(cwd)
  const sessionId = sessionManager.getSessionId()
  const session = { sessionId, cwd, sessionManager, win }
  pending.set(sessionId, session)
  return session
}

async function materialize(session: PendingSession): Promise<LiveSession> {
  const sessionFile = session.sessionManager.getSessionFile()
  const header = session.sessionManager.getHeader()
  if (!sessionFile || !header) throw new Error('Pending session has no session file or header')

  await writeFile(sessionFile, `${JSON.stringify(header)}\n`, { flag: 'wx' })
  const persistedManager = SessionManager.open(sessionFile)

  try {
    const liveSession = await build(persistedManager, session.cwd, session.win)
    pending.delete(session.sessionId)
    return liveSession
  } catch (error) {
    await rm(sessionFile, { force: true })
    throw error
  }
}

export function prepareSession(sessionId: string): Promise<LiveSession> {
  const existing = live.get(sessionId)
  if (existing) return Promise.resolve(existing)

  const running = preparing.get(sessionId)
  if (running) return running

  const session = pending.get(sessionId)
  if (!session) throw new Error(`Session not found: ${sessionId}`)

  const promise = materialize(session).finally(() => {
    preparing.delete(sessionId)
  })
  preparing.set(sessionId, promise)
  return promise
}

export async function openSession(path: string, win: BrowserWindow): Promise<LiveSession> {
  for (const ls of live.values()) {
    if (ls.agentSession.sessionFile === path) return ls
  }
  const sm = SessionManager.open(path)
  const cwd = sm.getCwd() || process.cwd()
  return build(sm, cwd, win)
}

export function getLive(sessionId: string): LiveSession | undefined {
  return live.get(sessionId)
}

export function closeSession(sessionId: string): void {
  if (pending.delete(sessionId)) return
  const ls = live.get(sessionId)
  if (!ls) return
  ls.unsubscribe()
  ls.agentSession.dispose()
  live.delete(sessionId)
}

export function closeSessionsForCwd(cwd: string): void {
  const target = resolve(cwd)
  for (const session of [...pending.values()]) {
    if (resolve(session.cwd) === target) closeSession(session.sessionId)
  }
  for (const ls of [...live.values()]) {
    if (resolve(ls.cwd) === target) closeSession(ls.sessionId)
  }
}

export function disposeAll(): void {
  pending.clear()
  preparing.clear()
  for (const ls of live.values()) {
    ls.unsubscribe()
    ls.agentSession.dispose()
  }
  live.clear()
}
