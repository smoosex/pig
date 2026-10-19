/**
 * Translate SDK state into renderer controls and apply model choices.
 * Unbuilt sessions project their JSONL; materialization applies the stored choices before publication.
 */
import {
  buildSessionContext,
  calculateContextTokens,
  estimateTokens,
  getLatestCompactionEntry,
  sessionEntryToContextMessages,
  type AgentSession,
  type SessionContext,
  type SessionEntry
} from '@earendil-works/pi-coding-agent'
import { clampThinkingLevel } from '@earendil-works/pi-ai'
import type {
  SessionContextUsage,
  SessionControls,
  SessionTokenStats,
  ThinkingLevel as SessionThinkingLevel
} from '../../shared/api'
import type { MemorySession, PendingSession, SessionFileSession, SessionState } from './session-state'
import { readEntryById, readRows, readRowsStrict, type SessionFileEntry, type SessionFileIndex } from './session-jsonl'
import { sessionIndex } from './session-source'
import { followUpMessagesForDisplay, steeringMessagesForDisplay } from './event-bridge'
import {
  availableModels,
  clampThinking,
  defaultModelFromSettings,
  defaultThinkingFromSettings,
  modelThinkingFromSettings,
  saveModelThinkingPreference,
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
function pendingControls(session: MemorySession): SessionControls {
  const context = session.sessionManager.buildSessionContext()
  const branch = session.sessionManager.getBranch()
  const model = resolveModel(session, context.model)
  const supported = thinkingLevelsFor(model)
  const picker = pickerThinkingLevels(supported)
  const recorded = branch.some((entry) => entry.type === 'thinking_level_change')
    ? (context.thinkingLevel as SessionThinkingLevel)
    : undefined
  return {
    model,
    thinkingLevel: clampThinking(
      session.thinkingLevel ?? recorded ?? defaultThinkingFromSettings(model),
      picker.length > 0 ? picker : supported
    ),
    modelThinkingLevel: modelThinkingFromSettings(model),
    thinkingLevels: picker,
    contextUsage: persistedContextUsage(model, context.messages, branch),
    followUpMessages: [],
    steeringMessages: []
  }
}

function resolveModel(
  session: PendingSession,
  recorded: { provider: string; modelId: string } | null
): SessionControls['model'] {
  return (
    (session.modelProvider && session.modelId
      ? findModel(session.modelProvider, session.modelId)
      : null) ??
    (recorded ? findModel(recorded.provider, recorded.modelId) : null) ??
    defaultModelFromSettings() ??
    availableModels()[0] ??
    null
  )
}

/** The last row of the branch a predicate accepts, or null. */
function lastRowOf(rows: SessionFileEntry[], accept: (row: SessionFileEntry) => boolean): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!
    if (accept(row)) return i
  }
  return -1
}

const isAssistantRow = (row: SessionFileEntry) => row.type === 'message' && row.role === 'assistant'

/** A file session with its index ready: every file read goes through this. */
type IndexedFile = { path: string; index: SessionFileIndex }

/**
 * What `getSessionContextSettings` reads out of the branch, for a session with no manager: the model
 * and thinking level come from the last entry that set them, and only those lines are read.
 *
 * Exported for tests: it mirrors SDK internals and has to keep matching them.
 */
export function fileSettings(file: IndexedFile): {
  model: { provider: string; modelId: string } | null
  thinkingLevel: SessionThinkingLevel | undefined
} {
  const rows = file.index.branch
  const thinking = lastRowOf(rows, (row) => row.type === 'thinking_level_change')
  const thinkingEntry = thinking >= 0 ? readEntryById(file.index, rows[thinking]!.id) : undefined
  const modelAt = lastRowOf(rows, (row) => row.type === 'model_change')
  const modelEntry = modelAt >= 0 ? readEntryById(file.index, rows[modelAt]!.id) : undefined
  const chosen = Math.max(modelAt, lastRowOf(rows, isAssistantRow))
  const assistant = chosen >= 0 ? readEntryById(file.index, rows[chosen]!.id) : undefined
  const model =
    assistant?.type === 'message' && assistant.message.role === 'assistant'
      ? { provider: assistant.message.provider, modelId: assistant.message.model }
      : modelEntry?.type === 'model_change'
        ? { provider: modelEntry.provider, modelId: modelEntry.modelId }
        : null
  return {
    model,
    thinkingLevel:
      thinkingEntry?.type === 'thinking_level_change'
        ? (thinkingEntry.thinkingLevel as SessionThinkingLevel)
        : undefined
  }
}

/**
 * `AgentSession.getContextUsage` for a session with no manager: the last reported usage after the last
 * compaction plus the estimated messages after it, unknown when nothing usable follows a compaction.
 *
 * The backwards walk to that usage is what keeps this cheap: every other message in the branch is
 * never read, because the estimate only needs the messages behind the usage.
 */
export function fileContextUsage(
  file: IndexedFile,
  model: SessionControls['model']
): SessionContextUsage | null {
  const contextWindow = model?.contextWindow ?? 0
  if (contextWindow <= 0) return null
  const rows = file.index.branch
  const compactionAt = lastRowOf(rows, (row) => row.type === 'compaction')
  let usage: ReturnType<typeof assistantUsage> = undefined
  let usageAt = -1
  for (let i = rows.length - 1; i > compactionAt; i--) {
    if (!isAssistantRow(rows[i]!)) continue
    const entry = readEntryById(file.index, rows[i]!.id)
    const found = entry?.type === 'message' ? assistantUsage(entry.message) : undefined
    if (found) {
      usage = found
      usageAt = i
      break
    }
  }
  if (!usage) {
    if (compactionAt >= 0) return { tokens: null, contextWindow, percent: null }
    // Nothing usable to start from: the SDK estimates every message of the context instead.
    const entries = readRows(file.path, rows)
    const byId = new Map(entries.map((entry) => [entry.id, entry]))
    const messages = buildSessionContext(entries, file.index.leafId, byId).messages
    const tokens = messages.reduce((total, message) => total + estimateTokens(message), 0)
    return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 }
  }
  let tokens = calculateContextTokens(usage)
  for (const entry of readRows(file.path, rows.slice(usageAt + 1))) {
    for (const message of sessionEntryToContextMessages(entry)) tokens += estimateTokens(message)
  }
  return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 }
}

