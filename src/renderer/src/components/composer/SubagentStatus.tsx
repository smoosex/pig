/** Status-line badge for the session's subagents; it anchors the floating subagent card. */
import { useEffect } from 'react'
import { BrainCircuit } from 'lucide-react'
import { useT } from '../../hooks/useT'
import { cn } from '../../lib/utils'
import { isSubagentActive, isSubagentProblem, useSessionSubagents, useSubagentStore } from '../../stores/subagents'
import { SubagentCard } from '../subagents/SubagentCard'
import { Button } from '../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

export function SubagentStatus({ sessionId }: { sessionId: string | null }) {
  const t = useT()
  const ensure = useSubagentStore((state) => state.ensure)
  const card = useSubagentStore((state) => (sessionId && state.card?.sessionId === sessionId ? state.card : null))
  const openCard = useSubagentStore((state) => state.openCard)
  const closeCard = useSubagentStore((state) => state.closeCard)
  const clearing = useSubagentStore((state) => state.clearing?.sessionId === sessionId ? state.clearing : null)
  const items = useSessionSubagents(sessionId)

  useEffect(() => {
    if (sessionId) ensure(sessionId)
  }, [ensure, sessionId])

  const listed = items.filter((item) => !item.cleared || isSubagentActive(item))
  const selected = card ? items.find((item) => item.id === card.id && (!item.cleared || isSubagentActive(item) || clearing)) : undefined
  if (!sessionId || (!listed.length && !selected)) return null

  const running = listed.some((item) => item.status === 'running')
  const problems = listed.some(isSubagentProblem)
  const counts = (['running', 'queued', 'completed', 'failed', 'timeout', 'turn_limit', 'aborted', 'interrupted'] as const)
    .map((status) => ({ status, count: listed.filter((item) => item.status === status).length }))
    .filter(({ count }) => count > 0)
  const statuses = counts.map(({ status, count }) => `${status === 'running' ? t('subagents.summaryWorking') : t(`subagents.status.${status}`)} x ${count}`).join(' | ')
  const summary = t('subagents.statusSummary', { statuses: statuses || t('subagents.clearedAll') })
  const fallback = listed.find(isSubagentActive) ?? listed.at(-1)

  return (
    <Popover
      open={!!selected}
      onOpenChange={(open) => {
        if (!open) closeCard()
        else if (fallback) openCard(sessionId, fallback.id)
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              data-subagent-status
              className="relative ml-auto rounded-full"
              aria-label={summary}
            >
              <span
                aria-hidden="true"
                data-subagent-ring
                data-running={running}
                className={cn(
                  'pointer-events-none absolute -inset-0.5 rounded-full border',
                  running ? 'animate-spin border-primary border-t-transparent motion-reduce:animate-none' : 'border-border'
                )}
              />
              <BrainCircuit aria-hidden="true" />
              {problems ? <span aria-hidden="true" data-subagent-problem className="pointer-events-none absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-destructive" /> : null}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        {!selected ? <TooltipContent side="top" sideOffset={8} className="max-w-none whitespace-nowrap tabular-nums">
          {summary}
        </TooltipContent> : null}
      </Tooltip>
      <PopoverContent side="top" align="end" sideOffset={10} className="w-md gap-0 rounded-2xl p-0">
        {selected ? <SubagentCard sessionId={sessionId} items={items} selected={selected} /> : null}
      </PopoverContent>
    </Popover>
  )
}
