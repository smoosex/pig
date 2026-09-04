import { memo, useEffect, useState, type ReactNode } from 'react'
import { ThinkingOrb } from 'thinking-orbs'
import { useSessionsStore } from '../stores/sessions'
import { Brain, ChevronRight, FileText, SquareTerminal, Wrench, type LucideIcon } from 'lucide-react'
import type {
  BashExecutionMessage,
  CustomMessage,
  ImageContent,
  TextContent,
  UserMessage
} from '../pi/types'
import {
  formatElapsed,
  resultText,
  toolStepLabel,
  type AnswerBlock,
  type ProcessItem,
  type ToolStep,
  type Turn
} from '../chat/turns'
import { langFromPath, useHighlightHtml } from '../lib/highlight'
import { cn } from '../lib/utils'
import { Bubble, BubbleContent } from './ui/bubble'
import { Button } from './ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible'
import { Separator } from './ui/separator'
import { MarkdownText } from './MarkdownText'
import { Message, MessageContent } from './ui/message'

const hideScroll = '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
const pre = `mt-2 max-h-60 overflow-auto font-mono text-xs leading-snug break-words whitespace-pre-wrap ${hideScroll}`
const disclosureRow =
  'flex h-7 w-full min-w-0 items-center justify-start gap-1.5 px-1 text-[0.8rem] font-normal text-muted-foreground'
const disclosureButton =
  'h-7 w-full min-w-0 justify-start gap-1.5 rounded-md px-1 font-normal text-muted-foreground aria-expanded:bg-transparent hover:aria-expanded:bg-muted dark:aria-expanded:bg-transparent dark:hover:aria-expanded:bg-muted'

function WaveText({ text }: { text: string }) {
  return (
    <span className="tool-wave" data-text={text}>
      {text}
    </span>
  )
}

function VerbLabel({ text, failed, active }: { text: string; failed?: boolean; active?: boolean }) {
  return (
    <span className={cn('min-w-0 flex-1 truncate text-left', failed && 'text-destructive')}>
      <span className={cn(!failed && 'text-foreground')}>{text.slice(0, 2)}</span>
      {active ? <WaveText text={text.slice(2)} /> : <span>{text.slice(2)}</span>}
    </span>
  )
}

