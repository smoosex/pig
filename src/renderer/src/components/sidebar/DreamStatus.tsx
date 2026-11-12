/** App-wide Dream status, beside the material toggle. Uses the same ring/problem-dot grammar
 * as process/subagent status buttons; reopening never creates a new Dream. */
import { Moon } from 'lucide-react'
import { useT } from '../../hooks/useT'
import { cn } from '../../lib/utils'
import { useDreamMonitor, useDreamStore } from '../../stores/dream'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

export function DreamStatusButton() {
  const t = useT()
  useDreamMonitor()
  const status = useDreamStore(state => state.status)
  const loadError = useDreamStore(state => state.loadError)
  const open = useDreamStore(state => state.openDialog)
  if (!status || status.state === 'idle') return null
  const running = status.state === 'running'
  const failed = status.state === 'error' || Boolean(loadError)
  const summary = `${t('dream.title')} · ${t(`dream.${status.state}`)}${running && status.phase ? ` · ${t(`dream.${status.phase}`)}` : ''}`
  return <Tooltip>
    <TooltipTrigger asChild>
      <Button variant="outline" size="icon-xs" data-dream-status data-running={running}
        className="relative mx-1 rounded-full" aria-label={summary} onClick={() => open()}>
        <span aria-hidden="true" className={cn('pointer-events-none absolute -inset-px rounded-full border',
          running ? 'animate-spin border-primary border-t-transparent motion-reduce:animate-none' : 'border-border')} />
        <Moon aria-hidden="true" />
        {failed ? <span aria-hidden="true" data-dream-problem className="pointer-events-none absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-destructive" /> : null}
      </Button>
    </TooltipTrigger>
    <TooltipContent side="top">{summary}</TooltipContent>
  </Tooltip>
}
