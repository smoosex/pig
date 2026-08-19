import { useEffect, useRef, useState } from 'react'
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
  return <span className={`chevron ${open ? 'open' : ''}`}>›</span>
}

function UserBubble({ message }: { message: UserMessage }) {
  return (
    <div className="msg user">
      <div className="msg-bubble">{userText(message)}</div>
      {userImages(message).map((image, i) => (
        <img
          key={i}
          className="msg-image"
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
  errorMessage
}: {
  blocks: AnswerBlock[]
  streaming?: boolean
  errorMessage?: string
}) {
  if (blocks.length === 0 && !streaming && !errorMessage) return null
  return (
    <div className={`msg assistant ${streaming ? 'streaming' : ''}`}>
      {blocks.map((block, i) =>
        block.type === 'text' ? (
          <div key={i} className="msg-bubble">
            {block.text}
          </div>
        ) : (
          <img
            key={i}
            className="msg-image"
            src={`data:${block.image.mimeType};base64,${block.image.data}`}
            alt=""
          />
        )
      )}
      {errorMessage ? <div className="msg-error">{errorMessage}</div> : null}
    </div>
  )
}

function ToolDetail({ step }: { step: ToolStep }) {
  const command = typeof step.args.command === 'string' ? step.args.command : undefined
  const output = resultText(step.result)
  const failed = !!step.result?.isError
  const pending = !step.result
  return (
    <div className={`block-tool ${failed ? 'error' : ''}`}>
      <div className="block-tool-name">{step.name}</div>
      {command ? <div className="tool-card-cmd">$ {command}</div> : null}
      {!command && Object.keys(step.args).length > 0 ? (
        <pre>{JSON.stringify(step.args, null, 2)}</pre>
      ) : null}
      {output ? <pre>{output}</pre> : null}
      <div className={`tool-card-status ${failed ? 'error' : pending ? 'pending' : ''}`}>
        {failed ? '✗ 失败' : pending ? '… 执行中' : '✓ 成功'}
      </div>
    </div>
  )
}

function ToolRow({ step }: { step: ToolStep }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="tool-row">
      <button type="button" className="tool-row-toggle" onClick={() => setOpen((v) => !v)}>
        <Chevron open={open} />
        <span className="truncate">{toolStepLabel(step)}</span>
      </button>
      {open ? <ToolDetail step={step} /> : null}
    </div>
  )
}

function ToolGroup({ tools }: { tools: ToolStep[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="tool-group">
      <button type="button" className="tool-group-toggle" onClick={() => setOpen((v) => !v)}>
        <span className="tool-group-icon">⌘</span>
        <span className="truncate">{toolGroupLabel(tools)}</span>
        <Chevron open={open} />
      </button>
      {open
        ? tools.map((step) => <ToolRow key={step.id} step={step} />)
        : null}
    </div>
  )
}

function BashProcess({ message }: { message: BashExecutionMessage }) {
  const [open, setOpen] = useState(false)
  const failed = message.cancelled || (message.exitCode ?? 0) !== 0
  return (
    <div className="tool-group">
      <button type="button" className="tool-group-toggle" onClick={() => setOpen((v) => !v)}>
        <span className="tool-group-icon">$</span>
        <span className="truncate">执行 {message.command}</span>
        <Chevron open={open} />
      </button>
      {open ? (
        <div className={`block-tool ${failed ? 'error' : ''}`}>
          <div className="block-tool-name">bash</div>
          <div className="tool-card-cmd">$ {message.command}</div>
          {message.output ? <pre>{message.output}</pre> : null}
          <div className={`tool-card-status ${failed ? 'error' : ''}`}>
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
    <div className="process-custom">
      <div className="tool-group-toggle">{message.customType}</div>
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
      <div className="live-line">
        <ThinkLabel />
      </div>
    )
  }
  return (
    <div className="live-line">
      <span>›</span>
      <span className="live-text wave">{line}</span>
    </div>
  )
}

function ProcessList({ items }: { items: ProcessItem[] }) {
  return (
    <div className="process-body">
      {items.map((item, i) => {
        if (item.kind === 'text') {
          return (
            <div key={i} className="msg assistant">
              <div className="msg-bubble">{item.text}</div>
            </div>
          )
        }
        if (item.kind === 'thinking') {
          return (
            <details key={i} className="block-thinking">
              <summary>思考</summary>
              <pre>{item.text}</pre>
            </details>
          )
        }
        if (item.kind === 'tools') return <ToolGroup key={i} tools={item.tools} />
        if (item.kind === 'bash') return <BashProcess key={i} message={item.message} />
        if (item.kind === 'custom') return <CustomProcess key={i} message={item.message} />
        return (
          <details key={i} className="block-thinking">
            <summary>{item.title}</summary>
            <pre>{item.text}</pre>
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
    <div className="turn">
      {turn.user ? <UserBubble message={turn.user} /> : null}
      {hasProcess ? (
        <div className={`process ${expanded ? 'open' : ''}`}>
          {turn.streaming ? null : (
            <button type="button" className="process-toggle" onClick={() => setOpen((v) => !v)}>
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
          {turn.streaming ? <div className="process-elapsed">{formatElapsed(elapsed)}</div> : null}
          {!turn.streaming && open ? <ProcessList items={turn.process} /> : null}
        </div>
      ) : null}
      {turn.streaming ? null : (
        <Answer blocks={turn.answer} errorMessage={turn.errorMessage} />
      )}
    </div>
  )
}