function userText(message: UserMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content
    .filter((b): b is TextContent => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

function userImages(message: UserMessage): ImageContent[] {
  if (typeof message.content === 'string') return []
  return message.content.filter((b): b is ImageContent => b.type === 'image')
}

function Chevron({ open }: { open: boolean }) {
  return <ChevronRight className={cn('shrink-0 transition-transform duration-150', open && 'rotate-90')} />
}

function UserBubble({ message }: { message: UserMessage }) {
  return (
    <Message align="end" className="mb-4" data-turn-user="">
      <MessageContent className="w-fit max-w-9/10 gap-1.5">
        <Bubble align="end" className="max-w-full">
          <BubbleContent className="whitespace-pre-wrap">{userText(message)}</BubbleContent>
        </Bubble>
        {userImages(message).map((image, i) => (
          <img
            key={i}
            className="my-1.5 block max-w-90 rounded-lg"
            src={`data:${image.mimeType};base64,${image.data}`}
            alt=""
          />
        ))}
      </MessageContent>
    </Message>
  )
}

function Answer({ blocks, errorMessage }: { blocks: AnswerBlock[]; errorMessage?: string }) {
  if (blocks.length === 0 && !errorMessage) return null
  return (
    <Message align="start" className="mb-4">
      <MessageContent className="w-fit max-w-9/10 gap-1.5 px-1">
        {blocks.map((block, i) =>
          block.type === 'text' ? (
            <MarkdownText key={i} text={block.text} />
          ) : (
            <img
              key={i}
              className="my-1.5 block max-w-90 rounded-lg"
              src={`data:${block.image.mimeType};base64,${block.image.data}`}
              alt=""
            />
          )
        )}
        {errorMessage ? <div className="mt-1.5 text-xs text-destructive">{errorMessage}</div> : null}
      </MessageContent>
    </Message>
  )
}

type IconKind = 'thinking' | 'bash' | 'file' | 'tool'

const ICONS: Record<IconKind, LucideIcon> = {
  thinking: Brain,
  bash: SquareTerminal,
  file: FileText,
  tool: Wrench
}

function stackKindForTool(name: string): IconKind {
  if (name === 'bash') return 'bash'
  if (name === 'read' || name === 'write' || name === 'edit') return 'file'
  return 'tool'
}

function iconKinds(items: ProcessItem[]): IconKind[] {
  const kinds: IconKind[] = []
  const seen = new Set<IconKind>()
  const push = (kind: IconKind) => {
    if (seen.has(kind)) return
    seen.add(kind)
    kinds.push(kind)
  }
  for (const item of items) {
    if (item.kind === 'thinking') push('thinking')
    else if (item.kind === 'bash') push('bash')
    else if (item.kind === 'custom' || item.kind === 'summary') push('tool')
    else if (item.kind === 'tools') {
      for (const step of item.tools) push(stackKindForTool(step.name))
    }
  }
  return kinds
}

type WorkRow =
  | { kind: 'thinking'; text: string; durationMs: number }
  | { kind: 'tools'; steps: ToolStep[] }
  | { kind: 'bash'; messages: BashExecutionMessage[] }
  | { kind: 'custom'; message: CustomMessage }
  | { kind: 'summary'; title: string; text: string }

function clusterWork(items: ProcessItem[]): WorkRow[] {
  const rows: WorkRow[] = []
  for (const item of items) {
    if (item.kind === 'thinking') {
      rows.push({ kind: 'thinking', text: item.text, durationMs: item.durationMs })
      continue
    }
    if (item.kind === 'tools') {
      for (const step of item.tools) {
        const last = rows[rows.length - 1]
        if (last?.kind === 'tools' && last.steps[0].name === step.name) last.steps.push(step)
        else rows.push({ kind: 'tools', steps: [step] })
      }
      continue
    }
    if (item.kind === 'bash') {
      const last = rows[rows.length - 1]
      if (last?.kind === 'bash') last.messages.push(item.message)
      else rows.push({ kind: 'bash', messages: [item.message] })
      continue
    }
    if (item.kind === 'custom') rows.push({ kind: 'custom', message: item.message })
    else if (item.kind === 'summary') rows.push({ kind: 'summary', title: item.title, text: item.text })
  }
  return rows
}

function toolClusterLabel(steps: ToolStep[]): string {
  const n = steps.length
  switch (steps[0].name) {
    case 'read':
      return `读取 ${n} 个文件`
    case 'write':
      return `写入 ${n} 个文件`
    case 'edit':
      return `编辑 ${n} 个文件`
    case 'bash':
      return `执行 ${n} 个命令`
    case 'ls':
      return `列出 ${n} 次`
    case 'fffind':
    case 'find':
      return `查找 ${n} 次`
    case 'ffgrep':
    case 'grep':
      return `搜索 ${n} 次`
    default:
      return `调用 ${steps[0].name} ${n} 次`
  }
}

function countTools(items: ProcessItem[]): number {
  let n = 0
  for (const item of items) {
    if (item.kind === 'tools') n += item.tools.length
    else if (item.kind === 'bash') n += 1
  }
  return n
}

function toolInput(step: ToolStep): string {
  const command = typeof step.args.command === 'string' ? step.args.command : undefined
  if (command) return `$ ${command}`
  const path = typeof step.args.path === 'string' ? step.args.path : undefined
  if (path) return path
  const pattern = typeof step.args.pattern === 'string' ? step.args.pattern : undefined
  if (pattern) return pattern
  return Object.keys(step.args).length > 0 ? JSON.stringify(step.args, null, 2) : ''
}

const panelCell =
  `max-h-60 overflow-auto px-3 py-2 font-mono text-xs leading-snug break-words whitespace-pre-wrap text-muted-foreground ${hideScroll}`

function editList(args: Record<string, unknown>): { oldText: string; newText: string }[] {
  const edits = args.edits
  if (Array.isArray(edits)) {
    return edits.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const row = item as { oldText?: unknown; newText?: unknown }
      if (typeof row.oldText === 'string' && typeof row.newText === 'string') {
        return [{ oldText: row.oldText, newText: row.newText }]
      }
      return []
    })
  }
  if (typeof args.oldText === 'string' && typeof args.newText === 'string') {
    return [{ oldText: args.oldText, newText: args.newText }]
  }
  return []
}

