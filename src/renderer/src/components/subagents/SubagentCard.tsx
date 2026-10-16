/**
 * The floating subagent card: a switcher over the session's subagents and a read-only summary of
 * the selected one. Users can only watch and stop; nothing they do here reaches a child's context.
 */
import { ArrowUpRight, ChevronDown, CircleCheck, LoaderCircle, Square, Users, X } from 'lucide-react'
import { toast } from 'sonner'
import type { SubagentInfo } from '../../ipc/api'
import { api } from '../../ipc/api'
import { formatElapsed } from '../../chat/turns'
import { useT } from '../../hooks/useT'
import { cn, hideScroll } from '../../lib/utils'
import { isSubagentActive, isSubagentProblem, subagentColor, useSubagentStore } from '../../stores/subagents'
import { MarkdownText } from '../MarkdownText'
import { StackedIcons } from '../turn/ProcessChrome'
import { stackKindForTool, toolUsageSummary, type IconKind } from '../turn/process-model'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { SubagentAvatar, SubagentMeta, subagentElapsed, useNow } from './subagent-view'

const MAX_CELLS = 60

function reportFailure(error: unknown): void {
  toast.error(error instanceof Error ? error.message : String(error))
}

/** Turns covered by one cell: 1:1 up to MAX_CELLS, otherwise each cell spans a contiguous range. */
function cellTurns(index: number, perCell: number): [number, number] {
  const from = Math.floor(index * perCell)
  return [from, Math.max(from, Math.floor((index + 1) * perCell) - 1)]
}

/** One line, like a process group header: stacked icons of what the turns did and how many tools they used. */
function CellSummary({ item, from, to }: { item: SubagentInfo; from: number; to: number }) {
  const t = useT()
  const turns = item.turnTools.slice(from, Math.min(to, item.turns - 1) + 1)
  const tools = turns.flatMap((turn) => turn.tools)
  const kinds: IconKind[] = [...new Set<IconKind>([
    ...(turns.some((turn) => turn.thinking) ? ['thinking' as const] : []),
    ...tools.map(stackKindForTool)
  ])]
  return (
    <>
      {kinds.length ? <span className="text-foreground"><StackedIcons kinds={kinds} /></span> : null}
      <span className="min-w-0 truncate">{tools.length ? toolUsageSummary(tools) : t('subagents.noTools')}</span>
    </>
  )
}

