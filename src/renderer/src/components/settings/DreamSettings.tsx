/** Shared Dream entry and dialog. Compose, running and result views stay distinct; only the
 * body scrolls, leaving closing/stopping actions available throughout a background run. */
import { ArrowLeft, ChartNoAxesColumn, CircleAlert, FileText, Moon, Square, Stethoscope, Target } from 'lucide-react'
import { dreamTokens, type DreamAuditScope, type DreamRecord, type DreamStatus } from '../../../../shared/dream'
import type { Translate } from '../../../../shared/i18n'
import { useT } from '../../hooks/useT'
import { cn, hideScroll } from '../../lib/utils'
import { useDreamMonitor, useDreamStore } from '../../stores/dream'
import { MarkdownText } from '../MarkdownText'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Textarea } from '../ui/textarea'
import { Field, FieldGroup, FieldLabel, FieldDescription } from '../ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '../ui/select'
import { Separator } from '../ui/separator'
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from '../ui/popover'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { SettingsRow } from './SettingsFields'
import { DreamHistoryDialog } from './DreamHistory'

export function describeAuditScope(t: Translate, scope?: DreamAuditScope, projectName?: string): string {
  if (!scope || scope.kind === 'all') return t('dream.auditScopeAll')
  if (scope.kind === 'global') return t('dream.auditScopeGlobal')
  const label = projectName ? `${projectName} (${scope.projectId.slice(0, 8)})` : scope.projectId.slice(0, 8)
  return t('dream.auditScopeProject', { name: label })
}

export function DreamSettings({ enabled }: { enabled: boolean }) {
  const t = useT()
  const openDialog = useDreamStore(state => state.openHistory)
  return <SettingsRow title={t('dream.title')} description={t('dream.description')}>
    <Button variant="outline" size="sm" onClick={() => openDialog(enabled)}>{t('dream.open')}</Button>
  </SettingsRow>
}

export function DreamAuditSettings({ enabled }: { enabled: boolean }) {
  const t = useT()
  const openAudit = useDreamStore(state => state.openAudit)
  return <SettingsRow title={t('dream.auditTitle')} description={t('dream.auditDescription')}>
    <Button variant="outline" size="sm" onClick={() => openAudit(enabled)}>{t('dream.auditOpen')}</Button>
  </SettingsRow>
}

export function DreamDialogHost() {
  const open = useDreamStore(state => state.open)
  const enabled = useDreamStore(state => state.enabled)
  const close = useDreamStore(state => state.closeDialog)
  const view = useDreamStore(state => state.view)
  return open ? (view === 'history' ? <DreamHistoryDialog enabled={enabled === true} onClose={close} /> : <DreamDialog enabled={enabled === true} onClose={close} />) : null
}

function DreamUsage({ status }: { status: DreamStatus | DreamRecord }) {
  const t = useT()
  const incomplete = 'usageIncomplete' in status && status.usageIncomplete
  const metrics = [
    { key: 'tokensLabel', value: incomplete ? t('dream.costUnknown') : dreamTokens(status).toLocaleString() },
    { key: 'requestsLabel', value: status.requests.toLocaleString() },
    { key: 'costLabel', value: status.costKnown && status.requests > 0 ? `$${status.cost.toFixed(4)}` : t('dream.costUnknown') },
    ...(['input', 'output', 'cacheRead', 'cacheWrite'] as const).map(key => ({ key: `${key}Label` as const, value: incomplete && key !== 'output' ? t('dream.costUnknown') : status[key].toLocaleString() }))
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

function DreamStatistics({ status }: { status: DreamStatus | DreamRecord }) {
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
      {'usageIncomplete' in status && status.usageIncomplete ? <p className="text-xs text-muted-foreground">{t('dream.usageIncomplete')}</p> : null}
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
        const scoped = global || /^projects\/[a-f0-9]{64}\//.test(path)
        const name = scoped ? parts.slice(global ? 1 : 2).join('/') : path
        return <li key={path} title={path} className="flex min-w-0 items-center gap-2.5">
          <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0"><p className="truncate text-sm">{name}</p>
            <p className="text-xs text-muted-foreground">{scoped ? t(global ? 'dream.globalMemory' : 'dream.projectMemory') : t('longTerm.misplaced')}{scoped && !global ? ` · ${parts[1]?.slice(0, 8)}` : ''}</p>
          </div>
        </li>
      })}
    </ul>
  </section>
}

