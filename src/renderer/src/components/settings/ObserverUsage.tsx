/* The only UI entry for mood observer token records: a 7-day summary row and a read-only details dialog. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import {
  PERSONA_OBSERVER_OUTCOMES, type PersonaObserverUsageRange, type PersonaObserverUsageSummary, type PersonaObserverUsageTotals,
} from '../../../../shared/persona'
import { useT } from '../../hooks/useT'
import { api } from '../../ipc/api'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '../ui/alert-dialog'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '../ui/dialog'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SettingsRow } from './SettingsFields'

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const message = (failure: unknown) => failure instanceof Error ? failure.message : String(failure)
const prompt = (totals: PersonaObserverUsageTotals) => totals.input + totals.cacheRead + totals.cacheWrite

const formatUsage = {
  tokens: (totals: PersonaObserverUsageTotals) => compact.format(prompt(totals) + totals.output),
  cost: (cost: number) => cost === 0 ? '$0' : `$${cost.toFixed(cost < 1 ? 4 : 2)}`,
  cache: (totals: PersonaObserverUsageTotals) => prompt(totals) ? `${Math.round(totals.cacheRead / prompt(totals) * 100)}%` : '—',
  estimate: (totals: PersonaObserverUsageTotals) => prompt(totals) ? `${(totals.estimatedInput / prompt(totals)).toFixed(2)}×` : '—',
  average: (value: number, count: number) => count ? compact.format(value / count) : '—',
  duration: (totals: PersonaObserverUsageTotals) => totals.requests ? `${(totals.durationMs / totals.requests / 1000).toFixed(1)}s` : '—',
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="flex flex-col gap-0.5">
    <span className="text-xs text-muted-foreground">{label}</span>
    <span className="text-sm tabular-nums">{value}</span>
  </div>
}

function Totals({ totals }: { totals: PersonaObserverUsageTotals }) {
  const t = useT()
  return <div className="grid grid-cols-4 gap-x-4 gap-y-2">
    <Stat label={t('persona.usageRequests')} value={String(totals.requests)} />
    <Stat label={t('persona.usageTokens')} value={formatUsage.tokens(totals)} />
    <Stat label={t('persona.usageCost')} value={formatUsage.cost(totals.cost)} />
    <Stat label={t('persona.usageCache')} value={formatUsage.cache(totals)} />
    <Stat label={t('persona.usageAvgInput')} value={formatUsage.average(prompt(totals), totals.measured)} />
    <Stat label={t('persona.usageAvgOutput')} value={formatUsage.average(totals.output, totals.measured)} />
    <Stat label={t('persona.usageReasoning')} value={compact.format(totals.reasoning)} />
    <Stat label={t('persona.usageDuration')} value={formatUsage.duration(totals)} />
    <Stat label={t('persona.usageEstimate')} value={formatUsage.estimate(totals)} />
  </div>
}

function UsageDialog({ onCleared }: { onCleared(): void }) {
  const t = useT()
  const [range, setRange] = useState<PersonaObserverUsageRange>(7)
  const [summary, setSummary] = useState<PersonaObserverUsageSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const latest = useRef(0)
  // Only the newest request may apply, so a slow earlier range cannot replace the selected one.
  const load = useCallback((next: PersonaObserverUsageRange) => {
    const request = ++latest.current
    setLoading(true)
    setError(null)
    void api.persona.observerUsage(next).then((value) => {
      if (request === latest.current) setSummary(value)
    }, (failure) => {
      if (request === latest.current) setError(message(failure))
    }).finally(() => {
      if (request === latest.current) setLoading(false)
    })
  }, [])
  useEffect(() => { load(range) }, [load, range])
  const clear = () => void api.persona.clearObserverUsage().then(() => { onCleared(); load(range) }, (failure) => setError(message(failure)))

  return <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
    <DialogHeader>
      <DialogTitle>{t('persona.usageTitle')}</DialogTitle>
      <DialogDescription>{t('persona.usageDescription')}</DialogDescription>
    </DialogHeader>
    <div className="flex items-center gap-2">
      <Select value={String(range)} onValueChange={(value) => setRange(value === 'all' ? 'all' : Number(value) as 7 | 30)}>
        <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
        <SelectContent position="popper"><SelectGroup>
          <SelectItem value="7">{t('persona.usageRange7')}</SelectItem>
          <SelectItem value="30">{t('persona.usageRange30')}</SelectItem>
          <SelectItem value="all">{t('persona.usageRangeAll')}</SelectItem>
        </SelectGroup></SelectContent>
      </Select>
      <Button size="icon-sm" variant="ghost" aria-label={t('persona.usageRefresh')} disabled={loading} onClick={() => load(range)}><RefreshCw /></Button>
    </div>
    {error && <p className="text-sm text-destructive">{t('persona.usageError', { error })}</p>}
    {summary && <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
      <Totals totals={summary.totals} />
      {summary.totals.requests > summary.totals.measured && <p className="text-xs text-muted-foreground">
        {t('persona.usageUnmeasured', { count: summary.totals.requests - summary.totals.measured })}
      </p>}
      <section className="flex flex-col gap-2">
        <h3 className="text-xs text-muted-foreground">{t('persona.usageOutcomes')}</h3>
        <div className="flex flex-wrap gap-1.5">
          {PERSONA_OBSERVER_OUTCOMES.map((outcome) => <Badge key={outcome} variant="secondary" className="tabular-nums">
            {t(`persona.usageOutcome.${outcome}`)} {summary.outcomes[outcome]}
          </Badge>)}
        </div>
      </section>
      {summary.models.length > 0 && <section className="flex flex-col gap-2">
        <h3 className="text-xs text-muted-foreground">{t('persona.usageModels')}</h3>
        {summary.models.map((model) => <div key={`${model.provider}/${model.modelId}/${model.inherited}/${model.thinking}`} className="flex flex-col gap-2 rounded-lg border p-3">
          <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
            <span className="truncate">{model.provider}/{model.modelId}</span>
            <Badge variant="outline">{model.thinking}</Badge>
            {model.inherited && <Badge variant="outline">{t('persona.usageInherited')}</Badge>}
          </div>
          <Totals totals={model} />
        </div>)}
      </section>}
    </div>}
    <DialogFooter>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button size="sm" variant="outline" disabled={!summary?.totals.requests && range === 'all'}>{t('persona.usageClear')}</Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('persona.usageClearTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('persona.usageClearHint')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('persona.usageCancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={clear}>{t('persona.usageClear')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DialogFooter>
  </DialogContent>
}

export function ObserverUsageRow() {
  const t = useT()
  const [summary, setSummary] = useState<PersonaObserverUsageSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const load = useCallback(() => {
    void api.persona.observerUsage(7).then((next) => { setSummary(next); setError(null) }, (failure) => setError(message(failure)))
  }, [])
  // Closing the dialog rereads, so a clear or newer records reach the summary row.
  useEffect(() => { if (!open) load() }, [open, load])

  const totals = summary?.totals
  const description = error ? t('persona.usageError', { error })
    : !totals?.requests ? t('persona.usageNone')
    : t('persona.usageSummary', {
      requests: totals.requests, tokens: formatUsage.tokens(totals), cost: formatUsage.cost(totals.cost), cache: formatUsage.cache(totals),
    })
  return <SettingsRow title={t('persona.usage')} description={description}>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="outline">{t('persona.usageDetails')}</Button></DialogTrigger>
      {open && <UsageDialog onCleared={load} />}
    </Dialog>
  </SettingsRow>
}
