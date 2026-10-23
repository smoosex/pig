/** Composer toolbar badge for the session's background processes; one button for all of them. */
import { useEffect, useState } from 'react'
import { Activity, ChevronRight, Square, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useT } from '../../hooks/useT'
import { api, type BackgroundProcessInfo, type BackgroundProcessStatus } from '../../ipc/api'
import { formatElapsed } from '../../chat/turns'
import { cn } from '../../lib/utils'
import { useProcessStore, useSessionProcesses } from '../../stores/processes'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

const STATUSES: BackgroundProcessStatus[] = ['running', 'failed', 'exited', 'stopped']
const DOT: Record<BackgroundProcessStatus, string> = {
  running: 'bg-primary motion-safe:animate-pulse',
  exited: 'bg-success',
  failed: 'bg-destructive',
  stopped: 'bg-muted-foreground'
}

/** Re-renders every second while running processes are shown, so their uptime moves. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function ProcessRow({ sessionId, item, now }: { sessionId: string; item: BackgroundProcessInfo; now: number }) {
  const t = useT()
  const [pending, setPending] = useState(false)
  const ended = item.status !== 'running'
  const details = [
    t(`processes.status.${item.status}`),
    formatElapsed((item.endedAt ?? now) - item.startedAt, t),
    ...(ended && item.exitCode !== null ? [t('processes.exitCode', { code: item.exitCode })] : []),
    ...(ended && item.signal ? [t('processes.signal', { signal: item.signal })] : [])
  ].join(' · ')

  const act = async () => {
    setPending(true)
    try {
      await (ended ? api.processes.remove(sessionId, item.id) : api.processes.stop(sessionId, item.id))
    } catch (error) {
      toast.error(t('processes.actionFailed'), { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setPending(false)
    }
  }

  return (
    <Collapsible asChild>
      <li data-process-row={item.id} className="group/process flex flex-col gap-1 rounded-lg px-2 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              aria-label={t('processes.showOutput')}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-[length:var(--focus-ring-width)] focus-visible:ring-focus-ring"
            >
              <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/process:rotate-90 motion-reduce:transition-none" />
              <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', DOT[item.status])} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-xs font-medium" title={item.command}>{item.name ?? item.command}</span>
                <span className="truncate text-xs text-muted-foreground tabular-nums">{item.id} · {details}</span>
              </span>
            </button>
          </CollapsibleTrigger>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={pending}
                aria-label={t(ended ? 'processes.remove' : 'processes.stop')}
                onClick={() => void act()}
              >
                {ended ? <Trash2 aria-hidden="true" /> : <Square aria-hidden="true" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t(ended ? 'processes.remove' : 'processes.stop')}</TooltipContent>
          </Tooltip>
        </div>
        <CollapsibleContent>
          <pre className="max-h-40 overflow-auto rounded-md border border-glass-card-border bg-glass-composer-background/60 p-2 font-mono text-xs whitespace-pre-wrap break-all text-glass-prompt-foreground solid:border-code-border solid:bg-code-background solid:text-code-foreground">
            {item.output.length ? item.output.join('\n') : t('processes.noOutput')}
          </pre>
        </CollapsibleContent>
      </li>
    </Collapsible>
  )
}

export function ProcessStatus({ sessionId }: { sessionId: string | null }) {
  const t = useT()
  const ensure = useProcessStore((state) => state.ensure)
  const items = useSessionProcesses(sessionId)
  const [open, setOpen] = useState(false)
  const running = items.some((item) => item.status === 'running')
  const now = useNow(open && running)

  useEffect(() => {
    if (sessionId) ensure(sessionId)
  }, [ensure, sessionId])

  if (!sessionId || !items.length) return null

  const failed = items.some((item) => item.status === 'failed')
  const statuses = STATUSES
    .map((status) => ({ status, count: items.filter((item) => item.status === status).length }))
    .filter(({ count }) => count > 0)
    .map(({ status, count }) => `${t(`processes.status.${status}`)} x ${count}`)
    .join(' | ')
  const summary = t('processes.summary', { statuses })

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              data-process-status
              data-running={running}
              className="relative rounded-full"
              aria-label={summary}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'pointer-events-none absolute -inset-0.5 rounded-full border',
                  running ? 'animate-spin border-primary border-t-transparent motion-reduce:animate-none' : 'border-border'
                )}
              />
              <Activity aria-hidden="true" />
              {failed ? <span aria-hidden="true" data-process-problem className="pointer-events-none absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-destructive" /> : null}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        {!open ? <TooltipContent side="top" sideOffset={8} className="max-w-none whitespace-nowrap tabular-nums">{summary}</TooltipContent> : null}
      </Tooltip>
      <PopoverContent side="top" align="end" sideOffset={10} className="w-96 gap-1 rounded-2xl p-2">
        <div className="px-2 pt-1 text-xs font-medium text-muted-foreground">{t('processes.title')}</div>
        <ul className="flex max-h-80 flex-col gap-0.5 overflow-y-auto">
          {items.map((item) => <ProcessRow key={item.id} sessionId={sessionId} item={item} now={now} />)}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
