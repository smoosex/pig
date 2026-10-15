import type { DisplayCompaction, DisplayTurn, GenerationStats } from '../../../shared/api'
import type { Translate } from '../../../shared/i18n'
import type {
  AssistantMessage,
  BashExecutionMessage,
  CustomMessage,
  PiMessage,
  PigImageContent,
  PigUserMessage,
  TextContent,
  ToolCall,
  ToolPartialResult,
  ToolResultMessage
} from '../pi/types'
import type { LiveCompaction } from './compactions'

export interface ToolStep {
  id: string
  name: string
  args: Record<string, unknown>
  partialResult?: ToolPartialResult
  result?: ToolResultMessage
}

export type ToolUpdates = Record<string, ToolPartialResult>

export type ThinkingDurations = Record<string, number>

export function thinkingTimingKey(messageTimestamp: number, contentIndex: number): string {
  return `${messageTimestamp}:${contentIndex}`
}

export type ProcessItem =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string; durationMs: number; live: boolean }
  | { kind: 'tools'; tools: ToolStep[] }
  | { kind: 'bash'; message: BashExecutionMessage }
  | { kind: 'custom'; message: CustomMessage }
  | CompactionItem

/**
 * A compaction is a session landmark, not work: it resets what the model can still see, so it is
 * projected apart from the process items and rendered outside the collapsed work block.
 * `afterAnswer` is set when the summary sits behind the chunk's last assistant message, which puts
 * it below the answer instead of inside the work that preceded it. It is decided by position, not
 * by the turn's state: an overflow that was compacted and retried leaves an earlier error behind.
 */
export type CompactionItem = DisplayCompaction & {
  kind: 'compaction'
  /**
   * Set while the renderer has Pi's own compaction in hand rather than a written summary: a summary
   * in progress has no entry yet, and a finished one is only replaced by history at settlement.
   */
  live?: LiveCompaction
}

export type AnswerBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; image: PigImageContent }

/** Persisted images resolve through the pig-image scheme; unsaved ones still carry bytes inline. */
export function turnImageSrc(image: PigImageContent): string | undefined {
  if (image.url) return image.url
  return image.data ? `data:${image.mimeType};base64,${image.data}` : undefined
}

export interface Turn {
  id?: string
  user?: PigUserMessage
  bash?: { command: string; exitCode?: number; cancelled: boolean }
  bashRunning?: boolean
  process: ProcessItem[]
  /**
   * Landmarks from the projection, used until the process is read: Pi writes a compaction into the
   * same stream as the work, so a loaded process carries its own copies and outranks these.
   */
  compactions?: CompactionItem[]
  branchSummaries?: DisplayTurn['branchSummaries']
  /** Persisted work layout, available before the process bodies are read. */
  workBlocks?: DisplayTurn['workBlocks']
  answer: AnswerBlock[]
  errorMessage?: string
  startedAt: number
  endedAt: number
  streaming: boolean
  /** Latest stream position within a request, and message order across tool/result boundaries. */
  waitingForModel: boolean
  hasProcess?: boolean
  workedMs?: number
  generation?: GenerationStats
  /** Stable UI identity shared by the live and persisted versions of a turn. */
  renderKey?: string
}

function lastToolCallIndex(content: AssistantMessage['content']): number {
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i].type === 'toolCall') return i
  }
  return -1
}

/**
 * Union of the models behind one turn's samples, in first-seen order. A model switch mid-turn makes
 * the summed window a blend, so the identities have to survive the addition.
 */
function mergeGenerationModels(
  first: readonly string[] | undefined,
  second: readonly string[] | undefined
): string[] {
  if (!first?.length) return second ? [...second] : []
  if (!second?.length) return [...first]
  const merged = [...first]
  for (const model of second) {
    if (!merged.includes(model)) merged.push(model)
  }
  return merged
}