function Timeline({ item }: { item: SubagentInfo }) {
  const running = item.status === 'running'
  const limit = item.maxTurns > 0 ? item.maxTurns : Math.max(item.turns, 1)
  const cells = Math.min(limit, MAX_CELLS)
  const perCell = limit / cells
  const lit = Math.min(cells, Math.ceil(item.turns / perCell))
  return (
    <div className="flex h-6 items-center gap-0.5">
      {Array.from({ length: cells }, (_, index) => {
        const current = running && index === lit - 1
        const className = cn(
          'h-4 min-w-px flex-1 rounded-full bg-muted transition-[height,background-color] duration-200',
          index < lit && cn(subagentColor(item.id), 'opacity-60'),
          current && 'h-6 opacity-100'
        )
        if (index >= lit) return <span key={index} aria-hidden="true" className={className} />
        const [from, to] = cellTurns(index, perCell)
        return (
          <Tooltip key={index}>
            <TooltipTrigger asChild>
              <span className={cn(className, 'hover:opacity-100')} />
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-80">
              <CellSummary item={item} from={from} to={to} />
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

function toolSummary(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${n} ${name}`)
    .join(' · ')
}

function Body({ item }: { item: SubagentInfo }) {
  const t = useT()
  const turnLabel = item.maxTurns > 0
    ? t('subagents.turnsOf', { n: item.turns, max: item.maxTurns })
    : t('subagents.turns', { n: item.turns })
  const stats = toolSummary(item.toolCounts)
  return (
    <div className="flex min-h-0 flex-col gap-3 px-4 pt-2 pb-4">
      <p className="text-center text-sm font-medium text-balance">{item.title}</p>
      <Timeline item={item} />
      <p className="truncate text-center text-xs text-muted-foreground">{[turnLabel, stats].filter(Boolean).join(' · ')}</p>
      {item.fallbackReason && item.model ? (
        <p className="text-xs text-warning">
          {t('subagents.fallback', { reason: item.fallbackReason, model: `${item.model.provider}/${item.model.id}` })}
        </p>
      ) : null}
      {item.status === 'queued' ? (
        <p className="text-center text-xs text-muted-foreground">{t('subagents.waiting')}</p>
      ) : item.status === 'running' ? (
        <p className="flex min-w-0 items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <LoaderCircle aria-hidden="true" className="size-3 shrink-0 animate-spin" />
          <span className="truncate font-mono">{item.activity ?? t('subagents.starting')}</span>
        </p>
      ) : null}
      {item.error ? <p className="text-xs break-words whitespace-pre-wrap text-destructive">{item.error}</p> : null}
      {!isSubagentActive(item) ? (
        item.output?.trim() ? (
          <div className={cn('max-h-64 overflow-y-auto rounded-lg border border-border px-3 py-2 text-sm', hideScroll)}>
            <MarkdownText text={item.output} />
          </div>
        ) : (
          <p className="text-center text-xs text-muted-foreground">{t('subagents.noOutput')}</p>
        )
      ) : null}
    </div>
  )
}

export function SubagentCard({ sessionId, items, selected }: {
  sessionId: string
  items: SubagentInfo[]
  selected: SubagentInfo
}) {
  const t = useT()
  const openCard = useSubagentStore((state) => state.openCard)
  const closeCard = useSubagentStore((state) => state.closeCard)
  const openTranscript = useSubagentStore((state) => state.openTranscript)
  const visible = items.filter((item) => !item.cleared || item.id === selected.id)
  const anyActive = visible.some(isSubagentActive)
  const anyFinished = visible.some((item) => !isSubagentActive(item))
  const now = useNow(anyActive)
  const active = isSubagentActive(selected)

  return (
    <div className="flex max-h-[min(36rem,calc(100dvh-10rem))] min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 p-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="shrink-0 rounded-full" aria-label={t('subagents.switch')}>
              <Users aria-hidden="true" />
              {visible.length}
              <ChevronDown aria-hidden="true" className="text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-80">
            <DropdownMenuLabel className="text-xs text-muted-foreground">{t('subagents.title')}</DropdownMenuLabel>
            {visible.map((item) => (
              <DropdownMenuItem
                key={item.id}
                className={cn('items-start gap-2.5', item.id === selected.id && 'bg-accent/60')}
                onSelect={() => openCard(sessionId, item.id)}
              >
                <SubagentAvatar item={item} className="mt-0.5" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{item.title}</span>
                  <SubagentMeta item={item} now={now} />
                </span>
              </DropdownMenuItem>
            ))}
            {anyFinished || anyActive ? <DropdownMenuSeparator /> : null}
            {anyFinished ? (
              <DropdownMenuItem onSelect={() => void api.clearFinishedSubagents(sessionId).catch(reportFailure)}>
                <CircleCheck aria-hidden="true" />
                {t('subagents.clearFinished')}
              </DropdownMenuItem>
            ) : null}
            {anyActive ? (
              <DropdownMenuItem variant="destructive" onSelect={() => void api.abortAllSubagents(sessionId).catch(reportFailure)}>
                <Square aria-hidden="true" />
                {t('subagents.stopAll')}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-full border border-border px-1.5">
          <SubagentAvatar item={selected} className="size-5" />
          <span className="truncate text-sm font-medium">{selected.title}</span>
          <span className={cn('shrink-0 text-xs text-muted-foreground', isSubagentProblem(selected) && 'text-destructive')}>
            {t(`subagents.status.${selected.status}`)}
          </span>
          {selected.startedAt !== undefined ? (
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatElapsed(subagentElapsed(selected, now), t)}</span>
          ) : null}
        </div>
        {active ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="rounded-full"
            aria-label={t('subagents.stop')}
            title={t('subagents.stop')}
            onClick={() => void api.abortSubagent(sessionId, selected.id).catch(reportFailure)}
          >
            <Square aria-hidden="true" className="fill-current" />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="rounded-full"
          aria-label={t('subagents.expand')}
          title={t('subagents.expand')}
          onClick={() => openTranscript(sessionId, selected.id)}
        >
          <ArrowUpRight aria-hidden="true" />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" className="rounded-full" aria-label={t('subagents.close')} onClick={closeCard}>
          <X aria-hidden="true" />
        </Button>
      </div>
      <div className={cn('min-h-0 overflow-y-auto', hideScroll)}>
        <Body item={selected} />
      </div>
    </div>
  )
}
