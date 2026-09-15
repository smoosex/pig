/**
 * Translate SDK state into renderer controls and apply model choices.
 * Unbuilt sessions project their JSONL; materialization applies the stored choices before publication.
 */
import {
  calculateContextTokens,
  estimateTokens,
  getLatestCompactionEntry,
  type AgentSession,
  type SessionContext,
  type SessionEntry,
  type SessionManager
} from '@earendil-works/pi-coding-agent'
import type {
  SessionContextUsage,
  SessionControls,
  SessionTokenStats,
  ThinkingLevel as SessionThinkingLevel
} from '../../shared/api'
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

type ContextMessage = SessionContext['messages'][number]

// Aborted, failed, and all-zero usages carry no context size; mirrors the SDK's own filter.
function assistantUsage(message: ContextMessage) {
  if (message.role !== 'assistant') return undefined
  if (message.stopReason === 'aborted' || message.stopReason === 'error') return undefined
  if (!message.usage || calculateContextTokens(message.usage) <= 0) return undefined
  return message.usage
}

function estimateContextTokens(messages: SessionContext['messages']): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = assistantUsage(messages[i])
    if (!usage) continue
    let trailing = 0
    for (let j = i + 1; j < messages.length; j++) trailing += estimateTokens(messages[j])
    return calculateContextTokens(usage) + trailing
  }
  return messages.reduce((total, message) => total + estimateTokens(message), 0)
}

/**
 * What AgentSession.getContextUsage reports, for a session that is not built yet: the last reported
 * usage plus the estimated messages after it, and unknown until an assistant replies past the last
 * compaction.
 */
function persistedContextUsage(
  model: SessionControls['model'],
  messages: SessionContext['messages'],
  branch: SessionEntry[]
): SessionContextUsage | null {
  const contextWindow = model?.contextWindow ?? 0
  if (contextWindow <= 0) return null
  const compaction = getLatestCompactionEntry(branch)
  if (compaction) {
    const after = branch.slice(branch.lastIndexOf(compaction) + 1)
    if (!after.some((entry) => entry.type === 'message' && assistantUsage(entry.message))) {
      return { tokens: null, contextWindow, percent: null }
    }
  }
  const tokens = estimateContextTokens(messages)
  return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 }
}

/**
 * Every control an unbuilt session can already report from its JSONL: explicit choices win, otherwise
 * an opened session reports the model, thinking level, and context usage its branch recorded, never
 * the global defaults.
 */
function pendingControls(
  session: PendingSession,
  models: SessionControls['models']
): SessionControls {
  const context = session.sessionManager.buildSessionContext()
  const branch = session.sessionManager.getBranch()
  const model =
    (session.modelProvider && session.modelId
      ? findModel(session.modelProvider, session.modelId)
      : null) ??
    (context.model ? findModel(context.model.provider, context.model.modelId) : null) ??
    defaultModelFromSettings() ??
    models[0] ??
    null
  const supported = thinkingLevelsFor(model)
  const picker = pickerThinkingLevels(supported)
  const recorded = branch.some((entry) => entry.type === 'thinking_level_change')
    ? (context.thinkingLevel as SessionThinkingLevel)
    : undefined
  return {
    model,
    models,
    thinkingLevel: clampThinking(
      session.thinkingLevel ?? recorded ?? defaultThinkingFromSettings(model),
      picker.length > 0 ? picker : supported
    ),
    thinkingLevels: picker,
    contextUsage: persistedContextUsage(model, context.messages, branch),
    tokens: tokenStatsFromEntries(session.sessionManager),
    followUpMessages: []
  }
}

/**
 * Lifetime spend of the whole session file, not of the current branch: abandoned branches and
 * entries before a compaction are counted too, which is what the usage popover reports.
 */
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

  return pendingControls(session, models)
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
