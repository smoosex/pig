/** Status-line badge for the session's subagents; it anchors the floating subagent card. */
import { useEffect } from 'react'
import { CircleAlert, CircleCheck, LoaderCircle } from 'lucide-react'
import { useT } from '../../hooks/useT'
import { cn } from '../../lib/utils'
import { isSubagentActive, isSubagentProblem, useSessionSubagents, useSubagentStore } from '../../stores/subagents'
import { SubagentCard } from '../subagents/SubagentCard'
import { Button } from '../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

export function SubagentStatus({ sessionId }: { sessionId: string | null }) {
  const t = useT()
  const ensure = useSubagentStore((state) => state.ensure)
  const card = useSubagentStore((state) => (sessionId && state.card?.sessionId === sessionId ? state.card : null))
  const openCard = useSubagentStore((state) => state.openCard)
  const closeCard = useSubagentStore((state) => state.closeCard)
  const items = useSessionSubagents(sessionId)

  useEffect(() => {
    if (sessionId) ensure(sessionId)
  }, [ensure, sessionId])

  const listed = items.filter((item) => !item.cleared)
  const selected = card ? items.find((item) => item.id === card.id) : undefined
  if (!sessionId || (!listed.length && !selected)) return null

  const running = listed.filter((item) => item.status === 'running').length
  const queued = listed.filter((item) => item.status === 'queued').length
  const problems = listed.filter(isSubagentProblem).length
  const done = listed.length - running - queued - problems
  const parts = [
    running ? t('subagents.running', { n: running }) : '',
    queued ? t('subagents.queued', { n: queued }) : '',
    done ? t('subagents.completed', { n: done }) : '',
    problems ? t('subagents.failed', { n: problems }) : ''
  ].filter(Boolean)
  const Icon = running || queued ? LoaderCircle : problems ? CircleAlert : CircleCheck
  const fallback = listed.find(isSubagentActive) ?? listed.at(-1)

  return (
    <Popover
      open={!!selected}
      onOpenChange={(open) => {
        if (!open) closeCard()
        else if (fallback) openCard(sessionId, fallback.id)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          data-subagent-status
          className={cn('ml-auto h-6 shrink-0 gap-1.5 rounded-full px-2 text-xs font-normal text-muted-foreground', problems && 'text-destructive')}
          aria-label={t('subagents.title')}
        >
          <Icon aria-hidden="true" className={cn('size-3', (running || queued) && 'animate-spin')} />
          {parts.join(' · ')}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={10} className="w-md gap-0 rounded-2xl p-0">
        {selected ? <SubagentCard sessionId={sessionId} items={items} selected={selected} /> : null}
      </PopoverContent>
    </Popover>
  )
}
