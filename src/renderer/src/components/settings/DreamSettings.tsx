/** Shared Dream entry and dialog. Compose, running and result views stay distinct; only the
 * body scrolls, leaving closing/stopping actions available throughout a background run. */
import { ChartNoAxesColumn, CircleAlert, FileText, Moon, Square, Target } from 'lucide-react'
import { dreamTokens, type DreamStatus } from '../../../../shared/dream'
import { useT } from '../../hooks/useT'
import { cn, hideScroll } from '../../lib/utils'
import { useDreamMonitor, useDreamStore } from '../../stores/dream'
import { MarkdownText } from '../MarkdownText'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Textarea } from '../ui/textarea'
import { Field, FieldGroup, FieldLabel, FieldDescription } from '../ui/field'
import { Separator } from '../ui/separator'
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from '../ui/popover'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { SettingsRow } from './SettingsFields'

export function DreamSettings({ enabled }: { enabled: boolean }) {
  const t = useT()
  const openDialog = useDreamStore(state => state.openDialog)
  return <SettingsRow title={t('dream.title')} description={t('dream.description')}>
    <Button variant="outline" size="sm" disabled={!enabled} onClick={() => openDialog(enabled)}>{t('dream.open')}</Button>
  </SettingsRow>
}

export function DreamDialogHost() {
  const open = useDreamStore(state => state.open)
  const enabled = useDreamStore(state => state.enabled)
  const close = useDreamStore(state => state.closeDialog)
  return open ? <DreamDialog enabled={enabled === true} onClose={close} /> : null
}

function DreamUsage({ status }: { status: DreamStatus }) {
  const t = useT()
  const metrics = [
    { key: 'tokensLabel', value: dreamTokens(status).toLocaleString() },
    { key: 'requestsLabel', value: status.requests.toLocaleString() },
    { key: 'costLabel', value: status.costKnown && status.requests > 0 ? `$${status.cost.toFixed(4)}` : t('dream.costUnknown') },
    ...(['input', 'output', 'cacheRead', 'cacheWrite'] as const).map(key => ({ key: `${key}Label` as const, value: status[key].toLocaleString() }))
  ] as const
  return <dl className="grid gap-2 text-xs tabular-nums" data-dream-usage>
    {metrics.map(metric => <div key={metric.key}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3 py-1"
      title={metric.key === 'costLabel' ? t('dream.costHint') : undefined}>
      <dt className="text-muted-foreground">{t(`dream.${metric.key}`)}</dt>
      <dd className="text-right text-sm font-medium">{metric.value}</dd>
    </div>)}
  </dl>
}

function DreamStatistics({ status }: { status: DreamStatus }) {
  const t = useT()
  return <Popover>
    <PopoverTrigger asChild>
      <Button variant="ghost" size="icon-sm" className="absolute top-4 right-12" aria-label={t('dream.statistics')} title={t('dream.statistics')}>
        <ChartNoAxesColumn />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="end" className={cn('max-h-80 w-80 overflow-y-auto', hideScroll)} aria-label={t('dream.statistics')}>
      <PopoverHeader><PopoverTitle>{t('dream.statistics')}</PopoverTitle></PopoverHeader>
      <DreamUsage status={status} />
    </PopoverContent>
  </Popover>
}

function DreamChanges({ paths }: { paths: string[] }) {
  const t = useT()
  return <section className="flex flex-col gap-2" aria-label={t('dream.changed')}>
    <h3 className="text-xs font-medium text-muted-foreground">{t('dream.changed')} · {paths.length}</h3>
    <ul className="flex flex-col gap-2" data-dream-changes>
      {paths.map(path => {
        const parts = path.split('/')
        const global = parts[0] === 'global'
        const name = parts.slice(global ? 1 : 2).join('/')
        return <li key={path} title={path} className="flex min-w-0 items-center gap-2.5">
          <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0"><p className="truncate text-sm">{name}</p>
            <p className="text-xs text-muted-foreground">{t(global ? 'dream.globalMemory' : 'dream.projectMemory')}{global ? '' : ` · ${parts[1]?.slice(0, 8)}`}</p>
          </div>
        </li>
      })}
    </ul>
  </section>
}