export function DreamDialog({ enabled, onClose }: { enabled: boolean; onClose: () => void }) {
  const t = useT()
  useDreamMonitor()
  const {
    status: liveStatus, recordId, record, recordError, loadError, actionError, busy,
    compose, composeMode, auditScope, auditProjects, auditProjectsBusy, auditProjectsError,
    draft, setDraft, setAuditScope, start, startAudit, stop, newTopic, newAudit, openHistory
  } = useDreamStore()
  const status = recordId ? record : liveStatus
  const running = !recordId && status?.state === 'running'
  const composing = !recordId && !running && (compose || !status || status.state === 'idle')
  const isAuditCompose = composing && composeMode === 'audit'
  const isAuditView = isAuditCompose || (!composing && Boolean(status?.audit))
  const error = recordId ? recordError : actionError ?? loadError
  const stopped = status?.state === 'cancelled' && (!status.error || status.error === 'DREAM_CANCELLED')
  const scopeSelectValue = auditScope.kind === 'project' ? `project:${auditScope.projectId}` : auditScope.kind
  const auditScopeObj = status?.auditScope
  const selectedAuditProjectName = status?.auditProjectName
    ?? (auditScopeObj?.kind === 'project' ? auditProjects.find(item => item.id === auditScopeObj.projectId)?.name : undefined)
  const headingTitle = status?.repair && !composing
    ? t('longTerm.repair')
    : isAuditView
      ? t('dream.auditTitle')
      : t('dream.title')
  return <Dialog open onOpenChange={value => { if (!value) onClose() }}>
    <DialogContent className="flex max-h-4/5 flex-col overflow-hidden sm:max-w-2xl"
      onEscapeKeyDown={event => { if (status?.repair && !composing) event.preventDefault() }}
      onInteractOutside={event => { if (status?.repair && !composing) event.preventDefault() }}>
      <DialogHeader className={cn('shrink-0', running && status?.repair ? 'pr-24' : 'pr-16')}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {recordId ? <Button variant="ghost" size="icon-sm" aria-label={t('dream.back')} onClick={() => openHistory(enabled)}><ArrowLeft /></Button> : null}
          <DialogTitle className="gap-2.5">
            <span aria-hidden="true" className="relative flex size-4 shrink-0 items-center justify-center" data-dream-title-icon>
              {running ? <span className="absolute -inset-1 animate-spin rounded-full border border-primary border-t-transparent motion-reduce:animate-none" data-dream-title-spinner /> : null}
              <Moon className="size-4" />
            </span>
            {headingTitle}
          </DialogTitle>
          {!composing && status && status.state !== 'idle' ? <div className="flex items-center gap-2" aria-live="polite" data-dream-heading-status>
            <Badge variant={status.state === 'error' ? 'destructive' : 'secondary'}>{t(`dream.${status.state}`)}</Badge>
            {running && status.phase ? <span className="text-xs text-muted-foreground">{t(`dream.${status.phase}`)}</span> : null}
          </div> : null}
        </div>
        <DialogDescription className="sr-only">{t('dream.dialogHint')}</DialogDescription>
      </DialogHeader>
      {!composing && status && status.state !== 'idle' ? <DreamStatistics status={status} /> : null}
      {running && status?.repair ? <Button variant="ghost" size="icon-sm" className="absolute top-4 right-20" disabled={busy} aria-label={t('dream.stop')} title={t('dream.stop')} onClick={() => void stop()}><Square /></Button> : null}
      <div className={cn('flex min-h-0 flex-col gap-4 overflow-y-auto', hideScroll)} data-dream-body>
        {recordId && !record && !recordError ? <p className="text-sm text-muted-foreground">{t('dream.historyLoading')}</p> : null}
        {error ? <Alert variant="destructive"><CircleAlert /><AlertTitle>{t('dream.actionFailed')}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
        {isAuditCompose ? <FieldGroup>
          <Field>
            <FieldLabel htmlFor="dream-audit-scope">{t('dream.auditScopeLabel')}</FieldLabel>
            <Select
              disabled={busy}
              value={scopeSelectValue}
              onValueChange={value => {
                if (value === 'all' || value === 'global') setAuditScope({ kind: value })
                else if (value.startsWith('project:')) setAuditScope({ kind: 'project', projectId: value.slice('project:'.length) })
              }}>
              <SelectTrigger id="dream-audit-scope" className="w-full" aria-label={t('dream.auditScopeLabel')}>
                <SelectValue>{auditScope.kind === 'project' && !auditProjects.some(project => project.id === auditScope.projectId)
                  ? describeAuditScope(t, auditScope) : undefined}</SelectValue>
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectGroup>
                  <SelectItem value="all">{t('dream.auditScopeAll')}</SelectItem>
                  <SelectItem value="global">{t('dream.auditScopeGlobal')}</SelectItem>
                </SelectGroup>
                {auditProjects.length ? <SelectGroup>
                  <SelectLabel>{t('dream.projectMemory')}</SelectLabel>
                  {auditProjects.map(project => (
                    <SelectItem key={project.id} value={`project:${project.id}`}>
                      {project.name ? `${project.name} (${project.id.slice(0, 8)})` : project.id.slice(0, 8)}
                    </SelectItem>
                  ))}
                </SelectGroup> : null}
              </SelectContent>
            </Select>
            {auditProjectsError ? <p role="alert" className="text-xs text-destructive">{auditProjectsError}</p> : null}
            {!auditProjectsBusy && !auditProjectsError && !auditProjects.length ? <FieldDescription>{t('dream.auditNoProjects')}</FieldDescription> : null}
            <FieldDescription>{t('dream.auditScopeHint')}</FieldDescription>
          </Field>
          <FieldDescription>{t('dream.auditHint')}</FieldDescription>
          <FieldDescription>{t('dream.budgetHint')}</FieldDescription>
        </FieldGroup> : composing ? <FieldGroup>
          <Field>
            <FieldLabel htmlFor="dream-topic">{t('dream.topic')}</FieldLabel>
            <Textarea id="dream-topic" value={draft} maxLength={2000} disabled={busy} placeholder={t('dream.topicPlaceholder')}
              className={cn('max-h-40 min-h-24 resize-none', hideScroll)} onChange={event => setDraft(event.target.value)} />
            <FieldDescription>{t('dream.topicHint')}</FieldDescription>
          </Field>
          <FieldDescription>{t('dream.budgetHint')}</FieldDescription>
        </FieldGroup> : status && status.state !== 'idle' ? <>
          {status.repair
            ? <p className="text-sm text-muted-foreground">{t('longTerm.repairHint')}</p>
            : status.audit
              ? <Alert className="items-center gap-y-0" data-dream-topic><Stethoscope className="row-span-1! translate-y-0!" /><AlertTitle className="break-words whitespace-pre-wrap">{describeAuditScope(t, status.auditScope, selectedAuditProjectName)}</AlertTitle></Alert>
              : <Alert className="items-center gap-y-0" data-dream-topic><Target className="row-span-1! translate-y-0!" /><AlertTitle className="break-words whitespace-pre-wrap">{status.topic}</AlertTitle></Alert>}
          {running ? <Alert role="status"><Moon /><AlertTitle>{t('dream.backgroundTitle')}</AlertTitle><AlertDescription>{t('dream.backgroundHint')}</AlertDescription></Alert> : null}
          {running && status.wrappingUp ? <Alert role="status"><Moon /><AlertTitle>{t('dream.wrappingUp')}</AlertTitle><AlertDescription>{t('dream.wrapUpHint')}</AlertDescription></Alert> : null}
          {stopped ? <p className="text-sm text-muted-foreground">{t(status.changes.length === 0
            ? 'dream.stoppedWithoutChanges'
            : status.audit ? 'dream.auditStoppedAfterPublish' : 'dream.cancelledHint')}</p> : null}
          {!stopped && status.error ? <Alert variant={status.budgetStop ? 'default' : 'destructive'}><CircleAlert /><AlertTitle>{status.budgetStop ? t(status.budgetStop.kind === 'tokens' ? 'dream.tokenLimitReached' : 'dream.costLimitReached', { used: status.budgetStop.used.toLocaleString(), limit: status.budgetStop.limit.toLocaleString() }) : status.error}</AlertTitle><AlertDescription>{t(status.audit && (status.error === 'DREAM_AUDIT_STATE' || Boolean(status.report) || status.changes.length > 0) ? 'dream.auditStateFailureHint' : 'dream.failureHint')}</AlertDescription></Alert> : null}
          {status.report ? <><Separator /><section aria-label={t('dream.report')} className="flex flex-col gap-3">
            <h3 className="text-xs font-medium text-muted-foreground">{t('dream.report')}</h3>
            <MarkdownText text={status.report} className="text-sm leading-relaxed" />
          </section></> : !running && !stopped && !status.error ? <p className="text-sm text-muted-foreground">{t('dream.noReport')}</p> : null}
          {!running && (!stopped || status.changes.length > 0) ? <><Separator />{status.changes.length ? <DreamChanges paths={status.changes} /> : <p className="text-xs text-muted-foreground">{t('dream.noChanges')}</p>}</> : null}
        </> : null}
      </div>
      {composing || (!status?.repair && !recordId) ? <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t(running ? 'dream.closeRunning' : 'dream.close')}</Button>
        {running ? <Button variant="destructive" disabled={busy} onClick={() => void stop()}><Square data-icon="inline-start" />{t('dream.stop')}</Button> : null}
        {!composing && !running ? (status?.audit
          ? <Button disabled={!enabled || busy} onClick={() => newAudit(status.auditScope)}>{t('dream.auditAgain')}</Button>
          : <Button disabled={!enabled || busy} onClick={newTopic}>{t('dream.newTopic')}</Button>) : null}
        {composing ? (isAuditCompose
          ? <Button disabled={busy || !status || !enabled || (auditScope.kind === 'project' && !auditScope.projectId)} onClick={() => void startAudit()}>{t('dream.auditStart')}</Button>
          : <Button disabled={busy || !status || !enabled || !draft.trim()} onClick={() => void start()}>{t('dream.start')}</Button>) : null}
      </DialogFooter> : null}
    </DialogContent>
  </Dialog>
}