function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function hunkRows(oldText: string, newText: string): { type: 'ctx' | 'del' | 'add'; text: string }[] {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const rows: { type: 'ctx' | 'del' | 'add'; text: string }[] = []
  for (let i = 0; i < start; i++) rows.push({ type: 'ctx', text: a[i] })
  for (let i = start; i < endA; i++) rows.push({ type: 'del', text: a[i] })
  for (let i = start; i < endB; i++) rows.push({ type: 'add', text: b[i] })
  for (let i = endA; i < a.length; i++) rows.push({ type: 'ctx', text: a[i] })
  return rows
}

function EditDiff({ edits }: { edits: { oldText: string; newText: string }[] }) {
  return (
    <div className="max-h-80 overflow-auto rounded-lg border border-border bg-card font-mono text-xs leading-snug [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {edits.map((edit, i) => (
        <div key={i}>
          <div className="px-3 py-1.5 text-muted-foreground">{`// — edit ${i + 1} —`}</div>
          {hunkRows(edit.oldText, edit.newText).map((row, j) => (
            <div
              key={j}
              className={cn(
                'min-h-5 whitespace-pre px-3',
                row.type === 'del' && 'bg-destructive/15 text-destructive',
                row.type === 'add' && 'bg-primary/15 text-primary',
                row.type === 'ctx' && 'text-muted-foreground'
              )}
            >
              {`${row.type === 'del' ? '-' : row.type === 'add' ? '+' : ' '} ${row.text}`}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function splitReadOutput(text: string): { code: string; notice?: string } {
  const idx = text.lastIndexOf('\n\n[')
  if (idx === -1) return { code: text }
  const tail = text.slice(idx + 2)
  if (tail.startsWith('[') && tail.endsWith(']') && /offset=|exceeds /.test(tail)) {
    return { code: text.slice(0, idx), notice: tail }
  }
  return { code: text }
}

function CodePanel({ path, code, notice }: { path: string; code: string; notice?: string }) {
  const html = useHighlightHtml(code, langFromPath(path))
  return (
    <div className="max-h-80 overflow-auto rounded-lg border border-border bg-card font-mono text-xs leading-snug [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {html ? (
        <div
          className="[&_pre]:m-0 [&_pre]:overflow-visible [&_pre]:bg-transparent! [&_pre]:p-3 [&_pre]:text-xs [&_pre]:leading-snug"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="m-0 whitespace-pre p-3">{code}</pre>
      )}
      {notice ? <div className="px-3 pb-3 text-muted-foreground">{notice}</div> : null}
    </div>
  )
}

function ToolPanel({ input, output }: { input?: string; output?: string }) {
  if (!input && !output) return null
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      {input ? <pre className={panelCell}>{input}</pre> : null}
      {input && output ? <Separator /> : null}
      {output ? <pre className={panelCell}>{output}</pre> : null}
    </div>
  )
}

function Rail({ children }: { children: ReactNode }) {
  return (
    <div className="relative">
      <div className="absolute inset-y-0 left-3.5 w-px -translate-x-1/2 bg-border" />
      <div className="min-w-0 py-1 pl-6">{children}</div>
    </div>
  )
}

function StackedIcons({ kinds }: { kinds: IconKind[] }) {
  return (
    <span className="flex shrink-0 items-center">
      {kinds.map((kind, i) => {
        const Icon = ICONS[kind]
        return (
          <span
            key={`${kind}-${i}`}
            className={cn(
              'relative flex size-5 items-center justify-center rounded-full border border-border bg-card',
              i > 0 && '-ml-1.5'
            )}
            style={{ zIndex: i }}
          >
            <Icon className="size-2.5" />
          </span>
        )
      })}
    </span>
  )
}

function ToolRow({ step }: { step: ToolStep }) {
  const [open, setOpen] = useState(false)
  const failed = !!step.result?.isError
  const edits = step.name === 'edit' ? editList(step.args) : []
  const path = typeof step.args.path === 'string' ? step.args.path : ''
  const writeCode = step.name === 'write' && typeof step.args.content === 'string' ? step.args.content : ''
  const read = step.name === 'read' && !failed ? splitReadOutput(resultText(step.result)) : undefined
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className={disclosureButton}>
          <VerbLabel text={toolStepLabel(step)} failed={failed} />
          <Chevron open={open} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-1 pt-1">
        {read?.code ? (
          <CodePanel path={path} code={read.code} notice={read.notice} />
        ) : writeCode && !failed ? (
          <CodePanel path={path} code={writeCode} />
        ) : edits.length > 0 ? (
          <EditDiff edits={edits} />
        ) : (
          <ToolPanel input={toolInput(step)} output={resultText(step.result)} />
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

function BashRow({ message }: { message: BashExecutionMessage }) {
  const [open, setOpen] = useState(false)
  const failed = message.cancelled || (message.exitCode ?? 0) !== 0
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className={disclosureButton}>
          <VerbLabel text={`执行 ${message.command}`} failed={failed} />
          <Chevron open={open} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-1 pt-1">
        <ToolPanel input={`$ ${message.command}`} output={message.output} />
      </CollapsibleContent>
    </Collapsible>
  )
}

function ToolCluster({ steps }: { steps: ToolStep[] }) {
  const [open, setOpen] = useState(false)
  if (steps.length === 1) return <ToolRow step={steps[0]} />
  const failed = steps.some((step) => !!step.result?.isError)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className={disclosureButton}>
          <VerbLabel text={toolClusterLabel(steps)} failed={failed} />
          <Chevron open={open} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-1 pt-1">
        <div className="flex min-w-0 flex-col">
          {steps.map((step) => (
            <ToolRow key={step.id} step={step} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function BashCluster({ messages }: { messages: BashExecutionMessage[] }) {
  const [open, setOpen] = useState(false)
  if (messages.length === 1) return <BashRow message={messages[0]} />
  const failed = messages.some((message) => message.cancelled || (message.exitCode ?? 0) !== 0)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className={disclosureButton}>
          <VerbLabel text={`执行 ${messages.length} 个命令`} failed={failed} />
          <Chevron open={open} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-1 pt-1">
        <div className="flex min-w-0 flex-col">
          {messages.map((message, i) => (
            <BashRow key={i} message={message} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function stripThoughtHeading(text: string): string {
  return text.replace(/^(Thought for \d+s|已?思考了?\s*\d+\s*(秒|s)?)\s*\n+/i, '').trim()
}

function ProcessDisclosure({ title, text }: { title: string; text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className={disclosureButton}>
          <Chevron open={open} />
          <span>{title}</span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className={cn(pre, 'px-2 pb-2 text-muted-foreground')}>{text}</pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ThinkingBlock({ text, durationMs }: { text: string; durationMs: number }) {
  const [open, setOpen] = useState(false)
  const body = stripThoughtHeading(text)
  const title = durationMs > 0 ? `已思考 ${formatElapsed(durationMs)}` : '思考'
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className={cn(disclosureButton, 'w-full')}>
          <StackedIcons kinds={['thinking']} />
          <span className="min-w-0 flex-1 truncate text-left">{title}</span>
          <Chevron open={open} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {body ? (
          <Rail>
            <pre className={cn(pre, 'mt-0 text-muted-foreground')}>{body}</pre>
          </Rail>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  )
}

function ThinkingLine({ text, durationMs }: { text: string; durationMs: number }) {
  const [open, setOpen] = useState(false)
  const body = stripThoughtHeading(text)
  const title = durationMs > 0 ? `已思考 ${formatElapsed(durationMs)}` : '思考'
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className={disclosureButton}>
          <span className="min-w-0 flex-1 truncate text-left">{title}</span>
          <Chevron open={open} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-1 pt-1">
        {body ? (
          <pre className={cn(pre, 'mt-0 ml-2.5 border-l border-border px-3 py-1 text-muted-foreground')}>
            {body}
          </pre>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  )
}

function GroupBody({ items }: { items: ProcessItem[] }) {
  return (
    <div className="flex min-w-0 flex-col">
      {clusterWork(items).map((row, i) => {
        if (row.kind === 'thinking') {
          return <ThinkingLine key={i} text={row.text} durationMs={row.durationMs} />
        }
        if (row.kind === 'tools') return <ToolCluster key={row.steps[0].id} steps={row.steps} />
        if (row.kind === 'bash') return <BashCluster key={i} messages={row.messages} />
        if (row.kind === 'custom') return <CustomProcess key={i} message={row.message} />
        if (row.kind === 'summary') return <ProcessDisclosure key={i} title={row.title} text={row.text} />
        return null
      })}
    </div>
  )
}

function ActivityGroup({ items }: { items: ProcessItem[] }) {
  const [open, setOpen] = useState(false)
  const tools = countTools(items)
  if (tools === 0) {
    return (
      <>
        {items.map((item, i) => {
          if (item.kind === 'thinking') {
            return <ThinkingBlock key={i} text={item.text} durationMs={item.durationMs} />
          }
          if (item.kind === 'custom') return <CustomProcess key={i} message={item.message} />
          if (item.kind === 'summary') return <ProcessDisclosure key={i} title={item.title} text={item.text} />
          return null
        })}
      </>
    )
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className={cn(disclosureButton, 'w-full')}>
          <StackedIcons kinds={iconKinds(items)} />
          <span className="min-w-0 flex-1 truncate text-left">使用了 {tools} 个工具</span>
          <Chevron open={open} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Rail>
          <GroupBody items={items} />
        </Rail>
      </CollapsibleContent>
    </Collapsible>
  )
}

function CustomProcess({ message }: { message: CustomMessage }) {
  const text =
    typeof message.content === 'string'
      ? message.content
      : message.content
          .filter((b): b is TextContent => b.type === 'text')
          .map((b) => b.text)
          .join('')
  return (
    <div className="text-sm">
      <div className="font-medium text-muted-foreground">{message.customType}</div>
      {text ? <p className="mt-1 whitespace-pre-wrap">{text}</p> : null}
    </div>
  )
}

function ThinkLabel() {
  return (
    <span className="think-wave">
      {[...'思考中...'].map((char, i) => (
        <span key={`${char}-${i}`} style={{ animationDelay: `${i * 0.08}s` }}>
          {char}
        </span>
      ))}
    </span>
  )
}

const WAIT_LINES = [
  '正在加班加点理解你的问题...',
  '网速被乌龟侵占了，正在寻找兔子...',
  '问题有点调皮，我先围着它转两圈...',
  '正在把你的话从空气里捞出来...',
  '神经元还在排队，马上就到...',
  '先热热身，灵感正在路上堵车...'
]

function WaitLine() {
  const [index, setIndex] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => {
      setIndex((current) => {
        if (WAIT_LINES.length < 2) return current
        let next = current
        while (next === current) next = Math.floor(Math.random() * WAIT_LINES.length)
        return next
      })
    }, 2800)
    return () => window.clearInterval(id)
  }, [])
  const text = WAIT_LINES[index] ?? WAIT_LINES[0]
  return (
    <span className="think-wave">
      {[...text].map((char, i) => (
        <span key={`${index}-${i}`} style={{ animationDelay: `${i * 0.08}s` }}>
          {char}
        </span>
      ))}
    </span>
  )
}

function OutlineThinking({
  text,
  durationMs,
  current,
  stacked
}: {
  text?: string
  durationMs: number
  current?: boolean
  stacked?: boolean
}) {
  const body = text ? stripThoughtHeading(text) : ''
  const header = (
    <div className={cn(disclosureRow, 'pointer-events-none')}>
      {stacked ? <StackedIcons kinds={['thinking']} /> : null}
      <span className="min-w-0 flex-1 truncate text-left">
        {current ? <ThinkLabel /> : durationMs > 0 ? `已思考 ${formatElapsed(durationMs)}` : '思考'}
      </span>
    </div>
  )
  if (!current || !body) return header
  const stream = (
    <pre
      className={cn(
        'mt-0 font-mono text-xs leading-snug break-words whitespace-pre-wrap text-muted-foreground',
        !stacked && 'ml-2.5 border-l border-border px-3 py-1'
      )}
    >
      {body}
    </pre>
  )
  return (
    <div className="min-w-0">
      {header}
      {stacked ? <Rail>{stream}</Rail> : stream}
    </div>
  )
}

function OutlineTool({ step, active }: { step: ToolStep; active?: boolean }) {
  return (
    <div className={cn(disclosureRow, 'pointer-events-none')}>
      <VerbLabel text={toolStepLabel(step)} failed={!!step.result?.isError} active={active} />
    </div>
  )
}

function OutlineBash({ message, active }: { message: BashExecutionMessage; active?: boolean }) {
  const failed = message.cancelled || (message.exitCode ?? 0) !== 0
  return (
    <div className={cn(disclosureRow, 'pointer-events-none')}>
      <VerbLabel text={`执行 ${message.command}`} failed={failed} active={active} />
    </div>
  )
}

function OutlineRow({ row, last }: { row: WorkRow; last: boolean }) {
  if (row.kind === 'thinking') {
    if (last && row.durationMs <= 0) return <OutlineThinking text={row.text} durationMs={0} current />
    return <ThinkingLine text={row.text} durationMs={row.durationMs} />
  }
  if (row.kind === 'tools') {
    if (!last) return <ToolCluster steps={row.steps} />
    const done = row.steps.filter((step) => step.result)
    const live = row.steps.filter((step) => !step.result)
    return (
      <>
        {done.length === 1 ? <ToolRow step={done[0]} /> : done.length > 1 ? <ToolCluster steps={done} /> : null}
        {live.map((step, i) => (
          <OutlineTool key={step.id} step={step} active={i === live.length - 1} />
        ))}
      </>
    )
  }
  if (row.kind === 'bash') {
    if (!last) return <BashCluster messages={row.messages} />
    const past = row.messages.slice(0, -1)
    const current = row.messages[row.messages.length - 1]
    return (
      <>
        {past.length === 1 ? (
          <BashRow message={past[0]} />
        ) : past.length > 1 ? (
          <BashCluster messages={past} />
        ) : null}
        {current ? <OutlineBash message={current} active /> : null}
      </>
    )
  }
  if (row.kind === 'custom') return <CustomProcess message={row.message} />
  if (row.kind === 'summary') return <ProcessDisclosure title={row.title} text={row.text} />
  return null
}

function OutlineBody({ items, active }: { items: ProcessItem[]; active: boolean }) {
  const rows = clusterWork(items)
  return (
    <div className="flex min-w-0 flex-col">
      {rows.map((row, i) => (
        <OutlineRow key={i} row={row} last={active && i === rows.length - 1} />
      ))}
    </div>
  )
}

function OutlineGroup({ items, active }: { items: ProcessItem[]; active: boolean }) {
  const tools = countTools(items)
  if (tools === 0) {
    return (
      <>
        {items.map((item, i) => {
          if (item.kind === 'thinking') {
            const live = active && i === items.length - 1 && item.durationMs <= 0
            if (live) {
              return <OutlineThinking key={i} text={item.text} durationMs={0} current stacked />
            }
            return <ThinkingBlock key={i} text={item.text} durationMs={item.durationMs} />
          }
          if (item.kind === 'custom') return <CustomProcess key={i} message={item.message} />
          if (item.kind === 'summary') return <ProcessDisclosure key={i} title={item.title} text={item.text} />
          return null
        })}
      </>
    )
  }
  return (
    <div className="min-w-0">
      <div className={cn(disclosureRow, 'pointer-events-none')}>
        <StackedIcons kinds={iconKinds(items)} />
        <span className="min-w-0 flex-1 truncate text-left">正在使用工具</span>
      </div>
      <Rail>
        <OutlineBody items={items} active={active} />
      </Rail>
    </div>
  )
}

function ProcessOutline({ items }: { items: ProcessItem[] }) {
  const segments = processSegments(items)
  if (segments.length === 0) {
    return (
      <div className={cn(disclosureRow, 'pointer-events-none')}>
        <ThinkingOrb state="shaping" size={20} theme="auto" className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">
          <WaitLine />
        </span>
      </div>
    )
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {segments.map((segment, i) =>
        segment.kind === 'text' ? (
          <MarkdownText key={i} className="px-1 text-sm" text={segment.text} />
        ) : (
          <OutlineGroup key={i} items={segment.items} active={i === segments.length - 1} />
        )
      )}
    </div>
  )
}

function processSegments(items: ProcessItem[]): Array<{ kind: 'text'; text: string } | { kind: 'group'; items: ProcessItem[] }> {
  const segments: Array<{ kind: 'text'; text: string } | { kind: 'group'; items: ProcessItem[] }> = []
  let group: ProcessItem[] = []
  const flush = () => {
    if (group.length === 0) return
    segments.push({ kind: 'group', items: group })
    group = []
  }
  for (const item of items) {
    if (item.kind === 'text') {
      flush()
      segments.push({ kind: 'text', text: item.text })
    } else {
      group.push(item)
    }
  }
  flush()
  return segments
}

function ProcessList({ items }: { items: ProcessItem[] }) {
  return (
    <div className="mt-2 flex min-w-0 flex-col gap-2">
      {processSegments(items).map((segment, i) =>
        segment.kind === 'text' ? (
          <MarkdownText key={i} className="px-1 text-sm" text={segment.text} />
        ) : (
          <ActivityGroup key={i} items={segment.items} />
        )
      )}
    </div>
  )
}

function useWorkedMs(turn: Turn): number {
  const streamStartedAt = useSessionsStore((s) =>
    s.activeSessionId ? (s.runtime[s.activeSessionId]?.streamStartedAt ?? null) : null
  )
  const streamElapsedMs = useSessionsStore((s) =>
    s.activeSessionId ? (s.runtime[s.activeSessionId]?.streamElapsedMs ?? null) : null
  )
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!turn.streaming || streamStartedAt == null) return
    const id = window.setInterval(() => setNow(Date.now()), 200)
    return () => window.clearInterval(id)
  }, [turn.streaming, streamStartedAt])

  if (turn.streaming) return streamStartedAt != null ? Math.max(0, now - streamStartedAt) : 0
  if (turn.workedMs != null) return turn.workedMs
  if (turn.id?.startsWith('live-') && streamElapsedMs != null) return streamElapsedMs
  return Math.max(1000, turn.endedAt - turn.startedAt)
}

export const TurnView = memo(function TurnView({
  turn,
  onNeedProcess
}: {
  turn: Turn
  onNeedProcess?: (turnId: string) => Promise<void>
}) {
  const hasProcess = Boolean(turn.hasProcess) || turn.process.length > 0 || turn.streaming
  const [open, setOpen] = useState(turn.streaming)
  const [liveOutline, setLiveOutline] = useState(turn.streaming)
  const [loading, setLoading] = useState(false)
  const workedMs = useWorkedMs(turn)
  const label = turn.streaming
    ? `已工作 ${formatElapsed(workedMs)}`
    : `工作耗时 ${formatElapsed(workedMs)}`

  useEffect(() => {
    if (turn.streaming) {
      setLiveOutline(true)
      setOpen(true)
      return
    }
    setOpen(false)
    const id = window.setTimeout(() => setLiveOutline(false), 300)
    return () => window.clearTimeout(id)
  }, [turn.streaming])

  async function toggleProcess(next: boolean): Promise<void> {
    if (turn.streaming) return
    if (!next) {
      setOpen(false)
      return
    }
    if (turn.process.length === 0 && onNeedProcess && turn.id && !turn.id.startsWith('live-')) {
      setLoading(true)
      try {
        await onNeedProcess(turn.id)
      } finally {
        setLoading(false)
      }
    }
    setOpen(true)
  }

  return (
    <div className="mb-4">
      {turn.user ? <UserBubble message={turn.user} /> : null}
      {hasProcess ? (
        <Collapsible
          open={open}
          onOpenChange={(next) => void toggleProcess(next)}
          className="mb-3"
        >
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              disabled={loading}
              className={cn(
                'h-7 w-full justify-start gap-3 rounded-none px-0 text-xs font-normal text-muted-foreground hover:bg-transparent hover:text-muted-foreground aria-expanded:bg-transparent aria-expanded:text-muted-foreground hover:aria-expanded:bg-transparent dark:hover:bg-transparent dark:aria-expanded:bg-transparent dark:hover:aria-expanded:bg-transparent',
                turn.streaming && 'pointer-events-none'
              )}
            >
              <span className="h-px min-w-4 flex-1 bg-border" />
              <span className="flex shrink-0 items-center gap-1">
                {label}
                <ChevronRight className={cn('size-3.5 transition-transform duration-150', open && 'rotate-90')} />
              </span>
              <span className="h-px min-w-4 flex-1 bg-border" />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="duration-300">
            {liveOutline ? (
              <ProcessOutline items={turn.process} />
            ) : (
              <ProcessList items={turn.process} />
            )}
          </CollapsibleContent>
        </Collapsible>
      ) : null}
      {turn.streaming ? null : <Answer blocks={turn.answer} errorMessage={turn.errorMessage} />}
    </div>
  )
})