function hashText(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

export function renderKeyForUser(user: Pick<PigUserMessage, 'timestamp' | 'content'>): string {
  const text = typeof user.content === 'string'
    ? user.content
    : user.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
  const imageCount = typeof user.content === 'string'
    ? 0
    : user.content.filter((block) => block.type === 'image').length
  return `user:${user.timestamp}:${hashText(JSON.stringify([text.slice(0, 256), imageCount]))}`
}

export function renderKeyForMessages(messages: PiMessage[], fallback: number): string {
  const user = messages.find((message): message is PigUserMessage => message.role === 'user')
  return user ? renderKeyForUser(user) : `turn:${messages[0]?.timestamp ?? fallback}`
}

/** Identity shared by the live and persisted versions of one turn. */
export function renderKeyForTurn(turn: Pick<Turn, 'renderKey' | 'id'>, fallback: number | string): string {
  return turn.renderKey ?? turn.id ?? `turn:${fallback}`
}

function pushText(process: ProcessItem[], text: string, textBoundary: number): void {
  const trimmed = text.trimEnd()
  if (!trimmed) return
  const last = process[process.length - 1]
  if (last?.kind === 'text' && process.length > textBoundary) {
    last.text = `${last.text}\n${trimmed}`
    return
  }
  process.push({ kind: 'text', text: trimmed })
}

/** Adjacent thoughts share a row, but only the newest piece owns its live state. */
function pushThinking(
  process: ProcessItem[],
  text: string,
  durationMs: number,
  live: boolean,
  thinkingBoundary: number
): void {
  const last = process[process.length - 1]
  if (last?.kind === 'thinking' && process.length > thinkingBoundary) {
    last.text += `\n\n${text}`
    last.durationMs += durationMs
    last.live = live
    return
  }
  process.push({ kind: 'thinking', text, durationMs, live })
}

function lastTools(process: ProcessItem[]): ToolStep[] | undefined {
  const last = process[process.length - 1]
  return last?.kind === 'tools' ? last.tools : undefined
}

function ensureTools(process: ProcessItem[]): ToolStep[] {
  const existing = lastTools(process)
  if (existing) return existing
  const tools: ToolStep[] = []
  process.push({ kind: 'tools', tools })
  return tools
}

function addToolCall(process: ProcessItem[], call: ToolCall): void {
  const tools = ensureTools(process)
  if (tools.some((t) => t.id === call.id)) return
  tools.push({
    id: call.id,
    name: call.name,
    args: (call.arguments ?? {}) as Record<string, unknown>
  })
}

function addToolResult(process: ProcessItem[], result: ToolResultMessage): void {
  for (let i = process.length - 1; i >= 0; i--) {
    const item = process[i]
    if (item.kind !== 'tools') continue
    const step = item.tools.find((t) => t.id === result.toolCallId)
    if (step) {
      step.result = result
      return
    }
  }
  ensureTools(process).push({
    id: result.toolCallId,
    name: result.toolName,
    args: {},
    result
  })
}

function persistedAtOf(message: PiMessage): number {
  const value = (message as { persistedAt?: unknown }).persistedAt
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function thinkingFallbackMs(message: AssistantMessage): number {
  const persist = persistedAtOf(message)
  return persist > message.timestamp ? persist - message.timestamp : 0
}

/** Stream end events describe a gap; old content in the same snapshot is not current output. */
function assistantWaitingForModel(message: AssistantMessage, thinkingDurations: ThinkingDurations): boolean {
  const event = message.streamEvent
  if (event?.type === 'done') return false
  if (event?.type === 'thinking_end' || event?.type === 'text_end') return true
  const index = event?.contentIndex ?? message.content.length - 1
  const block = message.content[index]
  if (!block) return true
  if (block.type === 'thinking') {
    return !block.thinking || (!event && thinkingDurations[thinkingTimingKey(message.timestamp, index)] !== undefined)
  }
  return block.type === 'text' && !block.text.trimEnd()
}

function consumeAssistant(
  process: ProcessItem[],
  message: AssistantMessage,
  splitTrailingText: boolean,
  thinkingDurations: ThinkingDurations,
  active: boolean,
  thinkingBoundary: number,
  textBoundary: number
): AnswerBlock[] {
  const answer: AnswerBlock[] = []
  const splitAt = splitTrailingText ? lastToolCallIndex(message.content) : -1
  const fallbackMs = thinkingFallbackMs(message)
  let usedFallback = false

  message.content.forEach((block, i) => {
    const toAnswer = splitTrailingText && i > splitAt
    if (block.type === 'thinking') {
      if (block.thinking) {
        const measured = thinkingDurations[thinkingTimingKey(message.timestamp, i)]
        let durationMs = measured ?? 0
        if (measured === undefined && !usedFallback && fallbackMs > 0) {
          durationMs = fallbackMs
          usedFallback = true
        }
        const event = message.streamEvent
        const live = active && i === (event?.contentIndex ?? message.content.length - 1) &&
          (event ? event.type === 'thinking_start' || event.type === 'thinking_delta' : measured === undefined)
        pushThinking(process, block.thinking, durationMs, live, thinkingBoundary)
      }
      return
    }
    if (block.type === 'toolCall') {
      addToolCall(process, block)
      return
    }
    if (toAnswer) {
      if (block.text) answer.push({ type: 'text', text: block.text })
      return
    }
    pushText(process, block.text, textBoundary)
  })

  return answer
}

export function buildTurn(
  chunk: PiMessage[],
  streaming: boolean,
  thinkingDurations: ThinkingDurations = {},
  renderKey?: string,
  liveCompactions: readonly LiveCompaction[] = [],
  messageOffset = 0
): Turn {
  const user = chunk[0]?.role === 'user' ? (chunk[0] as PigUserMessage) : undefined
  const bash = chunk[0]?.role === 'bashExecution' ? chunk[0] : undefined
  const rest = user ? chunk.slice(1) : chunk
  const process: ProcessItem[] = []
  const branchSummaries: DisplayTurn['branchSummaries'] = []
  let thinkingBoundary = 0
  let textBoundary = 0
  let answer: AnswerBlock[] = []
  let errorMessage: string | undefined
  let generation: GenerationStats | undefined
  // Summarizing is not work: the clock runs from the prompt to the next landmark, and the blocks
  // either side of a compaction keep the totals they had reached. Pi writes compactions as session
  // entries rather than messages, so this only applies to a stream that carries one anyway.
  const workStart = user?.timestamp ?? chunk[0]?.timestamp ?? 0
  let summarizedMs = 0
  let compactionCount = 0
  let waitingForModel = true
  // Failed attempts stay in process, but their unexecuted calls cannot block a later request.
  let pendingToolCalls: Set<string> | undefined
  let compactionIndex = 0
  while (
    messageOffset > 0 && compactionIndex < liveCompactions.length &&
    liveCompactions[compactionIndex].afterMessageCount <= messageOffset
  ) compactionIndex++

  // Boundaries belong to the source message array, including its user messages. A later output
  // stays after its compaction even while the landmark still has no persisted session entry.
  const appendCompactionsThrough = (messageCount: number) => {
    while (
      compactionIndex < liveCompactions.length &&
      liveCompactions[compactionIndex].afterMessageCount <= messageCount
    ) {
      const mark = liveCompactions[compactionIndex++]
      const durationMs = mark.endedAt == null ? 0 : Math.max(0, mark.endedAt - mark.startedAt)
      process.push({
        kind: 'compaction',
        text: mark.summary ?? '',
        tokensBefore: mark.tokensBefore ?? 0,
        afterAnswer: false,
        workMsBefore: mark.workMsBefore,
        durationMs,
        live: mark
      })
      waitingForModel = mark.status === 'done'
      summarizedMs += durationMs
      compactionCount++
    }
  }

  let lastAssistant = -1
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].role === 'assistant') lastAssistant = i
  }

  rest.forEach((message, i) => {
    appendCompactionsThrough(messageOffset + (user ? 1 : 0) + i)
    if (message.role === 'assistant') {
      if (message.generation) {
        generation = {
          outputTokens: (generation?.outputTokens ?? 0) + message.generation.outputTokens,
          durationMs: (generation?.durationMs ?? 0) + message.generation.durationMs,
          measuredCalls: (generation?.measuredCalls ?? 0) + message.generation.measuredCalls,
          totalCalls: (generation?.totalCalls ?? 0) + message.generation.totalCalls,
          models: mergeGenerationModels(generation?.models, message.generation.models)
        }
      }
      if (streaming) {
        waitingForModel = assistantWaitingForModel(message, thinkingDurations)
        const failed = !!message.errorMessage || message.stopReason === 'error' || message.stopReason === 'aborted'
        for (const block of message.content) {
          if (block.type === 'toolCall' && !failed) (pendingToolCalls ??= new Set<string>()).add(block.id)
        }
      }
      const isLast = i === lastAssistant
      const trailingIsAnswer = isLast && rest.slice(i + 1).every((m) => m.role !== 'toolResult')
      const splitTrailing = isLast && lastToolCallIndex(message.content) >= 0
      const blocks = consumeAssistant(
        process,
        message,
        splitTrailing && trailingIsAnswer,
        thinkingDurations,
        streaming && i === rest.length - 1,
        thinkingBoundary,
        textBoundary
      )
      if (!streaming && isLast && (trailingIsAnswer || lastToolCallIndex(message.content) < 0)) {
        if (blocks.length) answer = blocks
        else if (!splitTrailing) {
          const pulled: AnswerBlock[] = []
          while (process.length > textBoundary && process[process.length - 1].kind === 'text') {
            const item = process.pop() as Extract<ProcessItem, { kind: 'text' }>
            pulled.unshift({ type: 'text', text: item.text })
          }
          answer = pulled
        }
      }
      // Pi keeps a failed attempt in raw history while a retry continues past it. Only the last
      // assistant message is still the turn's outcome, so an answer that recovered has no error.
      errorMessage = message.errorMessage
      return
    }
    if (message.role === 'toolResult') {
      addToolResult(process, message)
      // Matched results update earlier tools instead of appending a visible boundary.
      thinkingBoundary = process.length
      pendingToolCalls?.delete(message.toolCallId)
      waitingForModel = true
      return
    }
    if (message.role === 'bashExecution') {
      process.push({ kind: 'bash', message })
      waitingForModel = false
      return
    }
    if (message.role === 'custom') {
      if (message.display) process.push({ kind: 'custom', message })
      return
    }
    if (message.role === 'branchSummary') {
      branchSummaries.push({ text: message.summary, afterAnswer: i > lastAssistant, compactionsBefore: compactionCount })
      // The standalone notice leaves no process row to stop text merging or answer extraction.
      textBoundary = thinkingBoundary = process.length
      return
    }
    if (message.role === 'compactionSummary') {
      // The summary is written while nothing else happens, so the entry before it is when it began.
      const precededAt = rest[i - 1]?.timestamp ?? workStart
      const durationMs = Math.max(0, message.timestamp - precededAt)
      process.push({
        kind: 'compaction',
        text: message.summary,
        tokensBefore: message.tokensBefore,
        // Position, not the turn's state: an overflow error earlier in the chunk is followed by a
        // retried answer, and that compaction still belongs inside the work.
        afterAnswer: i > lastAssistant,
        workMsBefore: Math.max(0, precededAt - workStart - summarizedMs),
        durationMs
      })
      summarizedMs += durationMs
      compactionCount++
      waitingForModel = true
    }
  })
  appendCompactionsThrough(messageOffset + chunk.length)

  const startedAt = rest[0]?.timestamp ?? user?.timestamp ?? 0
  const endedAt = rest[rest.length - 1]?.timestamp ?? startedAt

  return {
    user,
    bash: bash ? { command: bash.command, exitCode: bash.exitCode, cancelled: bash.cancelled } : undefined,
    process,
    branchSummaries,
    answer,
    errorMessage,
    startedAt,
    endedAt,
    streaming,
    waitingForModel: streaming && !errorMessage && waitingForModel && !pendingToolCalls?.size,
    hasProcess: process.length > 0 || streaming,
    ...(generation ? { generation } : {}),
    ...(renderKey ? { renderKey } : {})
  }
}

