import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Command, SquareTerminal } from 'lucide-react'
import type {
  BashExecutionMessage,
  CustomMessage,
  ImageContent,
  TextContent,
  UserMessage
} from '../pi/types'
import {
  formatDuration,
  formatElapsed,
  liveProcessItem,
  resultText,
  toolGroupLabel,
  toolStepLabel,
  type AnswerBlock,
  type ProcessItem,
  type ToolStep,
  type Turn
} from '../chat/turns'
import { cn } from '../lib/utils'
import { Bubble, BubbleContent } from './ui/bubble'
import { Button } from './ui/button'
import { Card, CardContent } from './ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible'
import { Message, MessageContent } from './ui/message'

const pre = 'mt-2 max-h-60 overflow-auto font-mono text-xs leading-snug break-words whitespace-pre-wrap'
const halfTruncate = 'max-w-1/2 min-w-0 truncate'
const disclosureButton =
  'h-7 w-full min-w-0 justify-start gap-1.5 rounded-md px-1 font-normal text-muted-foreground'

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

function useElapsed(streaming: boolean): number {
  const [elapsed, setElapsed] = useState(0)
  const origin = useRef(Date.now())

  useEffect(() => {
    if (!streaming) {
      setElapsed(0)
      return
    }
    origin.current = Date.now()
    setElapsed(0)
    const id = window.setInterval(() => setElapsed(Date.now() - origin.current), 200)
    return () => window.clearInterval(id)
  }, [streaming])

  return elapsed
}

function Chevron({ open }: { open: boolean }) {
  return <ChevronRight className={cn('shrink-0 transition-transform duration-150', open && 'rotate-90')} />
}

