import type { MessageKey, Translate } from '../../../shared/i18n'
import type {
  AssistantMessage,
  BashExecutionMessage,
  CustomMessage,
  PiMessage,
  PigImageContent,
  PigUserMessage,
  TextContent,
  ToolCall,
  ToolResultMessage
} from '../pi/types'

export interface ToolStep {
  id: string
  name: string
  args: Record<string, unknown>
  result?: ToolResultMessage
}

export type ThinkingDurations = Record<string, number>

export function thinkingTimingKey(messageTimestamp: number, contentIndex: number): string {
  return `${messageTimestamp}:${contentIndex}`
}

export type ProcessItem =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string; durationMs: number }
  | { kind: 'tools'; tools: ToolStep[] }
  | { kind: 'bash'; message: BashExecutionMessage }
  | { kind: 'custom'; message: CustomMessage }
  | { kind: 'summary'; titleKey: MessageKey; text: string }

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
  process: ProcessItem[]
  answer: AnswerBlock[]
  errorMessage?: string
  startedAt: number
  endedAt: number
  streaming: boolean
  hasProcess?: boolean
  workedMs?: number
  /** Stable UI identity shared by the live and persisted versions of a turn. */
  renderKey?: string
}

function lastToolCallIndex(content: AssistantMessage['content']): number {
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i].type === 'toolCall') return i
  }
  return -1
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

function pushText(process: ProcessItem[], text: string): void {
  const trimmed = text.trimEnd()
  if (!trimmed) return
  const last = process[process.length - 1]
  if (last?.kind === 'text') {
    last.text = `${last.text}\n${trimmed}`
    return
  }
  process.push({ kind: 'text', text: trimmed })
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

function consumeAssistant(
  process: ProcessItem[],
  message: AssistantMessage,
  splitTrailingText: boolean,
  thinkingDurations: ThinkingDurations
): AnswerBlock[] {
  const answer: AnswerBlock[] = []
  const splitAt = splitTrailingText ? lastToolCallIndex(message.content) : -1
  const fallbackMs = thinkingFallbackMs(message)
  let usedFallback = false

  message.content.forEach((block, i) => {
    const toAnswer = splitTrailingText && i > splitAt
    if (block.type === 'thinking') {
      if (block.thinking) {
        const measured = thinkingDurations[thinkingTimingKey(message.timestamp, i)] ?? 0
        let durationMs = measured
        if (durationMs <= 0 && !usedFallback && fallbackMs > 0) {
          durationMs = fallbackMs
          usedFallback = true
        }
        process.push({
          kind: 'thinking',
          text: block.thinking,
          durationMs
        })
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
    pushText(process, block.text)
  })

  return answer
}

export function buildTurn(
  chunk: PiMessage[],
  streaming: boolean,
  thinkingDurations: ThinkingDurations = {},
  renderKey?: string
): Turn {
  const user = chunk[0]?.role === 'user' ? (chunk[0] as PigUserMessage) : undefined
  const rest = user ? chunk.slice(1) : chunk
  const process: ProcessItem[] = []
  let answer: AnswerBlock[] = []
  let errorMessage: string | undefined

  let lastAssistant = -1
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].role === 'assistant') lastAssistant = i
  }

  rest.forEach((message, i) => {
    if (message.role === 'assistant') {
      const isLast = i === lastAssistant
      const trailingIsAnswer = isLast && rest.slice(i + 1).every((m) => m.role !== 'toolResult')
      const splitTrailing = isLast && lastToolCallIndex(message.content) >= 0
      const blocks = consumeAssistant(
        process,
        message,
        splitTrailing && trailingIsAnswer,
        thinkingDurations
      )
      if (!streaming && isLast && (trailingIsAnswer || lastToolCallIndex(message.content) < 0)) {
        if (blocks.length) answer = blocks
        else if (!splitTrailing) {
          const pulled: AnswerBlock[] = []
          while (process.length > 0 && process[process.length - 1].kind === 'text') {
            const item = process.pop() as Extract<ProcessItem, { kind: 'text' }>
            pulled.unshift({ type: 'text', text: item.text })
          }
          answer = pulled
        }
      }
      if (message.errorMessage) errorMessage = message.errorMessage
      return
    }
    if (message.role === 'toolResult') {
      addToolResult(process, message)
      return
    }
    if (message.role === 'bashExecution') {
      process.push({ kind: 'bash', message })
      return
    }
    if (message.role === 'custom') {
      if (message.display) process.push({ kind: 'custom', message })
      return
    }
    if (message.role === 'branchSummary') {
      process.push({ kind: 'summary', titleKey: 'chat.branchSummary', text: message.summary })
      return
    }
    if (message.role === 'compactionSummary') {
      process.push({ kind: 'summary', titleKey: 'chat.compactionSummary', text: message.summary })
    }
  })

  const startedAt = rest[0]?.timestamp ?? user?.timestamp ?? 0
  const endedAt = rest[rest.length - 1]?.timestamp ?? startedAt

  return {
    user,
    process,
    answer,
    errorMessage,
    startedAt,
    endedAt,
    streaming,
    hasProcess: process.length > 0 || streaming,
    ...(renderKey ? { renderKey } : {})
  }
}

export function groupTurns(
  messages: PiMessage[],
  streaming: boolean,
  thinkingDurations: ThinkingDurations = {}
): Turn[] {
  const chunks: PiMessage[][] = []
  let current: PiMessage[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      if (current.length) chunks.push(current)
      current = [message]
    } else {
      current.push(message)
    }
  }
  if (current.length) chunks.push(current)
  return chunks.map((chunk, i) =>
    buildTurn(
      chunk,
      streaming && i === chunks.length - 1,
      thinkingDurations,
      renderKeyForMessages(chunk, i)
    )
  )
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

export function resultText(result?: ToolResultMessage): string {
  if (!result) return ''
  return result.content
    .filter((b): b is TextContent => b.type === 'text')
    .map((b) => b.text)
    .join('')
}