export function groupTurns(
  messages: PiMessage[],
  streaming: boolean,
  thinkingDurations: ThinkingDurations = {},
  toolUpdates: ToolUpdates = {},
  liveCompactions: readonly LiveCompaction[] = []
): Turn[] {
  const chunks: PiMessage[][] = []
  let current: PiMessage[] = []
  for (const message of messages) {
    if (message.role === 'user' || message.role === 'bashExecution') {
      if (current.length) chunks.push(current)
      current = [message]
    } else {
      current.push(message)
    }
  }
  if (current.length) chunks.push(current)
  let messageOffset = 0
  return chunks.map((chunk, i) => {
    const turn = buildTurn(
      chunk,
      streaming && i === chunks.length - 1,
      thinkingDurations,
      renderKeyForMessages(chunk, i),
      liveCompactions,
      messageOffset
    )
    messageOffset += chunk.length
    for (const item of turn.process) {
      if (item.kind !== 'tools') continue
      for (const step of item.tools) {
        if (!step.result && toolUpdates[step.id]) step.partialResult = toolUpdates[step.id]
      }
    }
    return turn
  })
}

export function formatElapsed(ms: number, t: Translate): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return t('time.seconds', { n: s })
  const m = Math.floor(s / 60)
  const r = s % 60
  return r ? t('time.minutesSeconds', { m, r }) : t('time.minutes', { n: m })
}