export function DreamDialog({ enabled, onClose }: { enabled: boolean; onClose: () => void }) {
  const t = useT()
  useDreamMonitor()
  const { status, loadError, actionError, busy, compose, draft, setDraft, start, stop, newTopic } = useDreamStore()
  const running = status?.state === 'running'
  const composing = !running && (compose || !status || status.state === 'idle')
  const error = actionError ?? loadError
  return <Dialog open onOpenChange={value => { if (!value) onClose() }}>
    <DialogContent className="flex max-h-4/5 flex-col overflow-hidden sm:max-w-2xl">
      <DialogHeader className="shrink-0 pr-16">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <DialogTitle className="gap-2.5">
            <span aria-hidden="true" className="relative flex size-4 shrink-0 items-center justify-center" data-dream-title-icon>
              {running ? <span className="absolute -inset-1 animate-spin rounded-full border border-primary border-t-transparent motion-reduce:animate-none" data-dream-title-spinner /> : null}
              <Moon className="size-4" />
            </span>
            {t('dream.title')}
          </DialogTitle>
          {!composing && status && status.state !== 'idle' ? <div className="flex items-center gap-2" aria-live="polite" data-dream-heading-status>
            <Badge variant={status.state === 'error' ? 'destructive' : 'secondary'}>{t(`dream.${status.state}`)}</Badge>
            {running && status.phase ? <span className="text-xs text-muted-foreground">{t(`dream.${status.phase}`)}</span> : null}
          </div> : null}
        </div>
        <DialogDescription className="sr-only">{t('dream.dialogHint')}</DialogDescription>
      </DialogHeader>
      {!composing && status && status.state !== 'idle' ? <DreamStatistics status={status} /> : null}
      <div className={cn('flex min-h-0 flex-col gap-4 overflow-y-auto', hideScroll)} data-dream-body>
        {error ? <Alert variant="destructive"><CircleAlert /><AlertTitle>{t('dream.actionFailed')}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
        {composing ? <FieldGroup>
          <Field>
            <FieldLabel htmlFor="dream-topic">{t('dream.topic')}</FieldLabel>
            <Textarea id="dream-topic" value={draft} maxLength={2000} disabled={busy} placeholder={t('dream.topicPlaceholder')}
              className={cn('max-h-40 min-h-24 resize-none', hideScroll)} onChange={event => setDraft(event.target.value)} />
            <FieldDescription>{t('dream.topicHint')}</FieldDescription>
          </Field>
          <FieldDescription>{t('dream.budgetHint')}</FieldDescription>
        </FieldGroup> : status && status.state !== 'idle' ? <>
          <Alert className="items-center gap-y-0" data-dream-topic><Target className="row-span-1! translate-y-0!" /><AlertTitle className="break-words whitespace-pre-wrap">{status.topic}</AlertTitle></Alert>
          {running ? <Alert role="status"><Moon /><AlertTitle>{t('dream.backgroundTitle')}</AlertTitle><AlertDescription>{t('dream.backgroundHint')}</AlertDescription></Alert> : null}
          {running && status.wrappingUp ? <Alert role="status"><Moon /><AlertTitle>{t('dream.wrappingUp')}</AlertTitle><AlertDescription>{t('dream.wrapUpHint')}</AlertDescription></Alert> : null}
          {status.error ? <Alert variant={status.budgetStop ? 'default' : 'destructive'}><CircleAlert /><AlertTitle>{status.budgetStop ? t(status.budgetStop.kind === 'tokens' ? 'dream.tokenLimitReached' : 'dream.costLimitReached', { used: status.budgetStop.used.toLocaleString(), limit: status.budgetStop.limit.toLocaleString() }) : status.error}</AlertTitle><AlertDescription>{t('dream.failureHint')}</AlertDescription></Alert> : null}
          {status.report ? <><Separator /><section aria-label={t('dream.report')} className="flex flex-col gap-3">
            <h3 className="text-xs font-medium text-muted-foreground">{t('dream.report')}</h3>
            <MarkdownText text={status.report} className="text-sm leading-relaxed" />
          </section></> : !running && !status.error ? <p className="text-sm text-muted-foreground">{t(status.state === 'cancelled' ? 'dream.cancelledHint' : 'dream.noReport')}</p> : null}
          {!running ? <><Separator />{status.changes.length ? <DreamChanges paths={status.changes} /> : <p className="text-xs text-muted-foreground">{t('dream.noChanges')}</p>}</> : null}
        </> : null}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t(running ? 'dream.closeRunning' : 'dream.close')}</Button>
        {running ? <Button variant="destructive" disabled={busy} onClick={() => void stop()}><Square data-icon="inline-start" />{t('dream.stop')}</Button> : null}
        {!composing && !running ? <Button disabled={!enabled || busy} onClick={newTopic}>{t('dream.newTopic')}</Button> : null}
        {composing ? <Button disabled={busy || !status || !enabled || !draft.trim()} onClick={() => void start()}>{t('dream.start')}</Button> : null}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
