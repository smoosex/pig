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

const bubble = 'rounded-2.5 px-3.5 py-2.5 text-sm leading-normal break-words whitespace-pre-wrap'
const toggle =
  'flex w-full min-w-0 cursor-pointer items-center gap-1.5 border-none bg-transparent py-1 text-[13px] text-muted'
const pre = 'mt-2 max-h-60 overflow-auto font-mono text-xs leading-snug break-words whitespace-pre-wrap'
const toolCard = 'mt-1.5 rounded-lg border border-line px-3 py-2'
const halfTruncate = 'max-w-1/2 min-w-0 truncate'

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
  return (
    <ChevronRight
      className={`size-3.5 shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
    />
  )
}

function UserBubble({ message }: { message: UserMessage }) {
  return (
    <div className="mb-4 ml-auto max-w-9/10">
      <div className={`${bubble} bg-accent text-black`}>{userText(message)}</div>
      {userImages(message).map((image, i) => (
        <img
          key={i}
          className="my-1.5 block max-w-90 rounded-lg"
          src={`data:${image.mimeType};base64,${image.data}`}
          alt=""
        />
      ))}
    </div>
  )
}

function Answer({
  blocks,
  streaming,
  errorMessage,
  inset
}: {
  blocks: AnswerBlock[]
  streaming?: boolean
  errorMessage?: string
  inset?: boolean
}) {
  if (blocks.length === 0 && !streaming && !errorMessage) return null
  return (
    <div className="mb-4 max-w-9/10">
      {blocks.map((block, i) =>
        block.type === 'text' ? (
          <div
            key={i}
            className={`${bubble} ${inset ? 'bg-elev-2' : 'bg-elev'} ${streaming && i === blocks.length - 1 ? 'caret-blink' : ''}`}
          >
            {block.text}
          </div>
        ) : (
          <img
            key={i}
            className="my-1.5 block max-w-90 rounded-lg"
            src={`data:${block.image.mimeType};base64,${block.image.data}`}
            alt=""
          />
        )
      )}
      {errorMessage ? <div className="mt-1.5 text-xs text-danger">{errorMessage}</div> : null}
    </div>
  )
}

function ToolDetail({ step, inset }: { step: ToolStep; inset?: boolean }) {
  const command = typeof step.args.command === 'string' ? step.args.command : undefined
  const output = resultText(step.result)
  const failed = !!step.result?.isError
  const pending = !step.result
  return (
    <div className={`${toolCard} ${inset ? 'bg-elev-2' : 'bg-elev'} ${failed ? 'border-danger' : ''}`}>
      <div className={`text-xs font-semibold ${failed ? 'text-danger' : 'text-muted'}`}>{step.name}</div>
      {command ? <div className="mt-1 font-mono text-xs text-muted">$ {command}</div> : null}
      {!command && Object.keys(step.args).length > 0 ? <pre className={pre}>{JSON.stringify(step.args, null, 2)}</pre> : null}
      {output ? <pre className={pre}>{output}</pre> : null}
      <div className={`mt-1.5 text-xs ${failed ? 'text-danger' : 'text-muted'}`}>
        {failed ? '✗ 失败' : pending ? '… 执行中' : '✓ 成功'}
      </div>
    </div>
  )
}

function ToolRow({ step }: { step: ToolStep }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex min-w-0 flex-col pl-4.5">
      <button type="button" className={toggle} onClick={() => setOpen((v) => !v)}>
        <Chevron open={open} />
        <span className={halfTruncate}>{toolStepLabel(step)}</span>
      </button>
      {open ? <ToolDetail step={step} inset /> : null}
    </div>
  )
}

function ToolGroup({ tools }: { tools: ToolStep[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex min-w-0 flex-col">
      <button type="button" className={toggle} onClick={() => setOpen((v) => !v)}>
        <Command className="size-3.5 shrink-0" />
        <span className={halfTruncate}>{toolGroupLabel(tools)}</span>
        <Chevron open={open} />
      </button>
      {open ? tools.map((step) => <ToolRow key={step.id} step={step} />) : null}
    </div>
  )
}

function BashProcess({ message }: { message: BashExecutionMessage }) {
  const [open, setOpen] = useState(false)
  const failed = message.cancelled || (message.exitCode ?? 0) !== 0
  return (
    <div className="flex min-w-0 flex-col">
      <button type="button" className={toggle} onClick={() => setOpen((v) => !v)}>
        <SquareTerminal className="size-3.5 shrink-0" />
        <span className={halfTruncate}>执行 {message.command}</span>
        <Chevron open={open} />
      </button>
      {open ? (
        <div className={`${toolCard} bg-elev-2 ${failed ? 'border-danger' : ''}`}>
          <div className={`text-xs font-semibold ${failed ? 'text-danger' : 'text-muted'}`}>bash</div>
          <div className="mt-1 font-mono text-xs text-muted">$ {message.command}</div>
          {message.output ? <pre className={pre}>{message.output}</pre> : null}
          <div className={`mt-1.5 text-xs ${failed ? 'text-danger' : 'text-muted'}`}>
            {message.cancelled ? '已取消' : failed ? '✗ 失败' : '✓ 成功'}
          </div>
        </div>
      ) : null}
    </div>
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
    <div>
      <div className={toggle}>{message.customType}</div>
      {text ? <p>{text}</p> : null}
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

function LiveStep({ item }: { item: ProcessItem }) {
  const line = liveLine(item)
  if (!line) {
    return (
      <div className="flex w-full min-w-0 items-center gap-1.5 overflow-hidden text-[13px] text-muted">
        <ThinkLabel />
      </div>
    )
  }
  return (
    <div className="flex w-full min-w-0 items-center gap-1.5 overflow-hidden text-[13px] text-muted">
      <ChevronRight className="size-3.5 shrink-0" />
      <span className={`text-shimmer ${halfTruncate}`}>{line}</span>
    </div>
  )
}

function ProcessList({ items }: { items: ProcessItem[] }) {
  return (
    <div className="mt-2 flex min-w-0 flex-col gap-2">
      {items.map((item, i) => {
        if (item.kind === 'text') {
          return (
            <div key={i} className="max-w-none">
              <div className={`${bubble} bg-elev-2`}>{item.text}</div>
            </div>
          )
        }
        if (item.kind === 'thinking') {
          return (
            <details
              key={i}
              className="rounded-lg border border-line bg-elev-2 px-3 py-2 text-xs text-muted [&_summary]:cursor-pointer [&_summary]:select-none"
            >
              <summary>思考</summary>
              <pre className={pre}>{item.text}</pre>
            </details>
          )
        }
        if (item.kind === 'tools') return <ToolGroup key={i} tools={item.tools} />
        if (item.kind === 'bash') return <BashProcess key={i} message={item.message} />
        if (item.kind === 'custom') return <CustomProcess key={i} message={item.message} />
        return (
          <details
            key={i}
            className="rounded-lg border border-line bg-elev-2 px-3 py-2 text-xs text-muted [&_summary]:cursor-pointer [&_summary]:select-none"
          >
            <summary>{item.title}</summary>
            <pre className={pre}>{item.text}</pre>
          </details>
        )
      })}
    </div>
  )
}

export function TurnView({ turn }: { turn: Turn }) {
  const hasProcess = turn.process.length > 0 || turn.streaming
  const [open, setOpen] = useState(false)

  useEffect(() => {
    setOpen(false)
  }, [turn.streaming])

  const elapsed = useElapsed(turn.streaming)
  const live = turn.streaming ? liveProcessItem(turn.process) : null
  const expanded = turn.streaming || open
  const label = turn.streaming
    ? formatElapsed(elapsed)
    : `推理/执行过程(${formatDuration(turn.startedAt, turn.endedAt)})`

  return (
    <div className="mb-4">
      {turn.user ? <UserBubble message={turn.user} /> : null}
      {hasProcess ? (
        <div
          className={`mb-3 max-w-9/10 ${expanded ? 'overflow-hidden rounded-lg border border-line bg-elev px-3 py-2' : ''}`}
        >
          {turn.streaming ? null : (
            <button type="button" className={toggle} onClick={() => setOpen((v) => !v)}>
              <span>{label}</span>
              <Chevron open={open} />
            </button>
          )}
          {turn.streaming && live ? (
            <LiveStep
              key={live.kind === 'tools' ? live.tools[0]?.id : live.kind}
              item={live}
            />
          ) : null}
          {turn.streaming ? <div className="mt-1.5 text-xs text-muted">{formatElapsed(elapsed)}</div> : null}
          {!turn.streaming && open ? <ProcessList items={turn.process} /> : null}
        </div>
      ) : null}
      {turn.streaming ? null : <Answer blocks={turn.answer} errorMessage={turn.errorMessage} />}
    </div>
  )
}