function oneLine(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  return text.replace(/\s+/g, ' ').trim()
}

export function toolStepLabel(step: ToolStep, t: Translate): string {
  const args = step.args
  switch (step.name) {
    case 'bash':
      return args.command
        ? t('tool.run', { command: oneLine(args.command) })
        : t('tool.runPlain')
    case 'read':
      return args.path ? t('tool.read', { path: oneLine(args.path) }) : t('tool.readPlain')
    case 'write':
      return args.path ? t('tool.write', { path: oneLine(args.path) }) : t('tool.writePlain')
    case 'edit':
      return args.path ? t('tool.edit', { path: oneLine(args.path) }) : t('tool.editPlain')
    case 'ls':
      return t('tool.list', { path: oneLine(args.path ?? '.') })
    case 'fffind':
    case 'find':
      return args.pattern
        ? t('tool.find', { pattern: oneLine(args.pattern) })
        : t('tool.findPlain')
    case 'ffgrep':
    case 'grep':
      return args.pattern
        ? t('tool.search', { pattern: oneLine(args.pattern) })
        : t('tool.searchPlain')
    default:
      return t('tool.call', { name: step.name })
  }
}

export function resultText(result?: Pick<ToolResultMessage, 'content'>): string {
  if (!result) return ''
  return result.content
    .filter((b): b is TextContent => b.type === 'text')
    .map((b) => b.text)
    .join('')
}