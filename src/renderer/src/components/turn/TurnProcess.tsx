/**
 * Completed work stays collapsed until requested. The live outline renders the
 * same Pi process items while keeping unfinished work visible.
 */
import { useEffect, useState } from 'react'
import { ThinkingOrb } from 'thinking-orbs'
import type { BashExecutionMessage } from '../../pi/types'
import { formatElapsed, toolStepLabel, type ProcessItem, type ToolStep } from '../../chat/turns'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { Marker, MarkerContent } from '../ui/marker'
import { MarkdownText } from '../MarkdownText'
import { Chevron, disclosureButton, Rail, StackedIcons, statusMarker, VerbLabel } from './ProcessChrome'
import { clusterWork, countTools, iconKinds, processSegments, type WorkRow } from './process-model'
import { BashCluster, BashRow, ToolCluster, ToolRow } from './ToolDetails'
import { CustomProcess, ProcessDisclosure, stripThoughtHeading, ThinkingBlock, ThinkingLine } from './ProcessText'

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

const WAIT_LINES = [
  '正在加班加点理解你的问题...',
  '网速被乌龟侵占了，正在寻找兔子...',
  '问题有点调皮，我先围着它转两圈...',
  '正在把你的话从空气里捞出来...',
  '神经元还在排队，马上就到...',
  '先热热身，灵感正在路上堵车...'
]

function WaitLine({ streaming }: { streaming: boolean }) {
  const [index, setIndex] = useState(0)
  useEffect(() => {
    if (!streaming) return
    const id = window.setInterval(() => {
      setIndex((current) => {
        if (WAIT_LINES.length < 2) return current
        let next = current
        while (next === current) next = Math.floor(Math.random() * WAIT_LINES.length)
        return next
      })
    }, 2800)
    return () => window.clearInterval(id)
  }, [streaming])
  return <span className={cn(streaming && 'shimmer')}>{WAIT_LINES[index] ?? WAIT_LINES[0]}</span>
}

function OutlineThinking({
  text,
  durationMs,
  current,
  stacked,
  streaming
}: {
  text?: string
  durationMs: number
  current?: boolean
  stacked?: boolean
  streaming: boolean
}) {
  const body = text ? stripThoughtHeading(text) : ''
  const header = (
    <Marker className={statusMarker}>
      {stacked ? <StackedIcons kinds={['thinking']} /> : null}
      <MarkerContent className="flex-1 truncate">
        <span className={cn(current && streaming && 'shimmer')}>
          {current ? '思考中...' : durationMs > 0 ? `已思考 ${formatElapsed(durationMs)}` : '思考'}
        </span>
      </MarkerContent>
    </Marker>
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
    <Marker className={statusMarker}>
      <MarkerContent className="flex min-w-0 flex-1">
        <VerbLabel text={toolStepLabel(step)} failed={!!step.result?.isError} active={active} />
      </MarkerContent>
    </Marker>
  )
}

function OutlineBash({ message, active }: { message: BashExecutionMessage; active?: boolean }) {
  const failed = message.cancelled || (message.exitCode ?? 0) !== 0
  return (
    <Marker className={statusMarker}>
      <MarkerContent className="flex min-w-0 flex-1">
        <VerbLabel text={`执行 ${message.command}`} failed={failed} active={active && message.exitCode === undefined} />
      </MarkerContent>
    </Marker>
  )
}

function OutlineRow({ row, last, streaming }: { row: WorkRow; last: boolean; streaming: boolean }) {
  if (row.kind === 'thinking') {
    if (last && row.durationMs <= 0) {
      return <OutlineThinking text={row.text} durationMs={0} current streaming={streaming} />
    }
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
          <OutlineTool key={step.id} step={step} active={streaming && i === live.length - 1} />
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
        {current ? <OutlineBash message={current} active={streaming} /> : null}
      </>
    )
  }
  if (row.kind === 'custom') return <CustomProcess message={row.message} />
  if (row.kind === 'summary') return <ProcessDisclosure title={row.title} text={row.text} />
  return null
}

function OutlineBody({ items, active, streaming }: { items: ProcessItem[]; active: boolean; streaming: boolean }) {
  const rows = clusterWork(items)
  return (
    <div className="flex min-w-0 flex-col">
      {rows.map((row, i) => (
        <OutlineRow key={i} row={row} last={active && i === rows.length - 1} streaming={streaming} />
      ))}
    </div>
  )
}

function OutlineGroup({ items, active, streaming }: { items: ProcessItem[]; active: boolean; streaming: boolean }) {
  const tools = countTools(items)
  if (tools === 0) {
    return (
      <>
        {items.map((item, i) => {
          if (item.kind === 'thinking') {
            const live = active && i === items.length - 1 && item.durationMs <= 0
            if (live) {
              return <OutlineThinking key={i} text={item.text} durationMs={0} current stacked streaming={streaming} />
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
      <Marker className={statusMarker}>
        <StackedIcons kinds={iconKinds(items)} />
        <MarkerContent className="flex-1 truncate">正在使用工具</MarkerContent>
      </Marker>
      <Rail>
        <OutlineBody items={items} active={active} streaming={streaming} />
      </Rail>
    </div>
  )
}

export function ProcessOutline({ items, streaming }: { items: ProcessItem[]; streaming: boolean }) {
  const segments = processSegments(items)
  if (segments.length === 0) {
    return (
      <Marker className={statusMarker}>
        <ThinkingOrb state="shaping" size={20} theme="auto" className="shrink-0" />
        <MarkerContent className="flex-1 truncate">
          <WaitLine streaming={streaming} />
        </MarkerContent>
      </Marker>
    )
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {segments.map((segment, i) =>
        segment.kind === 'text' ? (
          <MarkdownText key={i} className="px-1 text-sm" text={segment.text} streaming={streaming} />
        ) : (
          <OutlineGroup key={i} items={segment.items} active={i === segments.length - 1} streaming={streaming} />
        )
      )}
    </div>
  )
}

export function ProcessList({ items }: { items: ProcessItem[] }) {
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
