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

const live = new Map<string, LiveSession>()

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

export async function createSession(cwd: string, win: BrowserWindow): Promise<LiveSession> {
  return build(SessionManager.create(cwd), cwd, win)
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
  const ls = live.get(sessionId)
  if (!ls) return
  ls.unsubscribe()
  ls.agentSession.dispose()
  live.delete(sessionId)
}

export function closeSessionsForCwd(cwd: string): void {
  const target = resolve(cwd)
  for (const ls of [...live.values()]) {
    if (resolve(ls.cwd) === target) closeSession(ls.sessionId)
  }
}

export function disposeAll(): void {
  for (const ls of live.values()) {
    ls.unsubscribe()
    ls.agentSession.dispose()
  }
  live.clear()
}