function UserBubble({ message }: { message: UserMessage }) {
  return (
    <Message align="end" className="mb-4">
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
      <MessageContent className="w-fit max-w-9/10 gap-1.5">
        {blocks.map((block, i) =>
          block.type === 'text' ? (
            <Bubble key={i} variant="elevated" className="max-w-full">
              <BubbleContent className="whitespace-pre-wrap">{block.text}</BubbleContent>
            </Bubble>
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

function ToolDetail({ step, inset }: { step: ToolStep; inset?: boolean }) {
  const command = typeof step.args.command === 'string' ? step.args.command : undefined
  const output = resultText(step.result)
  const failed = !!step.result?.isError
  const pending = !step.result
  return (
    <Card
      size="sm"
      className={cn('mt-1.5 py-0', inset && 'bg-muted', failed && 'ring-destructive')}
    >
      <CardContent className="p-3">
        <div className={cn('text-xs font-semibold', failed ? 'text-destructive' : 'text-muted-foreground')}>
          {step.name}
        </div>
        {command ? <div className="mt-1 font-mono text-xs text-muted-foreground">$ {command}</div> : null}
        {!command && Object.keys(step.args).length > 0 ? (
          <pre className={pre}>{JSON.stringify(step.args, null, 2)}</pre>
        ) : null}
        {output ? <pre className={pre}>{output}</pre> : null}
        <div className={cn('mt-1.5 text-xs', failed ? 'text-destructive' : 'text-muted-foreground')}>
          {failed ? '✗ 失败' : pending ? '… 执行中' : '✓ 成功'}
        </div>
      </CardContent>
    </Card>
  )
}

function ToolRow({ step }: { step: ToolStep }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0 pl-4.5">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className={disclosureButton}>
          <Chevron open={open} />
          <span className={halfTruncate}>{toolStepLabel(step)}</span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ToolDetail step={step} inset />
      </CollapsibleContent>
    </Collapsible>
  )
}

function ToolGroup({ tools }: { tools: ToolStep[] }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className={disclosureButton}>
          <Command />
          <span className={halfTruncate}>{toolGroupLabel(tools)}</span>
          <Chevron open={open} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex min-w-0 flex-col">
        {tools.map((step) => (
          <ToolRow key={step.id} step={step} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

function BashProcess({ message }: { message: BashExecutionMessage }) {
  const [open, setOpen] = useState(false)
  const failed = message.cancelled || (message.exitCode ?? 0) !== 0
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className={disclosureButton}>
          <SquareTerminal />
          <span className={halfTruncate}>执行 {message.command}</span>
          <Chevron open={open} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Card size="sm" className={cn('mt-1.5 py-0', failed && 'ring-destructive')}>
          <CardContent className="p-3">
            <div className={cn('text-xs font-semibold', failed ? 'text-destructive' : 'text-muted-foreground')}>
              bash
            </div>
            <div className="mt-1 font-mono text-xs text-muted-foreground">$ {message.command}</div>
            {message.output ? <pre className={pre}>{message.output}</pre> : null}
            <div className={cn('mt-1.5 text-xs', failed ? 'text-destructive' : 'text-muted-foreground')}>
              {message.cancelled ? '已取消' : failed ? '✗ 失败' : '✓ 成功'}
            </div>
          </CardContent>
        </Card>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ProcessDisclosure({ title, text }: { title: string; text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg bg-muted px-2 py-1">
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
      <span>思</span>
      <span>考</span>
    </span>
  )
}

function liveLine(item: ProcessItem): string | null {
  if (item.kind === 'tools' && item.tools[0]) return toolStepLabel(item.tools[0])
  if (item.kind === 'bash') return `执行 ${item.message.command}`
  return null
}

function LiveStep({ item }: { item?: ProcessItem }) {
  const line = item ? liveLine(item) : null
  if (!line) {
    return (
      <div className="flex w-full min-w-0 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground">
        <ThinkLabel />
      </div>
    )
  }
  return (
    <div className="flex w-full min-w-0 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground">
      <ChevronRight className="size-3.5 shrink-0" />
      <span className={cn('text-shimmer', halfTruncate)}>{line}</span>
    </div>
  )
}

function ProcessList({ items }: { items: ProcessItem[] }) {
  return (
    <div className="mt-2 flex min-w-0 flex-col gap-2">
      {items.map((item, i) => {
        if (item.kind === 'text') {
          return (
            <Bubble key={i} variant="muted" className="max-w-none">
              <BubbleContent className="whitespace-pre-wrap">{item.text}</BubbleContent>
            </Bubble>
          )
        }
        if (item.kind === 'thinking') {
          return <ProcessDisclosure key={i} title="思考" text={item.text} />
        }
        if (item.kind === 'tools') return <ToolGroup key={i} tools={item.tools} />
        if (item.kind === 'bash') return <BashProcess key={i} message={item.message} />
        if (item.kind === 'custom') return <CustomProcess key={i} message={item.message} />
        return <ProcessDisclosure key={i} title={item.title} text={item.text} />
      })}
    </div>
  )
}

export function TurnView({
  turn,
  onNeedProcess
}: {
  turn: Turn
  onNeedProcess?: () => Promise<void>
}) {
  const hasProcess = Boolean(turn.hasProcess) || turn.process.length > 0 || turn.streaming
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setOpen(false)
  }, [turn.streaming])

  const elapsed = useElapsed(turn.streaming)
  const live = turn.streaming ? liveProcessItem(turn.process) : null
  const expanded = turn.streaming || open
  const label = `推理/执行过程(${formatDuration(turn.startedAt, turn.endedAt)})`

  async function toggleProcess(): Promise<void> {
    if (open) {
      setOpen(false)
      return
    }
    if (turn.process.length === 0 && onNeedProcess) {
      setLoading(true)
      try {
        await onNeedProcess()
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
        <div
          className={cn(
            'mb-3 max-w-9/10',
            expanded && 'overflow-hidden rounded-lg border border-border bg-card px-3 py-2'
          )}
        >
          {!turn.streaming ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn(disclosureButton, 'w-fit')}
              disabled={loading}
              onClick={() => void toggleProcess()}
            >
              <span>{label}</span>
              <Chevron open={open} />
            </Button>
          ) : null}
          {turn.streaming ? <LiveStep item={live ?? undefined} /> : null}
          {turn.streaming ? <div className="mt-1.5 text-xs text-muted-foreground">{formatElapsed(elapsed)}</div> : null}
          {!turn.streaming && open ? <ProcessList items={turn.process} /> : null}
        </div>
      ) : null}
      {turn.streaming ? null : <Answer blocks={turn.answer} errorMessage={turn.errorMessage} />}
    </div>
  )
}
