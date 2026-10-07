/**
 * Completed work stays collapsed until requested. The live outline renders the
 * same Pi process items while keeping unfinished work visible.
 */
import { useEffect, useState } from 'react'
import type { MessageKey } from '../../../../shared/i18n'
import { ThinkingOrb } from 'thinking-orbs'
import type { BashExecutionMessage } from '../../pi/types'
import type { ProcessItem } from '../../chat/turns'
import { useT } from '../../hooks/useT'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { Marker, MarkerContent } from '../ui/marker'
import { MarkdownText } from '../MarkdownText'
import { Chevron, disclosureButton, Rail, StackedIcons, statusMarker, VerbLabel } from './ProcessChrome'
import { clusterWork, countTools, iconKinds, processSegments, type WorkRow } from './process-model'
import { BashCluster, BashRow, ToolCluster, ToolRow } from './ToolDetails'
import { CustomProcess, ProcessDisclosure, ThinkingRow } from './ProcessText'

function GroupBody({ items }: { items: ProcessItem[] }) {
  const t = useT()
  return (
    <div className="flex min-w-0 flex-col">
      {clusterWork(items).map((row, i) => {
        if (row.kind === 'thinking') {
          return <ThinkingRow key={i} text={row.text} durationMs={row.durationMs} />
        }
        if (row.kind === 'tools') return <ToolCluster key={row.steps[0].id} steps={row.steps} />
        if (row.kind === 'bash') return <BashCluster key={i} messages={row.messages} />
        if (row.kind === 'custom') return <CustomProcess key={i} message={row.message} />
        if (row.kind === 'summary')
          return <ProcessDisclosure key={i} title={t(row.titleKey)} text={row.text} />
        return null
      })}
    </div>
  )
}

function ActivityGroup({ items }: { items: ProcessItem[] }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const tools = countTools(items)
  if (tools === 0) {
    return (
      <>
        {items.map((item, i) => {
          if (item.kind === 'thinking') {
            return <ThinkingRow key={i} text={item.text} durationMs={item.durationMs} stacked />
          }
          if (item.kind === 'custom') return <CustomProcess key={i} message={item.message} />
          if (item.kind === 'summary')
            return <ProcessDisclosure key={i} title={t(item.titleKey)} text={item.text} />
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
          <span className="min-w-0 flex-1 truncate text-left">
            {t('turn.toolsUsed', { count: tools })}
          </span>
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

const WAIT_LINE_KEYS: MessageKey[] = [
  'turn.placeholder1',
  'turn.placeholder2',
  'turn.placeholder3',
  'turn.placeholder4',
  'turn.placeholder5',
  'turn.placeholder6'
]

function WaitLine({ streaming }: { streaming: boolean }) {
  const t = useT()
  const [index, setIndex] = useState(0)
  useEffect(() => {
    if (!streaming) return
    const id = window.setInterval(() => {
      setIndex((current) => {
        if (WAIT_LINE_KEYS.length < 2) return current
        let next = current
        while (next === current) next = Math.floor(Math.random() * WAIT_LINE_KEYS.length)
        return next
      })
    }, 2800)
    return () => window.clearInterval(id)
  }, [streaming])
  return (
    <span className={cn(streaming && 'shimmer')}>
      {t(WAIT_LINE_KEYS[index] ?? WAIT_LINE_KEYS[0])}
    </span>
  )
}

function OutlineBash({ message, active }: { message: BashExecutionMessage; active?: boolean }) {
  const t = useT()
  const failed = message.cancelled || (message.exitCode ?? 0) !== 0
  return (
    <Marker className={statusMarker}>
      <MarkerContent className="flex min-w-0 flex-1">
        <VerbLabel
          text={t('tool.run', { command: message.command })}
          failed={failed}
          active={active && message.exitCode === undefined}
        />
      </MarkerContent>
    </Marker>
  )
}

function OutlineRow({ row, last, streaming }: { row: WorkRow; last: boolean; streaming: boolean }) {
  const t = useT()
  if (row.kind === 'thinking') {
    if (last && streaming && row.live) {
      return <ThinkingRow text={row.text} live streaming={streaming} />
    }
    return <ThinkingRow text={row.text} durationMs={row.durationMs} />
  }
  if (row.kind === 'tools') {
    const current = row.steps.findLastIndex((step) => !step.result)
    return (
      <>
        {row.steps.map((step, i) => (
          <ToolRow key={step.id} step={step} active={last && streaming && i === current} />
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
  if (row.kind === 'summary') return <ProcessDisclosure title={t(row.titleKey)} text={row.text} />
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
  const t = useT()
  const tools = countTools(items)
  if (tools === 0) {
    return (
      <>
        {items.map((item, i) => {
          if (item.kind === 'thinking') {
            const live = streaming && active && i === items.length - 1 && item.live
            if (live) {
              return <ThinkingRow key={i} text={item.text} live stacked streaming={streaming} />
            }
            return <ThinkingRow key={i} text={item.text} durationMs={item.durationMs} stacked />
          }
          if (item.kind === 'custom') return <CustomProcess key={i} message={item.message} />
          if (item.kind === 'summary')
            return <ProcessDisclosure key={i} title={t(item.titleKey)} text={item.text} />
          return null
        })}
      </>
    )
  }
  return (
    <div className="min-w-0">
      <Marker className={statusMarker}>
        <StackedIcons kinds={iconKinds(items)} />
        <MarkerContent className="flex-1 truncate">{t('turn.usingTool')}</MarkerContent>
      </Marker>
      <Rail>
        <OutlineBody items={items} active={active} streaming={streaming} />
      </Rail>
    </div>
  )
}

export function ProcessOutline({ items, streaming, waitingForModel }: {
  items: ProcessItem[]
  streaming: boolean
  waitingForModel: boolean
}) {
  const segments = processSegments(items)
  if (segments.length === 0) {
    return streaming && waitingForModel ? (
      <Marker className={statusMarker}>
        <ThinkingOrb state="working" size={20} theme="auto" className="shrink-0" />
        <MarkerContent className="flex-1 truncate">
          <WaitLine streaming={streaming} />
        </MarkerContent>
      </Marker>
    ) : null
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
      {streaming && waitingForModel ? (
        <Marker className={statusMarker}>
          <ThinkingOrb state="working" size={20} theme="auto" className="shrink-0" />
        </Marker>
      ) : null}
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
