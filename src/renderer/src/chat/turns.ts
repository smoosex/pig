import type {
  AssistantMessage,
  BashExecutionMessage,
  CustomMessage,
  ImageContent,
  PiMessage,
  TextContent,
  ToolCall,
  ToolResultMessage,
  UserMessage
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
  | { kind: 'summary'; title: string; text: string }

export type AnswerBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; image: ImageContent }

export interface Turn {
  id?: string
  user?: UserMessage
  process: ProcessItem[]
  answer: AnswerBlock[]
  errorMessage?: string
  startedAt: number
  endedAt: number
  streaming: boolean
  hasProcess?: boolean
  workedMs?: number
}

function lastToolCallIndex(content: AssistantMessage['content']): number {
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i].type === 'toolCall') return i
  }
  return -1
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

function consumeAssistant(
  process: ProcessItem[],
  message: AssistantMessage,
  splitTrailingText: boolean,
  thinkingDurations: ThinkingDurations
): AnswerBlock[] {
  const answer: AnswerBlock[] = []
  const splitAt = splitTrailingText ? lastToolCallIndex(message.content) : -1

  message.content.forEach((block, i) => {
    const toAnswer = splitTrailingText && i > splitAt
    if (block.type === 'thinking') {
      if (block.thinking) {
        process.push({
          kind: 'thinking',
          text: block.thinking,
          durationMs: thinkingDurations[thinkingTimingKey(message.timestamp, i)] ?? 0
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
  thinkingDurations: ThinkingDurations = {}
): Turn {
  const user = chunk[0]?.role === 'user' ? (chunk[0] as UserMessage) : undefined
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
      process.push({ kind: 'summary', title: '分支摘要', text: message.summary })
      return
    }
    if (message.role === 'compactionSummary') {
      process.push({ kind: 'summary', title: '压缩摘要', text: message.summary })
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
    hasProcess: process.length > 0 || streaming
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
    buildTurn(chunk, streaming && i === chunks.length - 1, thinkingDurations)
  )
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r ? `${m} 分 ${r} 秒` : `${m} 分`
}

export function formatDuration(startedAt: number, endedAt: number): string {
  return formatElapsed(Math.max(1000, endedAt - startedAt))
}

function oneLine(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  return text.replace(/\s+/g, ' ').trim()
}

export function toolStepLabel(step: ToolStep): string {
  const args = step.args
  switch (step.name) {
    case 'bash':
      return args.command ? `执行 ${oneLine(args.command)}` : '执行命令'
    case 'read':
      return args.path ? `读取 ${oneLine(args.path)}` : '读取文件'
    case 'write':
      return args.path ? `写入 ${oneLine(args.path)}` : '写入文件'
    case 'edit':
      return args.path ? `编辑 ${oneLine(args.path)}` : '编辑文件'
    case 'ls':
      return `列出 ${oneLine(args.path ?? '.')}`
    case 'fffind':
    case 'find':
      return args.pattern ? `查找 ${oneLine(args.pattern)}` : '查找文件'
    case 'ffgrep':
    case 'grep':
      return args.pattern ? `搜索 ${oneLine(args.pattern)}` : '搜索代码'
    default:
      return `调用 ${step.name}`
  }
}

export function toolGroupLabel(tools: ToolStep[]): string {
  const cats: string[] = []
  const seen = new Set<string>()
  for (const step of tools) {
    let cat = step.name
    if (step.name === 'bash') cat = '执行命令'
    else if (step.name === 'read') cat = '读取文件'
    else if (step.name === 'write' || step.name === 'edit') cat = '编辑文件'
    else if (step.name === 'ls') cat = '列出文件'
    else if (step.name === 'fffind' || step.name === 'find' || step.name === 'ffgrep' || step.name === 'grep') {
      cat = '搜索'
    }
    if (!seen.has(cat)) {
      seen.add(cat)
      cats.push(cat)
    }
  }
  return cats.join('、')
}

export function resultText(result?: ToolResultMessage): string {
  if (!result) return ''
  return result.content
    .filter((b): b is TextContent => b.type === 'text')
    .map((b) => b.text)
    .join('')
}