function fileControls(
  session: SessionFileSession,
  index: SessionFileIndex
): SessionControls {
  const file: IndexedFile = { path: session.path, index }
  const settings = fileSettings(file)
  const model = resolveModel(session, settings.model)
  const supported = thinkingLevelsFor(model)
  const picker = pickerThinkingLevels(supported)
  return {
    model,
    thinkingLevel: clampThinking(
      session.thinkingLevel ?? settings.thinkingLevel ?? defaultThinkingFromSettings(model),
      picker.length > 0 ? picker : supported
    ),
    modelThinkingLevel: modelThinkingFromSettings(model),
    thinkingLevels: picker,
    contextUsage: fileContextUsage(file, model),
    followUpMessages: [],
    steeringMessages: []
  }
}

/**
 * Lifetime spend of the whole session file, not of the current branch: abandoned branches and
 * entries before a compaction are counted too, which is what the usage popover reports.
 */
function tokenStatsFromEntries(entries: SessionEntry[]): SessionTokenStats {
  const tokens = { ...emptyTokens }
  for (const entry of entries) {
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

/**
 * Whole-file lifetime spend, only on request: reading every assistant line costs about 250ms on
 * the largest session, and the popover that shows it is opened rarely. A pending file pays it once.
 */
export async function tokenStatsFor(session: SessionState): Promise<SessionTokenStats> {
  if ('agentSession' in session) {
    return tokenStatsFromEntries(session.agentSession.sessionManager.getEntries())
  }
  if (session.kind !== 'file') {
    return tokenStatsFromEntries(session.sessionManager.getEntries())
  }
  return fileTokenStats({ path: session.path, index: await sessionIndex(session) }, session)
}

function fileTokenStats(file: IndexedFile, session: SessionFileSession): SessionTokenStats {
  if (!session.tokens) {
    const rows = file.index.entries.filter(isAssistantRow)
    session.tokens = tokenStatsFromEntries(readRowsStrict(file.path, rows))
  }
  return session.tokens
}

export async function controlsFor(session: SessionState): Promise<SessionControls> {
  await startModelRuntime()
  if ('agentSession' in session) {
    const model = session.agentSession.model
      ? toModelInfo(session.agentSession.model)
      : null
    const usage = session.agentSession.getContextUsage()
    return {
      model,
      thinkingLevel: session.agentSession.thinkingLevel,
      modelThinkingLevel: modelThinkingFromSettings(model),
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
      followUpMessages: followUpMessagesForDisplay(session.agentSession),
      steeringMessages: steeringMessagesForDisplay(session.agentSession)
    }
  }

  if (session.kind !== 'file') return pendingControls(session)
  // Waiting here is the point of the split: the picker and the ring appear when the index exists.
  return fileControls(session, await sessionIndex(session))
}

export async function setSessionModel(
  session: SessionState,
  provider: string,
  id: string
): Promise<SessionControls> {
  const model = (await startModelRuntime()).getModel(provider, id)
  if (!model) throw new Error(`Model not found: ${provider}/${id}`)

  const current = await controlsFor(session)
  const supported = thinkingLevelsFor(model)
  const picker = pickerThinkingLevels(supported)
  // SDK sessions have their own settings snapshots. Resolve from shared preferences for both
  // live and unbuilt sessions, so another tab's explicit save is visible without recreating a session.
  const level = clampThinking(
    clampThinkingLevel(model, defaultThinkingFromSettings(model) ?? current.thinkingLevel ?? 'medium'),
    picker.length > 0 ? picker : supported
  )
  if ('agentSession' in session) {
    await session.agentSession.setModel(model)
    session.agentSession.setThinkingLevel(level)
    return controlsFor(session)
  }

  session.modelProvider = provider
  session.modelId = id
  session.thinkingLevel = level
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

  if ('agentSession' in session && !session.agentSession.getAvailableThinkingLevels().includes(level)) {
    throw new Error(`Thinking level not supported: ${level}`)
  }
  // This entry point is UI-only: extensions/review call the SDK directly and must not persist
  // temporary choices. A remembered model follows subsequent explicit user selections.
  const current = await controlsFor(session)
  if (!current.thinkingLevels.includes(level)) throw new Error(`Thinking level not supported: ${level}`)
  if (current.model && current.modelThinkingLevel != null) {
    await saveModelThinkingPreference(current.model, level)
  }
  if ('agentSession' in session) session.agentSession.setThinkingLevel(level)
  else session.thinkingLevel = level
  return controlsFor(session)
}

export async function setSessionModelThinkingPreference(
  session: SessionState,
  remember: boolean
): Promise<SessionControls> {
  if (typeof remember !== 'boolean') throw new Error('Remember thinking preference must be a boolean')
  const current = await controlsFor(session)
  if (!current.model) throw new Error('No model selected')
  if (remember && !current.thinkingLevels.includes(current.thinkingLevel)) {
    throw new Error(`Thinking level not supported: ${current.thinkingLevel}`)
  }
  await saveModelThinkingPreference(current.model, remember ? current.thinkingLevel : null)
  // Removing the preference changes only future model switches, not this session's current level.
  return controlsFor(session)
}
