/**
 * Translate SDK state into renderer controls and apply model choices.
 * Pending sessions store choices only; materialization applies them before publication.
 */
import type { AgentSession, SessionManager } from '@earendil-works/pi-coding-agent'
import type { SessionControls, SessionTokenStats, ThinkingLevel as SessionThinkingLevel } from '../../shared/api'
import type { PendingSession, SessionState } from './session-state'
import { followUpMessagesForDisplay } from './event-bridge'
import {
  availableModels,
  clampThinking,
  defaultModelFromSettings,
  defaultThinkingFromSettings,
  findModel,
  HIDDEN_THINKING_LEVELS,
  pickerThinkingLevels,
  startModelRuntime,
  THINKING_LEVELS,
  thinkingLevelsFor,
  toModelInfo
} from './model-settings'

const emptyTokens: SessionTokenStats = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0
}

export async function applyPendingControls(
  session: PendingSession,
  agentSession: AgentSession
): Promise<void> {
  if (session.modelProvider && session.modelId) {
    const model = (await startModelRuntime()).getModel(session.modelProvider, session.modelId)
    if (!model) throw new Error(`Model not found: ${session.modelProvider}/${session.modelId}`)
    await agentSession.setModel(model)
  }
  if (session.thinkingLevel) {
    agentSession.setThinkingLevel(session.thinkingLevel)
  }
}

/**
 * Controls a pending session can already report: explicit choices win, otherwise an opened session
 * falls back to the model and thinking level its JSONL recorded, never to the global default.
 */
function persistedControls(session: PendingSession): {
  model: SessionControls['model']
  thinkingLevel?: SessionThinkingLevel
} {
  // Until the build restores the real session, an opened session reports what its JSONL recorded.
  const context = session.sessionManager.buildSessionContext()
  const choseThinking = session.sessionManager
    .getBranch()
    .some((entry) => entry.type === 'thinking_level_change')
  return {
    model: context.model ? findModel(context.model.provider, context.model.modelId) : null,
    thinkingLevel: choseThinking ? (context.thinkingLevel as SessionThinkingLevel) : undefined
  }
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

export async function controlsFor(session: SessionState): Promise<SessionControls> {
  await startModelRuntime()
  const models = availableModels()
  if ('agentSession' in session) {
    const model = session.agentSession.model
      ? toModelInfo(session.agentSession.model)
      : null
    const usage = session.agentSession.getContextUsage()
    return {
      model,
      models,
      thinkingLevel: session.agentSession.thinkingLevel,
      thinkingLevels: pickerThinkingLevels(
        session.agentSession.getAvailableThinkingLevels() as SessionThinkingLevel[]
      ),
      contextUsage: usage
        ? {
            tokens: usage.tokens,
            contextWindow: usage.contextWindow,
            percent: usage.percent
          }
        : null,
      tokens: tokenStatsFromEntries(session.agentSession.sessionManager),
      followUpMessages: followUpMessagesForDisplay(session.agentSession)
    }
  }

  const persisted = persistedControls(session)
  const model =
    (session.modelProvider && session.modelId
      ? findModel(session.modelProvider, session.modelId)
      : null) ??
    persisted.model ??
    defaultModelFromSettings() ??
    models[0] ??
    null
  const supported = thinkingLevelsFor(model)
  const picker = pickerThinkingLevels(supported)
  return {
    model,
    models,
    thinkingLevel: clampThinking(
      session.thinkingLevel ?? persisted.thinkingLevel ?? defaultThinkingFromSettings(model),
      picker.length > 0 ? picker : supported
    ),
    thinkingLevels: picker,
    contextUsage: null,
    tokens: tokenStatsFromEntries(session.sessionManager),
    followUpMessages: []
  }
}

export async function setSessionModel(
  session: SessionState,
  provider: string,
  id: string
): Promise<SessionControls> {
  const model = (await startModelRuntime()).getModel(provider, id)
  if (!model) throw new Error(`Model not found: ${provider}/${id}`)

  if ('agentSession' in session) {
    await session.agentSession.setModel(model)
    return controlsFor(session)
  }

  session.modelProvider = provider
  session.modelId = id
  const supported = thinkingLevelsFor(model)
  const picker = pickerThinkingLevels(supported)
  session.thinkingLevel = clampThinking(
    session.thinkingLevel ?? defaultThinkingFromSettings(model),
    picker.length > 0 ? picker : supported
  )
  return controlsFor(session)
}

export async function setSessionThinking(
  session: SessionState,
  level: SessionThinkingLevel
): Promise<SessionControls> {
  await startModelRuntime()
  if (!THINKING_LEVELS.includes(level) || HIDDEN_THINKING_LEVELS.has(level)) {
    throw new Error(`Invalid thinking level: ${level}`)
  }

  if ('agentSession' in session) {
    if (!session.agentSession.getAvailableThinkingLevels().includes(level)) {
      throw new Error(`Thinking level not supported: ${level}`)
    }
    session.agentSession.setThinkingLevel(level)
    return controlsFor(session)
  }

  const model =
    session.modelProvider && session.modelId
      ? { provider: session.modelProvider, id: session.modelId }
      : (defaultModelFromSettings() ?? availableModels()[0] ?? null)
  const levels = pickerThinkingLevels(thinkingLevelsFor(model))
  if (!levels.includes(level)) throw new Error(`Thinking level not supported: ${level}`)
  session.thinkingLevel = level
  return controlsFor(session)
}

export async function refreshSessionModels(session: SessionState): Promise<SessionControls> {
  await (await startModelRuntime()).refresh()
  return controlsFor(session)
}
