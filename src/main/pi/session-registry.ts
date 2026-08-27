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

export type SessionThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export interface SessionModelInfo {
  id: string
  name: string
  provider: string
  contextWindow: number
  reasoning: boolean
}

export interface SessionContextUsage {
  tokens: number | null
  contextWindow: number
  percent: number | null
}

export interface SessionTokenStats {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export interface SessionControls {
  model: SessionModelInfo | null
  models: SessionModelInfo[]
  thinkingLevel: SessionThinkingLevel
  thinkingLevels: SessionThinkingLevel[]
  contextUsage: SessionContextUsage | null
  tokens: SessionTokenStats
}

const emptyTokens: SessionTokenStats = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0
}

const THINKING_LEVELS: SessionThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']

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
  modelProvider?: string
  modelId?: string
  thinkingLevel?: SessionThinkingLevel
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
    await applyPendingControls(session, liveSession)
    pending.delete(session.sessionId)
    return liveSession
  } catch (error) {
    await rm(sessionFile, { force: true })
    throw error
  }
}

async function applyPendingControls(
  session: PendingSession,
  liveSession: LiveSession
): Promise<void> {
  if (session.modelProvider && session.modelId) {
    const model = modelRegistry.find(session.modelProvider, session.modelId)
    if (model) await liveSession.agentSession.setModel(model)
  }
  if (session.thinkingLevel) {
    liveSession.agentSession.setThinkingLevel(session.thinkingLevel)
  }
}

function toModelInfo(model: {
  id: string
  name: string
  provider: string
  contextWindow: number
  reasoning: boolean
}): SessionModelInfo {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    contextWindow: model.contextWindow,
    reasoning: model.reasoning
  }
}

function availableModels(): SessionModelInfo[] {
  return modelRegistry.getAvailable().map(toModelInfo)
}

function thinkingLevelsFor(model: SessionModelInfo | null): SessionThinkingLevel[] {
  if (!model?.reasoning) return ['off']
  return THINKING_LEVELS
}

function findModel(provider: string, id: string): SessionModelInfo | null {
  const model = modelRegistry.find(provider, id)
  return model ? toModelInfo(model) : null
}

function tokenStatsFromEntries(sessionManager: SessionManager): SessionTokenStats {
  const tokens = { ...emptyTokens }
  for (const entry of sessionManager.getEntries()) {
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue
    const usage = entry.message.usage
    tokens.input += usage.input
    tokens.output += usage.output
    tokens.cacheRead += usage.cacheRead
    tokens.cacheWrite += usage.cacheWrite
  }
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
  return tokens
}

export function getSessionControls(sessionId: string): SessionControls {
  const models = availableModels()
  const liveSession = live.get(sessionId)
  if (liveSession) {
    const model = liveSession.agentSession.model
      ? toModelInfo(liveSession.agentSession.model)
      : null
    const usage = liveSession.agentSession.getContextUsage()
    return {
      model,
      models,
      thinkingLevel: liveSession.agentSession.thinkingLevel,
      thinkingLevels: liveSession.agentSession.getAvailableThinkingLevels(),
      contextUsage: usage
        ? {
            tokens: usage.tokens,
            contextWindow: usage.contextWindow,
            percent: usage.percent
          }
        : null,
      tokens: tokenStatsFromEntries(liveSession.agentSession.sessionManager)
    }
  }

  const session = pending.get(sessionId)
  if (!session) throw new Error(`Session not found: ${sessionId}`)
  const model =
    session.modelProvider && session.modelId
      ? findModel(session.modelProvider, session.modelId)
      : (models[0] ?? null)
  return {
    model,
    models,
    thinkingLevel: session.thinkingLevel ?? 'off',
    thinkingLevels: thinkingLevelsFor(model),
    contextUsage: null,
    tokens: tokenStatsFromEntries(session.sessionManager)
  }
}

export async function setSessionModel(
  sessionId: string,
  provider: string,
  id: string
): Promise<SessionControls> {
  const model = modelRegistry.find(provider, id)
  if (!model) throw new Error(`Model not found: ${provider}/${id}`)

  const liveSession = live.get(sessionId)
  if (liveSession) {
    await liveSession.agentSession.setModel(model)
    return getSessionControls(sessionId)
  }

  const session = pending.get(sessionId)
  if (!session) throw new Error(`Session not found: ${sessionId}`)
  session.modelProvider = provider
  session.modelId = id
  return getSessionControls(sessionId)
}

export function setSessionThinking(
  sessionId: string,
  level: SessionThinkingLevel
): SessionControls {
  if (!THINKING_LEVELS.includes(level)) throw new Error(`Invalid thinking level: ${level}`)

  const liveSession = live.get(sessionId)
  if (liveSession) {
    liveSession.agentSession.setThinkingLevel(level)
    return getSessionControls(sessionId)
  }

  const session = pending.get(sessionId)
  if (!session) throw new Error(`Session not found: ${sessionId}`)
  session.thinkingLevel = level
  return getSessionControls(sessionId)
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
